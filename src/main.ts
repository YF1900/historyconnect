import 'leaflet/dist/leaflet.css';
import './styles.css';
import L from 'leaflet';
import { EVENTS, PEOPLE, PLACES, SOURCES } from './data';
import type { Claim, ClaimType, Place } from './types';
import { add, clear, extLink, h } from './dom';
import { distanceKm, formatKm, getCurrentPosition } from './geo';
import { clearAllLocalData, loadSaved, storeSaved } from './storage';

/* ---------------- データの索引 ---------------- */

const places = PLACES;
// 座標が確認できていない施設は地図に置かない（推測で配置しない）。一覧には表示する
const hasCoord = (p: Place) => Number.isFinite(p.lat) && Number.isFinite(p.lng);
const placeById = new Map(places.map((p) => [p.id, p]));
const personById = new Map(PEOPLE.map((p) => [p.id, p]));
const eventById = new Map(EVENTS.map((e) => [e.id, e]));
const sourceById = new Map(SOURCES.map((s) => [s.id, s]));

const CLAIM_LABEL: Record<ClaimType, string> = { fact: '史実', theory: '説', legend: '伝承' };
const CLAIM_HELP: Record<ClaimType, string> = {
  fact: '出典で事実として示されている内容',
  theory: '時期や経緯について、説として示されている内容',
  legend: '「〜と言われる」など、言い伝えとして示されている内容',
};
const KIND_LABEL = { castle: '城・城跡', museum: '博物館・資料館' } as const;

function peopleOf(place: Place): string[] {
  return [...new Set(place.claims.flatMap((c) => c.people ?? []))];
}
function eventsOf(place: Place): string[] {
  return [...new Set(place.claims.flatMap((c) => c.events ?? []))];
}
function placesWithPerson(personId: string): Place[] {
  return places.filter((p) => peopleOf(p).includes(personId));
}
/** 人物・出来事を共有している別の場所 */
function connectedPlaces(place: Place): { place: Place; via: string[] }[] {
  const myPeople = new Set(peopleOf(place));
  const myEvents = new Set(eventsOf(place));
  const out: { place: Place; via: string[] }[] = [];
  for (const other of places) {
    if (other.id === place.id) continue;
    const via: string[] = [];
    for (const e of eventsOf(other)) if (myEvents.has(e)) via.push(eventById.get(e)!.name);
    for (const pid of peopleOf(other)) if (myPeople.has(pid)) via.push(personById.get(pid)!.name);
    if (via.length) out.push({ place: other, via });
  }
  return out.sort((a, b) => b.via.length - a.via.length);
}

const CENTURIES = [...new Set(places.flatMap((p) => p.claims.map((c) => c.year)).filter((y): y is number => !!y))]
  .map((y) => Math.floor((y - 1) / 100) + 1)
  .filter((v, i, arr) => arr.indexOf(v) === i)
  .sort((a, b) => a - b);

/* ---------------- 状態 ---------------- */

type Purpose = 'nearby' | 'deep' | 'trip';
type Focus = { kind: 'person' | 'event' | 'century'; id: string } | null;

const state = {
  saved: loadSaved(),
  here: null as { lat: number; lng: number } | null,
  hereStatus: '' as string,
  focus: null as Focus,
  prefecture: '' as string,
};

/* ---------------- 地図 ---------------- */

const app = document.getElementById('app')!;
let map: L.Map | null = null;
let markerLayer: L.LayerGroup | null = null;
let hereLayer: L.LayerGroup | null = null;

function ensureMap(container: HTMLElement): L.Map {
  if (map) {
    container.append(map.getContainer());
    setTimeout(() => map!.invalidateSize(), 0);
    return map;
  }
  const el = h('div', { id: 'map', role: 'region', 'aria-label': '施設の地図' });
  container.append(el);
  map = L.map(el, { zoomControl: true, attributionControl: true }).setView([35.5, 139.4], 9);
  // 地理院タイル（国土地理院）。利用規約に従い出典を表示する
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
    maxZoom: 18,
    minZoom: 5,
    attribution:
      '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>',
    referrerPolicy: 'no-referrer',
  } as L.TileLayerOptions).addTo(map);
  map.attributionControl.setPrefix(
    '<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>',
  );
  markerLayer = L.layerGroup().addTo(map);
  hereLayer = L.layerGroup().addTo(map);
  map.on('moveend', () => {
    if (location.hash.startsWith('#/nearby') && !state.here) updateNearbyList();
  });
  return map;
}

function markerIcon(place: Place, highlighted: boolean): L.DivIcon {
  const symbol = place.kind === 'castle' ? '城' : '館';
  return L.divIcon({
    className: '',
    html: `<span class="pin pin-${place.kind}${highlighted ? ' pin-hl' : ''}" aria-hidden="true">${symbol}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function drawMarkers(highlightIds: Set<string> | null, fit: boolean): void {
  if (!map || !markerLayer) return;
  markerLayer.clearLayers();
  const shown: L.LatLng[] = [];
  for (const p of places) {
    if (!hasCoord(p)) continue;
    const hl = highlightIds ? highlightIds.has(p.id) : false;
    if (highlightIds && !hl) continue;
    const m = L.marker([p.lat, p.lng], {
      icon: markerIcon(p, hl),
      title: p.name,
      alt: `${KIND_LABEL[p.kind]}：${p.name}`,
      keyboard: true,
    });
    m.on('click', () => go(`#/place/${p.id}`));
    m.addTo(markerLayer);
    shown.push(L.latLng(p.lat, p.lng));
  }
  if (state.here && hereLayer) {
    hereLayer.clearLayers();
    L.circleMarker([state.here.lat, state.here.lng], {
      radius: 8,
      color: '#1d4ed8',
      fillColor: '#3b82f6',
      fillOpacity: 0.9,
    })
      .bindTooltip('現在地（端末内でのみ使用）')
      .addTo(hereLayer);
    shown.push(L.latLng(state.here.lat, state.here.lng));
  }
  if (fit && shown.length) {
    map.fitBounds(L.latLngBounds(shown).pad(0.2), { maxZoom: 13 });
  }
}

/* ---------------- 共通パーツ ---------------- */

function header(title: string, showSwitch = true): HTMLElement {
  return h(
    'header',
    { class: 'topbar' },
    h('a', { href: '#/', class: 'brand', 'aria-label': '最初の画面へ' }, 'ヒストリーコネクト'),
    h('span', { class: 'topbar-title' }, title),
    h(
      'nav',
      { class: 'topbar-nav', 'aria-label': 'メニュー' },
      showSwitch ? h('a', { href: '#/', class: 'chip-btn' }, '目的を変える') : null,
      h('a', { href: '#/saved', class: 'chip-btn' }, `行きたい ${state.saved.size}`),
    ),
  );
}

function purposeTabs(active: Purpose): HTMLElement {
  const tab = (p: Purpose, label: string) =>
    h('a', { href: `#/${p}`, class: `tab${p === active ? ' tab-active' : ''}`, 'aria-current': p === active ? 'page' : undefined }, label);
  return h('div', { class: 'tabs', role: 'navigation', 'aria-label': '探し方' }, tab('nearby', '近くを探す'), tab('deep', '人物・時代'), tab('trip', '旅先で'));
}

function placeCard(p: Place, extra?: string): HTMLElement {
  return h(
    'a',
    { href: `#/place/${p.id}`, class: 'card' },
    h('span', { class: `kind kind-${p.kind}` }, KIND_LABEL[p.kind]),
    h('strong', { class: 'card-title' }, p.name),
    h('span', { class: 'card-sub' }, [p.prefecture, extra].filter(Boolean).join('・')),
    p.designations.length ? h('span', { class: 'card-tags' }, p.designations.map((d) => d.label.split('（')[0]).join(' / ')) : null,
  );
}

function sourceLinks(ids: string[]): HTMLElement {
  return h(
    'span',
    { class: 'src' },
    '出典：',
    ...ids.flatMap((id, i) => {
      const s = sourceById.get(id);
      if (!s) return [];
      return [i ? '、' : '', extLink(s.url, `${s.publisher}「${s.title}」`)];
    }),
  );
}

function claimItem(c: Claim, showPlace?: Place): HTMLElement {
  return h(
    'li',
    { class: `claim claim-${c.type}` },
    h('span', { class: `badge badge-${c.type}`, title: CLAIM_HELP[c.type] }, CLAIM_LABEL[c.type]),
    showPlace ? h('a', { href: `#/place/${showPlace.id}`, class: 'claim-place' }, showPlace.name) : null,
    h('p', {}, c.text),
    sourceLinks(c.sourceIds),
  );
}

function legend(): HTMLElement {
  return h(
    'details',
    { class: 'legend' },
    h('summary', {}, '「史実」「説」「伝承」の見方'),
    h(
      'ul',
      {},
      (['fact', 'theory', 'legend'] as ClaimType[]).map((t) =>
        h('li', {}, h('span', { class: `badge badge-${t}` }, CLAIM_LABEL[t]), ` ${CLAIM_HELP[t]}`),
      ),
    ),
    h('p', { class: 'muted' }, 'どの記述にも出典を付けています。解釈が分かれる点は、出典の書き方に合わせて区別しています。'),
  );
}

/* ---------------- 画面：はじめに ---------------- */

function renderStart(): void {
  clear(app);
  const option = (href: string, title: string, desc: string, icon: string) =>
    h('a', { href, class: 'purpose' }, h('span', { class: 'purpose-icon', 'aria-hidden': 'true' }, icon), h('span', {}, h('strong', {}, title), h('small', {}, desc)));
  app.append(
    h(
      'main',
      { class: 'start' },
      h('h1', {}, 'ヒストリーコネクト'),
      h('p', { class: 'lead' }, '好きな人物や時代、行きたい場所から、日本の歴史をたどってみましょう。'),
      h('p', { class: 'theme' }, '試験版テーマ：1590年 豊臣秀吉の小田原攻めと関東の城'),
      h(
        'div',
        { class: 'purposes' },
        option('#/nearby', '近くの施設を探す', '今いる場所や地図の中心から、近い順に並べます', '📍'),
        option('#/deep', '好きな人物・時代を深掘りする', '人物・出来事・年代から、ゆかりの場所をたどります', '🔎'),
        option('#/trip', '旅先で歴史に触れる', '行き先の都県を選んで、立ち寄れる場所を探します', '🧳'),
      ),
      h('p', { class: 'start-foot' }, h('a', { href: '#/about' }, 'このアプリについて・プライバシー・出典')),
    ),
  );
}

/* ---------------- 画面：探索（地図＋パネル） ---------------- */

function exploreShell(purpose: Purpose, title: string): { panel: HTMLElement } {
  clear(app);
  const mapWrap = h('div', { class: 'map-wrap' });
  const panel = h('section', { class: 'panel', 'aria-live': 'polite' });
  app.append(header(title), purposeTabs(purpose), h('main', { class: 'explore' }, mapWrap, panel));
  ensureMap(mapWrap);
  return { panel };
}

function renderNearby(): void {
  const { panel } = exploreShell('nearby', '近くを探す');

  const locateBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      onclick: async () => {
        state.hereStatus = '現在地を確認しています…';
        renderNearby();
        try {
          state.here = await getCurrentPosition();
          state.hereStatus = '';
        } catch (e) {
          state.hereStatus = (e as Error).message;
        }
        renderNearby();
        drawMarkers(null, true);
      },
    },
    state.here ? '現在地を更新' : '現在地を使う',
  );
  const centerBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost',
      onclick: () => {
        state.here = null;
        hereLayer?.clearLayers();
        renderNearby();
      },
    },
    '地図の中心から並べる',
  );

  add(panel, 
    h('div', { class: 'row' }, locateBtn, centerBtn),
    h('p', { class: 'note' }, '現在地はこの端末の中だけで距離の計算に使います。どこにも送信・保存しません。'),
    state.hereStatus ? h('p', { class: 'status' }, state.hereStatus) : null,
    nearbyList,
  );
  updateNearbyList();
  drawMarkers(null, false);
}

const nearbyList = h('div', {});
function updateNearbyList(): void {
  clear(nearbyList);
  const c = map?.getCenter();
  const origin = state.here ?? (c ? { lat: c.lat, lng: c.lng } : { lat: 35.5, lng: 139.4 });
  const sorted = places
    .filter(hasCoord)
    .map((p) => ({ p, d: distanceKm(origin.lat, origin.lng, p.lat, p.lng) }))
    .sort((a, b) => a.d - b.d);
  const pending = places.filter((p) => !hasCoord(p));
  add(nearbyList, 
    h('h2', {}, state.here ? '現在地から近い順' : '地図の中心から近い順'),
    state.here ? null : h('p', { class: 'note' }, '地図を動かすと、並び順が変わります。'),
    h('div', { class: 'cards' }, sorted.map(({ p, d }) => placeCard(p, `直線距離${formatKm(d)}`))),
    pending.length
      ? h(
          'div',
          {},
          h('h3', {}, '地図上の位置を確認中の施設'),
          h('p', { class: 'note' }, '所在地は公式情報で確認済みですが、地図上の位置をまだ確認できていないため、距離の計算から外しています。'),
          h('div', { class: 'cards' }, pending.map((p) => placeCard(p))),
        )
      : null,
  );
}

function renderDeep(): void {
  const { panel } = exploreShell('deep', '人物・時代を深掘り');
  const f = state.focus;
  const chip = (kind: 'person' | 'event' | 'century', id: string, label: string) =>
    h(
      'button',
      {
        type: 'button',
        class: `chip${f && f.kind === kind && f.id === id ? ' chip-on' : ''}`,
        'aria-pressed': f && f.kind === kind && f.id === id ? 'true' : 'false',
        onclick: () => {
          state.focus = f && f.kind === kind && f.id === id ? null : { kind, id };
          renderDeep();
        },
      },
      label,
    );

  const peopleSorted = [...PEOPLE].filter((p) => placesWithPerson(p.id).length).sort((a, b) => placesWithPerson(b.id).length - placesWithPerson(a.id).length);

  add(panel, 
    h('h2', {}, '出来事から'),
    h('div', { class: 'chips' }, EVENTS.map((e) => chip('event', e.id, `${e.name}（${e.year}）`))),
    h('h2', {}, '人物から'),
    h('div', { class: 'chips' }, peopleSorted.map((p) => chip('person', p.id, p.name))),
    h('h2', {}, '年代から'),
    h('div', { class: 'chips' }, CENTURIES.map((c) => chip('century', String(c), `${c}世紀`))),
  );

  if (!f) {
    add(panel, h('p', { class: 'note' }, '気になるものを選ぶと、ゆかりの場所と関連する記述を年代順に表示します。'));
    drawMarkers(null, true);
    return;
  }

  // 該当する記述を集めて年代順に並べる
  const matches: { c: Claim; p: Place }[] = [];
  for (const p of places) {
    for (const c of p.claims) {
      const hit =
        f.kind === 'person'
          ? c.people?.includes(f.id)
          : f.kind === 'event'
            ? c.events?.includes(f.id)
            : c.year !== undefined && Math.floor((c.year - 1) / 100) + 1 === Number(f.id);
      if (hit) matches.push({ c, p });
    }
  }
  matches.sort((a, b) => (a.c.year ?? 9999) - (b.c.year ?? 9999));
  const related = [...new Set(matches.map((m) => m.p))];
  const ids = new Set(related.map((p) => p.id));

  const focusBox = h('div', { class: 'focus' });
  if (f.kind === 'person') {
    const person = personById.get(f.id)!;
    add(focusBox, 
      h('h2', {}, `${person.name}（${person.kana}）`),
      person.note ? h('p', {}, person.note.text, ' ', sourceLinks([person.note.sourceId])) : null,
    );
  } else if (f.kind === 'event') {
    const ev = eventById.get(f.id)!;
    add(focusBox, h('h2', {}, `${ev.name}（${ev.year}年）`), h('p', {}, ev.summary), sourceLinks(ev.sourceIds));
  } else {
    const c = Number(f.id);
    add(focusBox, h('h2', {}, `${c}世紀（${(c - 1) * 100 + 1}〜${c * 100}年）`));
  }

  add(panel, 
    focusBox,
    h('h3', {}, `ゆかりの場所（${related.length}件）`),
    h('div', { class: 'cards' }, related.map((p) => placeCard(p))),
    h('h3', {}, '年代順にたどる'),
    legend(),
    h('ol', { class: 'claims timeline' }, matches.map((m) => claimItem(m.c, m.p))),
  );
  drawMarkers(ids, true);
}

function renderTrip(): void {
  const { panel } = exploreShell('trip', '旅先で歴史に触れる');
  const prefs = [...new Set(places.map((p) => p.prefecture))];
  add(panel, 
    h('h2', {}, '行き先を選ぶ'),
    h(
      'div',
      { class: 'chips' },
      prefs.map((pref) =>
        h(
          'button',
          {
            type: 'button',
            class: `chip${state.prefecture === pref ? ' chip-on' : ''}`,
            'aria-pressed': state.prefecture === pref ? 'true' : 'false',
            onclick: () => {
              state.prefecture = state.prefecture === pref ? '' : pref;
              renderTrip();
            },
          },
          pref,
        ),
      ),
    ),
    h('p', { class: 'note' }, '試験版のため、東京都・神奈川県・埼玉県の一部の施設のみ収録しています。'),
  );
  if (!state.prefecture) {
    drawMarkers(null, true);
    return;
  }
  const here = places.filter((p) => p.prefecture === state.prefecture);
  const hereIds = new Set(here.map((p) => p.id));
  const beyond = new Map<string, { place: Place; via: Set<string> }>();
  for (const p of here) {
    for (const c of connectedPlaces(p)) {
      if (hereIds.has(c.place.id)) continue;
      const cur = beyond.get(c.place.id) ?? { place: c.place, via: new Set<string>() };
      c.via.forEach((v) => cur.via.add(v));
      beyond.set(c.place.id, cur);
    }
  }
  add(panel, 
    h('h2', {}, `${state.prefecture}で訪ねられる場所`),
    h('div', { class: 'cards' }, here.map((p) => placeCard(p))),
    beyond.size
      ? h(
          'div',
          {},
          h('h3', {}, '旅のあとに：つながりのある他県の場所'),
          h(
            'div',
            { class: 'cards' },
            [...beyond.values()].map((b) => placeCard(b.place, `つながり：${[...b.via].join('、')}`)),
          ),
        )
      : null,
  );
  drawMarkers(hereIds, true);
}

/* ---------------- 画面：施設の詳細 ---------------- */

function renderPlace(id: string): void {
  const p = placeById.get(id);
  if (!p) {
    go('#/');
    return;
  }
  clear(app);
  const saved = state.saved.has(p.id);
  const saveBtn = h(
    'button',
    {
      type: 'button',
      class: `btn${saved ? ' btn-ghost' : ''}`,
      'aria-pressed': saved ? 'true' : 'false',
      onclick: () => {
        if (state.saved.has(p.id)) state.saved.delete(p.id);
        else state.saved.add(p.id);
        storeSaved(state.saved);
        renderPlace(p.id);
      },
    },
    saved ? '★ 行きたい に登録済み' : '☆ 行きたい に追加',
  );

  const people = peopleOf(p).map((pid) => personById.get(pid)!);
  const conn = connectedPlaces(p);

  app.append(
    header(KIND_LABEL[p.kind]),
    h(
      'main',
      { class: 'detail' },
      h('button', { type: 'button', class: 'back', onclick: () => history.back() }, '← もどる'),
      h('span', { class: `kind kind-${p.kind}` }, KIND_LABEL[p.kind]),
      h('h1', {}, p.name),
      h('p', { class: 'kana' }, p.kana),
      p.designations.length
        ? h('ul', { class: 'tags' }, p.designations.map((d) => h('li', {}, d.label, ' ', sourceLinks([d.sourceId]))))
        : null,
      h('div', { class: 'row' }, saveBtn, p.officialUrl ? extLink(p.officialUrl, '公式情報を見る ↗', 'btn btn-ghost') : null),

      h('h2', {}, '歴史'),
      legend(),
      h('ol', { class: 'claims' }, [...p.claims].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999)).map((c) => claimItem(c))),

      people.length
        ? h(
            'section',
            {},
            h('h2', {}, 'ゆかりの人物'),
            h(
              'div',
              { class: 'chips' },
              people.map((person) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'chip',
                    onclick: () => {
                      state.focus = { kind: 'person', id: person.id };
                      go('#/deep');
                    },
                  },
                  person.name,
                ),
              ),
            ),
          )
        : null,

      conn.length
        ? h(
            'section',
            {},
            h('h2', {}, 'つながりのある場所'),
            h('p', { class: 'note' }, '同じ人物や出来事が登場する場所です。'),
            h('div', { class: 'cards' }, conn.map((c) => placeCard(c.place, `つながり：${c.via.join('、')}`))),
          )
        : null,

      h(
        'section',
        { class: 'visit' },
        h('h2', {}, '訪れる前に'),
        h('dl', {}, h('dt', {}, '所在地'), h('dd', {}, p.address, ' ', sourceLinks([p.addressSourceId]))),
        p.visit?.map((v) => {
          const s = sourceById.get(v.sourceId);
          return h('p', {}, v.text, ' ', sourceLinks([v.sourceId]), s?.pageDate ? h('span', { class: 'muted' }, `（${s.pageDate}）`) : null);
        }),
        h(
          'p',
          { class: 'warn' },
          `開館時間・料金・休館日などは変わることがあります。お出かけ前に必ず公式情報で確認してください。（このアプリの確認日：${sourceById.get(p.addressSourceId)?.checked ?? '—'}）`,
        ),
        h('p', { class: 'muted' }, hasCoord(p) ? `地図上の位置：${p.coordNote}` : '地図上の位置：確認中のため、地図には表示していません。'),
      ),
    ),
  );
  window.scrollTo(0, 0);
}

/* ---------------- 画面：行きたい場所 ---------------- */

function renderSaved(): void {
  clear(app);
  const list = [...state.saved].map((id) => placeById.get(id)).filter((p): p is Place => !!p);
  app.append(
    header('行きたい場所'),
    h(
      'main',
      { class: 'detail' },
      h('h1', {}, '行きたい場所'),
      h('p', { class: 'note' }, 'この一覧は、お使いの端末のブラウザ内にだけ保存されています。'),
      list.length ? h('div', { class: 'cards' }, list.map((p) => placeCard(p))) : h('p', {}, 'まだ登録がありません。施設の詳細画面から追加できます。'),
    ),
  );
}

/* ---------------- 画面：このアプリについて ---------------- */

function renderAbout(): void {
  clear(app);
  const sourcesList = h(
    'ul',
    { class: 'sources' },
    SOURCES.map((s) => h('li', {}, extLink(s.url, `${s.publisher}「${s.title}」`), h('span', { class: 'muted' }, ` 確認日 ${s.checked}${s.pageDate ? `／${s.pageDate}` : ''}`))),
  );
  app.append(
    header('このアプリについて', false),
    h(
      'main',
      { class: 'detail about' },
      h('h1', {}, 'このアプリについて'),
      h('p', {}, 'ヒストリーコネクトは、人物・出来事・年代・場所を手がかりに、日本の歴史と関連する施設を探せるWebアプリです。現在は試験版で、収録している施設はごく一部です。'),

      h('h2', {}, '情報の正確性について'),
      h('ul', {}, [
        h('li', {}, 'すべての記述に出典を付け、出典に書かれている範囲で記載しています。'),
        h('li', {}, '「史実」「説」「伝承」を区別して表示しています。'),
        h('li', {}, '開館時間・料金などは変わることがあるため、掲載日を示しています。お出かけ前に公式情報を確認してください。'),
        h('li', {}, '地図上の位置は、公式情報で確認した住所を国土地理院の住所検索で変換したものです。広い城跡などでは代表点になっています。'),
      ]),

      h('h2', { id: 'privacy' }, 'プライバシーポリシー（個人情報の取り扱い）'),
      h('p', {}, 'このアプリはログインや会員登録がなく、運営者のサーバーで利用者の個人情報を収集・保存しません。'),
      h('h3', {}, '1. 現在地（位置情報）'),
      h('p', {}, '「現在地を使う」を押し、ブラウザで許可したときだけ取得します。取得した位置は、この端末の中で施設までの距離を計算するためだけに使い、どこにも送信・保存しません。ページを閉じると破棄されます。'),
      h('h3', {}, '2. 端末内に保存する情報'),
      h('p', {}, '「行きたい」に登録した施設の一覧だけを、お使いのブラウザの保存領域（localStorage）に保存します。この情報は外部に送信されません。Cookie、アクセス解析、広告の仕組みは使っていません。'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost',
          onclick: () => {
            clearAllLocalData();
            state.saved = new Set();
            state.here = null;
            alertInline('この端末に保存されたデータを消去しました。');
          },
        },
        'この端末の保存データを消去する',
      ),
      h('p', { id: 'inline-msg', class: 'status', role: 'status' }),
      h('h3', {}, '3. 外部への情報送信（電気通信事業法の外部送信規律に基づく公表）'),
      h('p', {}, 'このアプリを表示すると、次の外部サービスに利用者の端末から情報が送信されます。'),
      h(
        'table',
        { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, '送信先'), h('th', {}, '送信される情報'), h('th', {}, '目的'))),
        h(
          'tbody',
          {},
          h(
            'tr',
            {},
            h('td', {}, '国土地理院（地理院タイル）'),
            h('td', {}, 'IPアドレス、ブラウザの種類などの通信情報、表示している地図の範囲（タイルの番号）'),
            h('td', {}, '地図画像を表示するため'),
          ),
          h(
            'tr',
            {},
            h('td', {}, 'GitHub, Inc.（GitHub Pages：このサイトの配信）'),
            h('td', {}, 'IPアドレス、ブラウザの種類などの通信情報'),
            h('td', {}, 'このWebサイトを配信するため'),
          ),
        ),
      ),
      h('p', {}, '参照元のURL（リファラー）は外部に送らない設定にしています。各送信先での取り扱いは、それぞれの方針をご確認ください：', extLink('https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html', '国土地理院コンテンツ利用規約'), '、', extLink('https://docs.github.com/ja/site-policy/privacy-policies/github-general-privacy-statement', 'GitHub一般プライバシーステートメント'), '。'),
      h('h3', {}, '4. EU・英国などからのご利用（GDPR）'),
      h('p', {}, '運営者は利用者の個人データを収集しません。位置情報は端末内でのみ処理されます。地図の表示と配信のための通信は、上記の各送信先によって処理されます。'),
      h('h3', {}, '5. お問い合わせ・改定'),
      h('p', {}, '運営者：', h('strong', {}, '（公開前に運営者名と連絡先を記入してください）')),
      h('p', { class: 'muted' }, '制定日：2026年11月1日'),

      h('h2', {}, '地図・ソフトウェア'),
      h('p', {}, '地図：', extLink('https://maps.gsi.go.jp/development/ichiran.html', '地理院タイル（国土地理院）'), '／地図表示：', extLink('https://leafletjs.com', 'Leaflet'), '（BSD-2-Clauseライセンス）'),

      h('h2', {}, '出典一覧'),
      sourcesList,
    ),
  );
}

function alertInline(msg: string): void {
  const el = document.getElementById('inline-msg');
  if (el) el.textContent = msg;
}

/* ---------------- ルーティング ---------------- */

function go(hash: string): void {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route(): void {
  const hash = location.hash || '#/';
  const [, view, arg] = hash.split('/');
  switch (view) {
    case 'nearby':
      return renderNearby();
    case 'deep':
      return renderDeep();
    case 'trip':
      return renderTrip();
    case 'place':
      return renderPlace(decodeURIComponent(arg ?? ''));
    case 'saved':
      return renderSaved();
    case 'about':
      return renderAbout();
    default:
      return renderStart();
  }
}

window.addEventListener('hashchange', route);
route();

/* ---------------- PWA（オフライン用のアプリ本体キャッシュ） ---------------- */

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // 登録できなくてもアプリは通常どおり使える
    });
  });
}
