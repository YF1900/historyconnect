import 'leaflet/dist/leaflet.css';
import './styles.css';
import L from 'leaflet';
import { EVENTS, PEOPLE, PLACES, SOURCES } from './data';
import type { Claim, ClaimType, Person, Place } from './types';
import { add, clear, extLink, h } from './dom';
import { distanceKm, formatKm, watchPosition } from './geo';
import { clearAllLocalData, loadSaved, storeSaved } from './storage';
import { EXAMPLES, search, searchLibrary } from './search';
import {
  PE_DEFAULT_ROLE,
  PS_CLASS,
  eventStatus,
  getLibrary,
  loadLibrary,
  personName,
  wikiUrl,
  type LibEvent,
  type LibSpot,
  type Library,
  type LibCastle,
  castleSeries,
  CASTLE_LIST_URL,
} from './lib';
import {
  MEMO_MAX,
  clearStamps,
  exportStamps,
  importStamps,
  loadStamps,
  processPhoto,
  removeOfficial,
  removePersonal,
  setOfficial,
  setOfficialDate,
  setPersonal,
  stampsLoaded,
  today,
} from './stamps';

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
  query: '' as string,
  tracking: false,
  acc: 0,
  selected: '' as string,
  stampFilter: { pref: '', genre: '', status: 'all' as 'all' | 'todo' | 'done' },
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

/**
 * 全国データのスポットのうち、公的資料で座標を照合したものだけを地図に置く。
 * 試験運用の施設と同じ対象（place あり）は施設のピンを使うので重ねて置かない。
 */
function spotHasCoord(s: LibSpot): boolean {
  return typeof s.lat === 'number' && typeof s.lng === 'number';
}
function drawSpotMarkers(spots: LibSpot[], shown: L.LatLng[]): void {
  if (!markerLayer) return;
  for (const s of spots) {
    if (!spotHasCoord(s) || s.place) continue;
    const m = L.marker([s.lat!, s.lng!], {
      icon: L.divIcon({ className: '', html: '<span class="pin pin-spot" aria-hidden="true">史</span>', iconSize: [34, 34], iconAnchor: [17, 17] }),
      title: s.t,
      alt: `歴史スポット：${s.t}`,
      keyboard: true,
    });
    m.on('click', () => go(`#/spot/${s.id}`));
    m.addTo(markerLayer);
    shown.push(L.latLng(s.lat!, s.lng!));
  }
}

function drawMarkers(highlightIds: Set<string> | null, fit: boolean, spots: LibSpot[] = []): void {
  if (!map || !markerLayer) return;
  markerLayer.clearLayers();
  const shown: L.LatLng[] = [];
  drawSpotMarkers(spots, shown);
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
      h('a', { href: '#/search', class: 'chip-btn', 'aria-label': '検索' }, '検索'),
      showSwitch ? h('a', { href: '#/', class: 'chip-btn', 'aria-label': '目的を変える' }, '目的') : null,
      h('a', { href: '#/saved', class: 'chip-btn', 'aria-label': `行きたい場所 ${state.saved.size}件` }, `★ ${state.saved.size}`),
    ),
  );
}

function purposeTabs(active: Purpose | 'themes'): HTMLElement {
  const tab = (p: Purpose | 'themes', label: string) =>
    h('a', { href: `#/${p}`, class: `tab${p === active ? ' tab-active' : ''}`, 'aria-current': p === active ? 'page' : undefined }, label);
  return h(
    'div',
    { class: 'tabs', role: 'navigation', 'aria-label': '探し方' },
    tab('nearby', '地図'),
    tab('deep', '人物・時代'),
    tab('trip', '旅先'),
    tab('themes', 'テーマ'),
  );
}

/* ---------------- 全国データ用の共通パーツ ---------------- */

/** 全国データが必要な画面：未読み込みなら読み込んでから描き直す */
function needLibrary(container: HTMLElement): Library | null {
  const l = getLibrary();
  if (l) return l;
  const hash = location.hash;
  add(container, h('p', { class: 'status', role: 'status' }, '全国の歴史データを読み込んでいます…'));
  loadLibrary()
    .then(() => {
      if (location.hash === hash) route();
    })
    .catch(() => {
      clear(container);
      add(container, h('p', { class: 'warn' }, '歴史データを読み込めませんでした。通信状態を確認して、もう一度開いてください。'));
    });
  return null;
}

function statusBadge(cls: string, label: string, help?: string): HTMLElement {
  return h('span', { class: `st ${cls}`, title: help }, label);
}

function spotCard(s: LibSpot, extra?: string): HTMLElement {
  return h(
    'a',
    { href: `#/spot/${s.id}`, class: 'card' },
    h('span', { class: 'kind kind-spot' }, '歴史スポット'),
    h('strong', { class: 'card-title' }, s.t),
    h('span', { class: 'card-sub' }, [`${s.pref} ${s.city}`, s.kind, extra].filter(Boolean).join('・')),
    h('span', { class: 'card-tags' }, spotHasCoord(s) ? '地図：位置照合済み' : '地図：位置を照合中'),
  );
}

function eventCard(e: LibEvent, extra?: string): HTMLElement {
  return h(
    'a',
    { href: `#/event/${e.id}`, class: 'card' },
    h('span', { class: 'kind kind-event' }, '出来事'),
    h('strong', { class: 'card-title' }, `${e.t}（${e.date}）`),
    h('span', { class: 'card-sub' }, extra ?? e.focus),
  );
}

/** 人物ページへのリンク。試験運用データに同じ人物がいればそちらを開く */
function personHref(l: Library, id: string): string {
  return `#/person/${encodeURIComponent(l.pilot[id] ?? id)}`;
}

function refLinks(l: Library, conf: [string, string][]): HTMLElement | null {
  if (!conf.length) return null;
  return h(
    'ul',
    { class: 'refs' },
    conf.map(([rid, scope]) => {
      const r = l.refs[rid];
      return h('li', {}, r ? extLink(r.u, r.t) : rid, h('span', { class: 'muted' }, ` 確認範囲：${scope}`));
    }),
  );
}

function wikiLink(title: string): HTMLElement {
  return h(
    'p',
    { class: 'muted' },
    '参考記事（追加調査用。リンク先の本文は照合していません）：',
    extLink(wikiUrl(title), `Wikipedia「${title}」`),
  );
}

function dataNotice(): HTMLElement {
  return h(
    'details',
    { class: 'legend' },
    h('summary', {}, '全国データの確認状況の見方'),
    h(
      'ul',
      {},
      h('li', {}, statusBadge('st-checked', '確認補助資料あり'), ' 記載した論点を参照資料で確認したもの。全記述の確認済みではありません。'),
      h('li', {}, statusBadge('st-unchecked', '編集整理・未照合'), ' 編集上の要約で、専門家による校閲や個別の史料照合はまだです。'),
      (['A', 'B', 'L', 'H'] as const).map((k) => h('li', {}, statusBadge(`st-${k}`, PS_CLASS[k].label), ` ${PS_CLASS[k].help}`)),
    ),
    h('p', { class: 'muted' }, '出来事・スポットは2026年11月1日版の編集データです。年代の「ごろ」「〜」「または」は省略せず表示しています。'),
  );
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
      h('p', { class: 'theme' }, '全国の出来事294件・歴史スポット160か所・人物約1,900人を収録（試験版）'),
      searchForm(),
      h(
        'div',
        { class: 'purposes' },
        option('#/nearby', '地図から選ぶ・現在地から追う', '地図のピンから選んだり、歩きながら近くの場所を確かめたりできます', '📍'),
        option('#/deep', '好きな人物・時代を深掘りする', '年表・人物・歴代天皇から、ゆかりの場所をたどります', '🔎'),
        option('#/trip', '旅先で歴史に触れる', '行き先の都道府県を選んで、訪ねられる場所を探します', '🧳'),
        option('#/themes', '問いから探究する', '42の探究テーマから、人物・出来事・場所を往復して調べます', '💡'),
        option('#/stamps', 'スタンプ帳', '100名城・続100名城や訪れた場所にスタンプを押して記録します', '🏯'),
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

/* ---------------- 地図から選ぶ・現在地から追う ---------------- */

interface MapItem {
  key: string;
  name: string;
  /** 表示用の種類 */
  label: string;
  pin: 'castle' | 'museum' | 'spot';
  lat: number;
  lng: number;
  href: string;
  /** スタンプの記録先 */
  stamp: string;
  official: boolean;
}

/** 地図に置ける場所（公的資料で位置を照合できたものだけ）。同じ対象は1つにまとめる */
function mapItems(l: Library | null): MapItem[] {
  const out: MapItem[] = [];
  const meijo = (id: string) => {
    const cid = l?.castleOf.get(id);
    const c = cid ? l!.castleById.get(cid) : undefined;
    return c ? `${castleSeries(c)} ${c.n}` : '';
  };
  for (const p of places) {
    if (!hasCoord(p)) continue;
    const m = meijo(p.id);
    out.push({ key: p.id, name: p.name, label: [KIND_LABEL[p.kind], m].filter(Boolean).join('・'), pin: p.kind, lat: p.lat, lng: p.lng, href: `#/place/${p.id}`, stamp: stampKey(l, p.id), official: !!m });
  }
  for (const s of l?.spots ?? []) {
    if (!spotHasCoord(s) || s.place) continue;
    const m = meijo(s.id);
    out.push({ key: s.id, name: s.t, label: ['歴史スポット', m].filter(Boolean).join('・'), pin: 'spot', lat: s.lat!, lng: s.lng!, href: `#/spot/${s.id}`, stamp: stampKey(l, s.id), official: !!m });
  }
  return out;
}

const NEAR_KM = 0.3;
let stopWatch: (() => void) | null = null;
let followMap = true;
let lastListUpdate = 0;

function stopTracking(): void {
  stopWatch?.();
  stopWatch = null;
  state.tracking = false;
  state.acc = 0;
}

function drawHere(): void {
  if (!hereLayer) return;
  hereLayer.clearLayers();
  if (!state.here) return;
  if (state.acc) L.circle([state.here.lat, state.here.lng], { radius: state.acc, color: '#3b82f6', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(hereLayer);
  L.circleMarker([state.here.lat, state.here.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 })
    .bindTooltip('現在地（端末内でのみ使用）')
    .addTo(hereLayer);
}

function drawItems(items: MapItem[], fit: boolean): void {
  if (!map || !markerLayer) return;
  markerLayer.clearLayers();
  for (const it of items) {
    const sel = state.selected === it.key;
    const m = L.marker([it.lat, it.lng], {
      icon: L.divIcon({
        className: '',
        html: `<span class="pin pin-${it.pin}${sel ? ' pin-hl' : ''}" aria-hidden="true">${it.pin === 'castle' ? '城' : it.pin === 'museum' ? '館' : '史'}</span>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
      }),
      title: it.name,
      alt: `${it.label}：${it.name}`,
      keyboard: true,
      zIndexOffset: sel ? 1000 : 0,
    });
    m.on('click', () => {
      state.selected = it.key;
      followMap = false;
      renderNearby(false);
      keepAboveCard(it);
    });
    m.addTo(markerLayer);
  }
  drawHere();
  if (fit) {
    const pts = items.map((i) => L.latLng(i.lat, i.lng));
    if (state.here) pts.push(L.latLng(state.here.lat, state.here.lng));
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 14 });
    else if (pts.length === 1) map.setView(pts[0], 13);
  }
}

/** 選択カードが出ているときは、カードに隠れない位置を中心にする */
function centerWithCard(lat: number, lng: number, zoom: number, animate: boolean): void {
  if (!map) return;
  const card = selectionBox.childElementCount ? selectionBox.getBoundingClientRect().height : 0;
  const target = map.project([lat, lng], zoom).add([0, card / 2]);
  map.setView(map.unproject(target, zoom), zoom, { animate });
}

/** 選んだピンが下の選択カードに隠れないよう、地図を少し上へずらす */
function keepAboveCard(it: MapItem): void {
  if (!map) return;
  const card = selectionBox.getBoundingClientRect().height;
  const pt = map.latLngToContainerPoint([it.lat, it.lng]);
  const limit = map.getSize().y - card - 40;
  if (pt.y > limit) map.panBy([0, pt.y - limit / 2], { animate: true });
}

function originPoint(): { lat: number; lng: number } {
  const c = map?.getCenter();
  return state.here ?? (c ? { lat: c.lat, lng: c.lng } : { lat: 35.5, lng: 139.4 });
}

function startTracking(): void {
  stopTracking();
  state.tracking = true;
  state.hereStatus = '現在地を確認しています…';
  followMap = true;
  let first = true;
  stopWatch = watchPosition(
    (pos) => {
      state.here = { lat: pos.lat, lng: pos.lng };
      state.acc = pos.acc;
      state.hereStatus = '';
      if (!location.hash.startsWith('#/nearby')) return stopTracking();
      hereStatusEl.hidden = true;
      drawHere();
      if (followMap && map) centerWithCard(pos.lat, pos.lng, first ? 15 : map.getZoom(), !first);
      first = false;
      const now = Date.now();
      if (now - lastListUpdate > 3000) {
        lastListUpdate = now;
        updateNearbyList();
      }
    },
    (msg) => {
      stopTracking();
      state.hereStatus = msg;
      if (location.hash.startsWith('#/nearby')) renderNearby(false);
    },
  );
}

function renderNearby(fit = true): void {
  const { panel } = exploreShell('nearby', '地図から選ぶ');
  map?.getContainer().parentElement?.append(selectionBox);
  const l = getLibrary();
  if (!l) loadLibrary().then(() => location.hash.startsWith('#/nearby') && renderNearby()).catch(() => {});
  if (!stampsLoaded()) loadStamps().then(() => location.hash.startsWith('#/nearby') && renderNearby(false)).catch(() => {});

  const trackBtn = h(
    'button',
    {
      type: 'button',
      class: `btn${state.tracking ? ' btn-on' : ''}`,
      'aria-pressed': state.tracking ? 'true' : 'false',
      onclick: () => {
        if (state.tracking) stopTracking();
        else startTracking();
        renderNearby(false);
      },
    },
    state.tracking ? '■ 現在地を追うのをやめる' : '◎ 現在地から追う',
  );
  const centerBtn = state.tracking
    ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { followMap = true; if (state.here && map) centerWithCard(state.here.lat, state.here.lng, Math.max(map.getZoom(), 15), true); } }, '現在地に戻る')
    : state.here
      ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { state.here = null; hereLayer?.clearLayers(); renderNearby(false); } }, '地図の中心から並べる')
      : null;

  add(
    panel,
    h('div', { class: 'row' }, trackBtn, centerBtn),
    state.tracking
      ? h('p', { class: 'note' }, `現在地を追っています${state.acc ? `（誤差 約${Math.round(state.acc)}m）` : ''}。位置はこの端末の中だけで使い、送信・保存しません。この画面を離れると止まります。`)
      : h('p', { class: 'note' }, '地図のピンを押すと、その場所を選べます。現在地はこの端末の中だけで距離の計算に使い、どこにも送信・保存しません。'),
    hereStatusEl,
    nearbyList,
  );
  updateNearbyList();
  drawItems(mapItems(l), fit && !state.tracking);
  if (map) {
    map.off('dragstart');
    map.on('dragstart', () => {
      followMap = false;
    });
  }
}

const selectionBox = h('div', { class: 'select-overlay', 'aria-live': 'polite' });
const hereStatusEl = h('p', { class: 'status', role: 'status' });
const nearbyList = h('div', {});

function itemDistance(it: MapItem): number | null {
  return state.here ? distanceKm(state.here.lat, state.here.lng, it.lat, it.lng) : null;
}

function quickStampButton(it: MapItem, small = false): HTMLElement {
  const done = !!stampsLoaded()?.get(it.stamp)?.personal;
  return h(
    'button',
    {
      type: 'button',
      class: `btn${done ? ' btn-ghost' : ''}${small ? ' btn-sm' : ''}`,
      disabled: done,
      onclick: () => setPersonal(it.stamp, today(), '').then(() => renderNearby(false)),
    },
    done ? '✓ スタンプ済み' : 'スタンプを押す',
  );
}

function updateNearbyList(): void {
  hereStatusEl.textContent = state.hereStatus;
  hereStatusEl.hidden = !state.hereStatus;
  const l = getLibrary();
  const items = mapItems(l);
  const origin = originPoint();
  const sorted = items.map((it) => ({ it, d: distanceKm(origin.lat, origin.lng, it.lat, it.lng) })).sort((a, b) => a.d - b.d);

  // 選んだ場所
  clear(selectionBox);
  const sel = items.find((i) => i.key === state.selected);
  if (sel) {
    const d = itemDistance(sel);
    add(
      selectionBox,
      h(
        'div',
        { class: 'select-card' },
        h('button', { type: 'button', class: 'close', 'aria-label': '選択を解除', onclick: () => { state.selected = ''; renderNearby(false); } }, '×'),
        h('span', { class: `kind kind-${sel.pin}` }, sel.label),
        h('strong', { class: 'card-title' }, sel.name),
        d !== null ? h('span', { class: 'card-sub' }, d <= NEAR_KM ? h('strong', { class: 'near-tag' }, 'すぐ近く') : null, ` 現在地から直線距離${formatKm(d)}`) : null,
        h('div', { class: 'row' }, h('a', { href: sel.href, class: 'btn btn-sm' }, '詳しく見る'), quickStampButton(sel, true)),
      ),
    );
  }

  // 近くに来たとき
  clear(nearbyList);
  if (state.tracking && state.here) {
    const close = sorted.filter((x) => x.d <= NEAR_KM && x.it.key !== state.selected);
    for (const { it, d } of close.slice(0, 3))
      add(nearbyList, h('div', { class: 'near-banner' }, h('p', {}, h('strong', {}, `${it.name}`), ` のすぐ近くです（${formatKm(d)}）`), h('div', { class: 'row' }, h('a', { href: it.href, class: 'btn btn-ghost btn-sm' }, '詳しく見る'), quickStampButton(it))));
  }

  const pendingSpots = l ? l.spots.filter((s) => !spotHasCoord(s)).length : 0;
  const pendingCastles = l ? l.castles.filter((c) => !c.same.some((id) => items.some((i) => i.key === id))).length : 0;
  add(
    nearbyList,
    h('h2', {}, state.here ? '現在地から近い順' : '地図の中心から近い順'),
    state.here ? null : h('p', { class: 'note' }, '地図を動かすと、並び順が変わります。'),
    h(
      'div',
      { class: 'cards' },
      sorted.map(({ it, d }) =>
        h(
          'button',
          {
            type: 'button',
            class: `card card-btn${state.selected === it.key ? ' card-sel' : ''}`,
            onclick: () => {
              state.selected = it.key;
              followMap = false;
              map?.setView([it.lat, it.lng], Math.max(map.getZoom(), 14));
              renderNearby(false);
              keepAboveCard(it);
              map?.getContainer().scrollIntoView({ behavior: 'smooth', block: 'center' });
            },
          },
          h('span', { class: `kind kind-${it.pin}` }, it.label),
          h('strong', { class: 'card-title' }, it.name),
          h('span', { class: 'card-sub' }, `直線距離${formatKm(d)}${stampsLoaded()?.get(it.stamp)?.personal ? '・スタンプ済み' : ''}`),
        ),
      ),
    ),
    l
      ? h(
          'div',
          { class: 'pending' },
          h('h3', {}, '地図上の位置を照合中の場所'),
          h('p', { class: 'note' }, `歴史スポット${pendingSpots}か所、日本100名城®・続日本100名城®${pendingCastles}城は、公的資料で位置を照合できていないため、まだ地図と距離の計算に入れていません（推定の位置は表示しません）。`),
          h('div', { class: 'row' }, h('a', { href: '#/trip', class: 'btn btn-ghost btn-sm' }, '都道府県から探す'), h('a', { href: '#/stamps', class: 'btn btn-ghost btn-sm' }, 'スタンプ帳から探す')),
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

  const l = getLibrary();
  if (!l) loadLibrary().then(() => location.hash.startsWith('#/deep') && renderDeep()).catch(() => {});
  add(panel,
    h('h2', {}, '全国の年表から'),
    l
      ? h('div', { class: 'chips' }, l.eras.map((era, i) => h('a', { href: `#/era/${i}`, class: 'chip' }, era)))
      : h('p', { class: 'muted' }, '読み込み中…'),
    h('div', { class: 'row' }, h('a', { href: '#/emperors', class: 'btn btn-ghost' }, '歴代天皇の一覧'), h('a', { href: '#/search', class: 'btn btn-ghost' }, '人物を名前で探す')),
    h('h2', {}, '試験運用地域（小田原攻めと関東の城）'),
    h('h3', {}, '出来事から'),
    h('div', { class: 'chips' }, EVENTS.map((e) => chip('event', e.id, `${e.name}（${e.year}）`))),
    h('h3', {}, '人物から'),
    h('div', { class: 'chips' }, peopleSorted.map((p) => chip('person', p.id, p.name))),
    h('h3', {}, '年代から'),
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
  const l = needLibrary(panel);
  if (!l) return;
  const prefs = l.prefs;
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
    h('p', { class: 'note' }, '全国の歴史スポット160か所と、試験運用地域（東京都・神奈川県・埼玉県）の城・博物館を収録しています。'),
  );
  if (!state.prefecture) {
    drawMarkers(null, true, l.spots);
    return;
  }
  const here = places.filter((p) => p.prefecture === state.prefecture);
  const hereIds = new Set(here.map((p) => p.id));
  const prefSpots = l.spots.filter((s) => s.pref === state.prefecture);
  // 試験運用の施設と同じ対象のスポットは、施設カードとして表示する
  for (const s of prefSpots) if (s.place) hereIds.add(s.place);
  const placesHere = places.filter((p) => hereIds.has(p.id));
  const located = prefSpots.filter(spotHasCoord).length + placesHere.filter(hasCoord).length;
  add(panel,
    h('h2', {}, `${state.prefecture}の歴史スポット（${prefSpots.length}か所）`),
    h('p', { class: 'note' }, located
      ? '地図には、公的資料で位置を照合できた場所だけを表示しています。'
      : 'この地域の場所は、地図上の位置を公的資料で照合中のため、まだ地図に表示していません（推定の位置は表示しません）。'),
    h('div', { class: 'cards' }, prefSpots.map((s) => spotCard(s, (l.eventsBySpot.get(s.id)?.length ?? 0) ? `関連する出来事${l.eventsBySpot.get(s.id)!.length}件` : undefined))),
    (() => {
      const cs = l.castles.filter((c) => c.pref.split('・').includes(state.prefecture));
      return cs.length ? [h('h2', {}, `日本100名城®・続日本100名城®（${cs.length}城）`), h('div', { class: 'cards' }, cs.map((c) => castleCard(l, c)))] : null;
    })(),
  );
  if (!placesHere.length) {
    drawMarkers(new Set(), true, prefSpots);
    if (!located) map?.setView([36.5, 137.5], 5);
    return;
  }
  const beyond = new Map<string, { place: Place; via: Set<string> }>();
  for (const p of placesHere) {
    for (const c of connectedPlaces(p)) {
      if (hereIds.has(c.place.id)) continue;
      const cur = beyond.get(c.place.id) ?? { place: c.place, via: new Set<string>() };
      c.via.forEach((v) => cur.via.add(v));
      beyond.set(c.place.id, cur);
    }
  }
  add(panel,
    h('h2', {}, `${state.prefecture}の城・博物館（試験運用データ）`),
    h('div', { class: 'cards' }, placesHere.map((p) => placeCard(p))),
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
  drawMarkers(hereIds, true, prefSpots);
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
  const lib = getLibrary();
  if (!lib) loadLibrary().then(() => location.hash === `#/place/${p.id}` && renderPlace(p.id)).catch(() => {});
  const spot = lib?.spots.find((s) => s.place === p.id);
  const spotEvents = spot ? lib!.eventsBySpot.get(spot.id) ?? [] : [];

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
                    onclick: () => go(`#/person/${person.id}`),
                  },
                  person.lifespan ? `${person.name}（${person.lifespan.split('（')[0]}）` : person.name,
                ),
              ),
            ),
          )
        : null,

      lib?.castleOf.get(p.id)
        ? h('p', {}, h('a', { href: `#/castle/${lib.castleOf.get(p.id)}`, class: 'btn btn-ghost' }, `${castleSeries(lib.castleById.get(lib.castleOf.get(p.id)!)!)} 第${lib.castleById.get(lib.castleOf.get(p.id)!)!.n}番のページ`))
        : null,
      lib ? stampPanel(stampKey(lib, p.id), lib.castleOf.has(p.id)) : null,

      spot
        ? h(
            'section',
            {},
            h('h2', {}, '全国の年表とのつながり'),
            h('div', { class: 'cards' }, spotEvents.map(({ ev, rel }) => eventCard(ev, `この場所との関係：${rel}`)), spotCard(spot, '全国データのスポット情報')),
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


/* ---------------- 画面：人物 ---------------- */

const FACT_ORDER = ['出身', '生年', '没年', '最期', '家族', 'エピソード'] as const;

/** 全国データの人物情報（人物リスト・関係データ・歴代天皇） */
function libPersonSections(l: Library, id: string): (HTMLElement | null)[] {
  const p = l.people[id];
  const emps = l.emperorByPerson.get(id) ?? [];
  const pes = [...(l.peByPerson.get(id) ?? [])].sort((a, b) => l.eventById.get(a[1])!.y - l.eventById.get(b[1])!.y);
  const pss = l.psByPerson.get(id) ?? [];
  return [
    h(
      'dl',
      { class: 'profile' },
      p.al.length ? [h('dt', {}, '別名'), h('dd', {}, p.al.join('・'))] : null,
      h('dt', {}, '学習グループ'),
      h('dd', {}, p.g, h('span', { class: 'muted' }, '（編集上の分類で、厳密な生存年代ではありません）')),
      p.s ? [h('dt', {}, '概要'), h('dd', {}, p.s)] : null,
      p.x
        ? [h('dt', {}, '共通テスト'), h('dd', {}, `2024・2025年度の問題に氏名の登場を確認（${p.x}）。正解の人物であることや重要度を示すものではありません。`)]
        : null,
    ),
    p.add ? h('p', { class: 'note' }, '関係資料で補完した人物です。生没年・読み・人物情報はまだ補完していません。同じ名前の別人に注意してください。') : null,
    p.w ? wikiLink(p.w) : null,
    emps.length
      ? h(
          'section',
          {},
          h('h2', {}, '天皇としての情報'),
          emps.map((e) =>
            h(
              'div',
              { class: 'emp' },
              h('p', {}, h('strong', {}, `${e.d.startsWith('北') ? `北朝第${e.d.slice(1)}代` : `第${e.d}代`} ${e.n}`), `（${e.y}）`),
              h('p', {}, '生没年：', e.life),
              h('p', {}, statusBadge('st-kind', e.k), ' ', e.ep),
              e.same ? h('p', { class: 'muted' }, `第${e.same}代と同一人物（重祚）`) : null,
            ),
          ),
          h('p', { class: 'muted' }, '出典：宮内庁「天皇系図」ほか（', h('a', { href: '#/emperors' }, '歴代天皇の一覧'), '）'),
        )
      : null,
    pes.length
      ? h(
          'section',
          {},
          h('h2', {}, `関わった出来事（${pes.length}件）`),
          h('p', { class: 'note' }, '出来事に登場することは、その出来事に関わる場所すべてを訪れたことを意味しません。'),
          h(
            'ol',
            { class: 'claims timeline' },
            pes.map(([, eid, role, note]) => {
              const ev = l.eventById.get(eid)!;
              return h(
                'li',
                { class: 'claim' },
                h('a', { href: `#/event/${eid}`, class: 'claim-place' }, `${ev.t}（${ev.date}）`),
                h('p', {}, '役割：', role || PE_DEFAULT_ROLE),
                note ? h('p', { class: 'muted' }, `注記：${note}`) : null,
              );
            }),
          ),
        )
      : null,
    pss.length
      ? h(
          'section',
          {},
          h('h2', {}, `ゆかりの歴史スポット（${pss.length}件）`),
          h(
            'ul',
            { class: 'claims' },
            pss.map(([, sid, role, period, cls, , note]) =>
              h(
                'li',
                { class: 'claim' },
                statusBadge(`st-${cls}`, PS_CLASS[cls].label, PS_CLASS[cls].help),
                h('a', { href: `#/spot/${sid}`, class: 'claim-place' }, l.spotById.get(sid)!.t),
                h('p', {}, `${role}（${period}）`),
                note ? h('p', { class: 'muted' }, `注意：${note}`) : null,
              ),
            ),
          ),
          dataNotice(),
        )
      : null,
  ];
}

function renderPerson(id: string): void {
  const lib = getLibrary();
  const person = personById.get(id);
  if (!person) {
    clear(app);
    const main = h('main', { class: 'detail' });
    app.append(header('人物'), main);
    const l = needLibrary(main);
    if (!l) return;
    if (l.pilot[id]) return void location.replace(`#/person/${l.pilot[id]}`);
    const p = l.people[id];
    if (!p) return void go('#/');
    add(
      main,
      h('button', { type: 'button', class: 'back', onclick: () => history.back() }, '← もどる'),
      h('span', { class: 'kind kind-person' }, '人物'),
      h('h1', {}, p.n),
      ...libPersonSections(l, id),
    );
    window.scrollTo(0, 0);
    return;
  }
  if (!lib) loadLibrary().then(() => location.hash === `#/person/${id}` && renderPerson(id)).catch(() => {});
  const libId = lib?.pilotReverse.get(person.id);
  clear(app);
  const related = placesWithPerson(person.id);
  const facts = [...(person.facts ?? [])].sort((a, b) => FACT_ORDER.indexOf(a.label) - FACT_ORDER.indexOf(b.label));
  const timeline: { c: Claim; p: Place }[] = [];
  for (const p of places) for (const c of p.claims) if (c.people?.includes(person.id)) timeline.push({ c, p });
  timeline.sort((a, b) => (a.c.year ?? 9999) - (b.c.year ?? 9999));

  app.append(
    header('人物'),
    h(
      'main',
      { class: 'detail' },
      h('button', { type: 'button', class: 'back', onclick: () => history.back() }, '← もどる'),
      h('span', { class: 'kind kind-person' }, '人物'),
      h('h1', {}, person.name),
      h('p', { class: 'kana' }, person.kana),
      h(
        'dl',
        { class: 'profile' },
        h('dt', {}, '生没年'),
        h('dd', {}, person.lifespan ?? '信頼できる出典でまだ確認できていません'),
        person.deathBattle
          ? [
              h('dt', {}, person.deathBattle.diedInBattle ? '亡くなった戦い' : '最期に関わった戦い'),
              h('dd', {}, person.deathBattle.name, person.deathBattle.diedInBattle ? '（戦死）' : '（戦死ではない）'),
            ]
          : null,
      ),
      person.note ? h('p', {}, person.note.text, ' ', sourceLinks([person.note.sourceId])) : null,

      facts.length
        ? h(
            'section',
            {},
            h('h2', {}, '人物像'),
            legend(),
            h(
              'ul',
              { class: 'claims' },
              facts.map((f) =>
                h(
                  'li',
                  { class: `claim claim-${f.type}` },
                  h('span', { class: `badge badge-${f.type}`, title: CLAIM_HELP[f.type] }, CLAIM_LABEL[f.type]),
                  h('span', { class: 'fact-label' }, f.label),
                  h('p', {}, f.text),
                  sourceLinks(f.sourceIds),
                ),
              ),
            ),
          )
        : h('p', { class: 'note' }, '出身・生没年などの情報は、信頼できる出典でまだ確認できていないため掲載していません。'),

      related.length
        ? h('section', {}, h('h2', {}, `ゆかりの場所（${related.length}件）`), h('div', { class: 'cards' }, related.map((p) => placeCard(p))))
        : null,
      timeline.length
        ? h('section', {}, h('h2', {}, '登場する出来事を年代順に'), h('ol', { class: 'claims timeline' }, timeline.map((t) => claimItem(t.c, t.p))))
        : null,
      lib && libId ? h('section', { class: 'lib-sec' }, h('h2', {}, '全国データでの情報'), ...libPersonSections(lib, libId)) : null,
    ),
  );
  window.scrollTo(0, 0);
}

/* ---------------- 画面：全国データ（出来事・スポット・年表・天皇・テーマ） ---------------- */

function detailShell(title: string): HTMLElement {
  clear(app);
  const main = h('main', { class: 'detail' });
  app.append(header(title), main);
  window.scrollTo(0, 0);
  return main;
}
const backBtn = () => h('button', { type: 'button', class: 'back', onclick: () => history.back() }, '← もどる');

function renderEvent(id: string): void {
  const main = detailShell('出来事');
  const l = needLibrary(main);
  if (!l) return;
  const e = l.eventById.get(id);
  if (!e) return void go('#/');
  const st = eventStatus(e);
  const pes = l.peByEvent.get(e.id) ?? [];
  const idx = l.events.indexOf(e);
  const prev = l.events[idx - 1];
  const next = l.events[idx + 1];
  add(
    main,
    backBtn(),
    h('span', { class: 'kind kind-event' }, '出来事'),
    h('h1', {}, e.t),
    h('p', { class: 'kana' }, `${e.date}・`, h('a', { href: `#/era/${e.era}` }, l.eras[e.era])),
    h('p', {}, statusBadge(st.cls, st.label)),
    h('dl', { class: 'profile' }, h('dt', {}, '分野'), h('dd', {}, e.field), h('dt', {}, '主な地域'), h('dd', {}, e.region)),
    h('h2', {}, '学習の焦点'),
    h('p', {}, e.focus),
    h('p', { class: 'muted' }, '編集上の要約です。因果関係を一つに断定するものではありません。'),
    e.note ? [h('h2', {}, '年代・解釈の注意'), h('p', { class: 'warn' }, e.note)] : null,
    h('h2', {}, '関連人物・主体'),
    pes.length
      ? h(
          'ul',
          { class: 'claims' },
          pes.map(([pid, , role, note]) =>
            h(
              'li',
              { class: 'claim' },
              h('a', { href: personHref(l, pid), class: 'claim-place' }, personName(l, pid)),
              h('p', {}, '役割：', role || PE_DEFAULT_ROLE),
              note ? h('p', { class: 'muted' }, `注記：${note}`) : null,
            ),
          ),
        )
      : null,
    e.actors.length ? h('p', { class: 'muted' }, `資料の記載：${e.actors.join('・')}（組織・集団は人物として登録していません）`) : h('p', { class: 'muted' }, '本版では個別の人物を登録していません（関わった人がいないという意味ではありません）。'),
    h('h2', {}, '関連する歴史スポット'),
    e.spots.length
      ? [
          h('p', { class: 'note' }, '関係の種類を表示しています。すべてが出来事の起きた場所とは限りません（後世の記念施設・比較資料なども含みます）。'),
          h('div', { class: 'cards' }, e.spots.map(([sid, rel]) => spotCard(l.spotById.get(sid)!, `関係：${rel}`))),
        ]
      : h('p', { class: 'muted' }, '本版では未登録です（場所が存在しないという意味ではありません）。'),
    e.conf.length ? [h('h2', {}, '確認補助資料'), refLinks(l, e.conf)] : null,
    wikiLink(e.wiki),
    dataNotice(),
    h(
      'div',
      { class: 'row pager' },
      prev ? h('a', { href: `#/event/${prev.id}`, class: 'btn btn-ghost' }, `← ${prev.t}`) : null,
      next ? h('a', { href: `#/event/${next.id}`, class: 'btn btn-ghost' }, `${next.t} →`) : null,
    ),
  );
}

function renderSpot(id: string): void {
  const main = detailShell('歴史スポット');
  const l = needLibrary(main);
  if (!l) return;
  const s = l.spotById.get(id);
  if (!s) return void go('#/');
  const evs = [...(l.eventsBySpot.get(s.id) ?? [])].sort((a, b) => a.ev.y - b.ev.y);
  const pss = l.psBySpot.get(s.id) ?? [];
  const saved = state.saved.has(s.id);
  const mapWrap = h('div', { class: 'map-wrap map-inline' });
  add(
    main,
    backBtn(),
    h('span', { class: 'kind kind-spot' }, '歴史スポット'),
    h('h1', {}, s.t),
    h('p', { class: 'kana' }, `${s.pref} ${s.city}・${s.kind}・主な時代：${s.era}`),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          class: `btn${saved ? ' btn-ghost' : ''}`,
          'aria-pressed': saved ? 'true' : 'false',
          onclick: () => {
            if (state.saved.has(s.id)) state.saved.delete(s.id);
            else state.saved.add(s.id);
            storeSaved(state.saved);
            renderSpot(s.id);
          },
        },
        saved ? '★ 行きたい に登録済み' : '☆ 行きたい に追加',
      ),
      s.place ? h('a', { href: `#/place/${s.place}`, class: 'btn btn-ghost' }, '施設の詳しい情報を見る') : null,
    ),
    spotHasCoord(s)
      ? [mapWrap, h('p', { class: 'muted' }, `地図上の位置：${s.coord?.memo || ''}`, s.coord?.url ? [' 根拠：', extLink(s.coord.url, s.coord.src), `（確認日 ${s.coord.checked}）`] : null)]
      : h(
          'p',
          { class: 'warn' },
          `地図上の位置は、公的資料による照合がまだ済んでいないため表示していません（推定の位置は表示しません）。所在地の概略：${s.pref} ${s.city}`,
        ),
    s.castle ? h('p', {}, h('a', { href: `#/castle/${s.castle}`, class: 'btn btn-ghost' }, `${castleSeries(l.castleById.get(s.castle)!)} 第${l.castleById.get(s.castle)!.n}番のページ`)) : null,
    h('h2', {}, '歴史的な意味・見方'),
    h('p', {}, s.meaning),
    h('p', { class: 'muted' }, '当時の遺構・復元建物・後世の記念施設・伝承地を区別して見てください。'),
    h('h2', {}, `関連する出来事（${evs.length}件）`),
    evs.length
      ? h('div', { class: 'cards' }, evs.map(({ ev, rel }) => eventCard(ev, `この場所との関係：${rel}`)))
      : h('p', { class: 'muted' }, '本版の出来事リストには未接続です（歴史的に重要でないという意味ではありません）。'),
    pss.length
      ? [
          h('h2', {}, `ゆかりの人物（${pss.length}人）`),
          h(
            'ul',
            { class: 'claims' },
            pss.map(([pid, , role, period, cls, , note]) =>
              h(
                'li',
                { class: 'claim' },
                statusBadge(`st-${cls}`, PS_CLASS[cls].label, PS_CLASS[cls].help),
                h('a', { href: personHref(l, pid), class: 'claim-place' }, personName(l, pid)),
                h('p', {}, `${role}（${period}）`),
                note ? h('p', { class: 'muted' }, `注意：${note}`) : null,
              ),
            ),
          ),
        ]
      : null,
    s.conf.length ? [h('h2', {}, '確認補助資料'), refLinks(l, s.conf)] : null,
    wikiLink(s.wiki),
    h('p', { class: 'warn' }, '開館日・料金・予約・立入可否・災害復旧状況は収録していません。訪れる前に運営主体の最新情報を確認してください。'),
    stampPanel(stampKey(l, s.id), !!s.castle),
    dataNotice(),
  );
  if (spotHasCoord(s)) {
    ensureMap(mapWrap);
    drawMarkers(s.place ? new Set([s.place]) : new Set(), false, [s]);
    setTimeout(() => map?.setView([s.lat!, s.lng!], 15), 0);
  }
}

function renderEra(idx: number): void {
  const main = detailShell('年表');
  const l = needLibrary(main);
  if (!l) return;
  if (!l.eras[idx]) return void go('#/deep');
  const evs = l.events.filter((e) => e.era === idx);
  add(
    main,
    backBtn(),
    h('h1', {}, l.eras[idx]),
    h('div', { class: 'chips' }, l.eras.map((era, i) => h('a', { href: `#/era/${i}`, class: `chip${i === idx ? ' chip-on' : ''}`, 'aria-current': i === idx ? 'page' : undefined }, era))),
    h('p', { class: 'note' }, `出来事${evs.length}件。時代区分は閲覧用の編集区分で、時代の境界についての唯一の学説ではありません。`),
    h('div', { class: 'cards' }, evs.map((e) => eventCard(e, `${e.field}・${e.region}`))),
    dataNotice(),
  );
}

function renderEmperors(): void {
  const main = detailShell('歴代天皇');
  const l = needLibrary(main);
  if (!l) return;
  add(
    main,
    backBtn(),
    h('h1', {}, '歴代天皇'),
    h('p', {}, '第1代〜第126代と、本表の代数に含まれない北朝の5天皇です。代数は宮内庁の天皇系図の体系に沿っています。'),
    h(
      'ul',
      { class: 'muted' },
      h('li', {}, '名前は主に諡号・追号で、生前の名前とは異なります。'),
      h('li', {}, '第1〜25代は記紀の伝承年代を実証された生没年として採用せず「不詳」としています。「?」は推定・異説のある年です。'),
      h('li', {}, '「伝承」「史書の記述」はその話が史料に記されていることを示し、出来事そのものが実証されたという意味ではありません。'),
      h('li', {}, '第35代と第37代、第46代と第48代は同一人物（重祚）です。'),
    ),
    l.emperorSecs.map((sec, si) => [
      h('h2', {}, sec),
      h(
        'ul',
        { class: 'claims' },
        l.emperors
          .filter((e) => e.sec === si)
          .map((e) =>
            h(
              'li',
              { class: 'claim' },
              h('p', {}, h('strong', {}, e.d.startsWith('北') ? `北朝${e.d.slice(1)}` : `${e.d}`), ' ', e.pid ? h('a', { href: personHref(l, e.pid) }, e.n) : e.n, h('span', { class: 'muted' }, `（${e.y}）`)),
              h('p', { class: 'muted' }, `生没年：${e.life}`),
              h('p', {}, statusBadge('st-kind', e.k), ' ', e.ep),
            ),
          ),
      ),
    ]).flat(),
    h(
      'p',
      { class: 'muted' },
      '主な参照資料：',
      extLink('https://www.kunaicho.go.jp/learn/about/kosei/keizu.html', '宮内庁「天皇系図」'),
      '（確認日 2026年11月1日）。上皇・今上天皇の状態は2026年11月1日時点です。',
    ),
  );
}

function renderThemes(): void {
  clear(app);
  const main = h('main', { class: 'detail' });
  app.append(header('探究テーマ'), purposeTabs('themes'), main);
  window.scrollTo(0, 0);
  const l = needLibrary(main);
  if (!l) return;
  add(
    main,
    h('h1', {}, '問いから探究する'),
    h('p', {}, '好きな問いを選び、人物・出来事・場所を往復して調べましょう。問いの文面は検証すべき論点であって、結論ではありません。'),
    ['入門', '標準', '発展'].map((lv) => [
      h('h2', {}, lv),
      h(
        'div',
        { class: 'cards' },
        l.themes
          .filter((t) => t.lv === lv)
          .map((t) => h('a', { href: `#/theme/${t.id}`, class: 'card' }, h('span', { class: 'kind kind-theme' }, `テーマ・${t.lv}`), h('strong', { class: 'card-title' }, t.t), h('span', { class: 'card-sub' }, t.q))),
      ),
    ]).flat(),
    h('p', { class: 'muted' }, '難度は教材設計上の目安です。入門は資料の観察・分類、標準は複数資料の比較、発展は史料批判や複数の説明の検討を想定しています。'),
  );
}

function renderTheme(id: string): void {
  const main = detailShell('探究テーマ');
  const l = needLibrary(main);
  if (!l) return;
  const t = l.themeById.get(id);
  if (!t) return void go('#/themes');
  add(
    main,
    backBtn(),
    h('span', { class: 'kind kind-theme' }, `探究テーマ・${t.lv}`),
    h('h1', {}, t.t),
    h('p', { class: 'lead' }, `中心の問い：${t.q}`),
    h('h2', {}, '調べる順番'),
    h('ol', {}, t.steps.map((s) => h('li', {}, s))),
    h('dl', { class: 'profile' }, h('dt', {}, '成果物'), h('dd', {}, t.o), h('dt', {}, '解釈上の注意'), h('dd', {}, t.c)),
    h('h2', {}, '人物'),
    t.p.length
      ? h('div', { class: 'chips' }, t.p.map((pid) => h('a', { href: personHref(l, pid), class: 'chip' }, personName(l, pid))))
      : h('p', { class: 'muted' }, '指定なし。資料に名前のない人々の活動も対象とします。'),
    h('h2', {}, '出来事'),
    t.e.length ? h('div', { class: 'cards' }, t.e.map((eid) => eventCard(l.eventById.get(eid)!))) : h('p', { class: 'muted' }, '固定の指定なし。問いに合わせて選びます。'),
    h('h2', {}, '歴史スポット'),
    t.s.length
      ? h('div', { class: 'cards' }, t.s.map((sid) => spotCard(l.spotById.get(sid)!)))
      : h('p', {}, '固定の指定なし。', h('a', { href: '#/trip' }, '旅先（都道府県）から一地点を選ぶ'), 'ところから始めましょう。'),
    h('p', { class: 'note' }, 'ここに挙げた人物・出来事・場所は比較・学習の対象であり、全員がすべての場所にいたことや、直接の因果関係、訪問の順序を意味しません。'),
    h(
      'details',
      { class: 'legend' },
      h('summary', {}, '共通の探究手順'),
      h(
        'ol',
        {},
        h('li', {}, '問いに対する仮説と、確かめられる資料を分けて書く。'),
        h('li', {}, '少なくとも性質の異なる2種類の資料を比べる（例：史料の翻刻・訳と研究解説、発掘調査報告書と展示解説）。'),
        h('li', {}, '各主張に出典名・URLまたは書誌・該当箇所・閲覧日を付ける。転載画像は権利情報も記録する。'),
        h('li', {}, '事実、史料の記述、研究上の解釈、自分の仮説を区別する。反例と未解決点を残す。'),
        h('li', {}, '現地で観察する場合は、当時の遺構・復元・後世の記念施設を区別する。開館情報は別途最新情報を確認する。'),
      ),
      h('p', { class: 'muted' }, '成果物の基本形：問い／仮説／観察・史料／比較／暫定的な説明／反例・限界／出典。'),
    ),
  );
}

/* ---------------- スタンプ帳 ---------------- */

/** 表示中の写真のURL（画面を切り替えるときに解放する） */
const photoUrls: string[] = [];
function photoUrl(b: Blob): string {
  const u = URL.createObjectURL(b);
  photoUrls.push(u);
  return u;
}

/** スタンプの記録先：同じ対象の名城があれば名城の番号にまとめる */
function stampKey(l: Library | null, id: string): string {
  return l?.castleOf.get(id) ?? id;
}

/** 2回押すと実行するボタン（誤操作の防止。ブラウザの確認ダイアログは使わない） */
function confirmBtn(label: string, onConfirm: () => void): HTMLButtonElement {
  let armed = false;
  const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, label);
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.textContent = 'もう一度押すと削除';
      setTimeout(() => {
        armed = false;
        b.textContent = label;
      }, 4000);
      return;
    }
    onConfirm();
  });
  return b;
}

function stampPanel(key: string, allowOfficial: boolean): HTMLElement {
  const box = h('section', { class: 'stamp-panel', 'aria-live': 'polite' });
  const stamps = stampsLoaded();
  if (!stamps) {
    loadStamps().then(() => route()).catch(() => {});
    add(box, h('p', { class: 'muted' }, 'スタンプ帳を読み込んでいます…'));
    return box;
  }
  const rec = stamps.get(key);
  const msg = h('p', { class: 'status', role: 'status' });
  const fail = (e: unknown) => (msg.textContent = (e as Error).message);
  add(box, h('h2', {}, 'スタンプ'));

  // 個人スタンプ：ワンタップで押せる。訪問日・メモは必要なときだけ開いて入力する
  const p = rec?.personal;
  const visited = h('input', { type: 'date', class: 'inp', 'aria-label': '訪問日（任意）', max: today(), value: p?.visited ?? '' });
  const memo = h('input', { type: 'text', class: 'inp', 'aria-label': 'メモ（任意）', maxlength: String(MEMO_MAX), placeholder: '200字まで', value: p?.memo ?? '' });
  add(
    box,
    h(
      'div',
      { class: `stamp-card${p ? ' stamp-on' : ''}` },
      h('div', { class: 'stamp-head' }, h('span', { class: 'stamp-mark', 'aria-hidden': 'true' }, p ? '訪' : '未'), h('strong', {}, '個人スタンプ'), p ? h('span', { class: 'muted' }, `押した日 ${p.at}`) : null),
      p
        ? h('p', {}, p.visited ? `訪問日 ${p.visited}` : '訪問日 未入力', p.memo ? `・${p.memo}` : '')
        : h('p', { class: 'muted' }, 'あなたの訪問記録です。いつでも押せます。'),
      p ? null : h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => setPersonal(key, today(), '').then(route, fail) }, '個人スタンプを押す')),
      h(
        'details',
        { class: 'stamp-more' },
        h('summary', {}, p ? '訪問日・メモを編集／取り消す' : '訪問日やメモを付けて押す'),
        h('label', { class: 'fld' }, '訪問日（任意）', visited),
        h('label', { class: 'fld' }, 'メモ（任意）', memo),
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => setPersonal(key, visited.value, memo.value).then(route, fail) }, p ? '記録を更新' : 'この内容で押す'),
          p ? confirmBtn('取り消す', () => removePersonal(key).then(route, fail)) : null,
        ),
      ),
    ),
  );

  // 公式スタンプの写真記録（名城のみ）
  if (allowOfficial) {
    const o = rec?.official;
    const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', id: `photo-${key}` });
    const odate = h('input', { type: 'date', class: 'inp', 'aria-label': '公式スタンプを押した日（任意）', max: today(), value: o?.date ?? '' });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      msg.textContent = '写真を処理しています（位置情報などを取り除いています）…';
      try {
        await setOfficial(key, await processPhoto(f), odate.value);
        route();
      } catch (e) {
        fail(e);
      }
    });
    add(
      box,
      h(
        'div',
        { class: `stamp-card${o ? ' stamp-on' : ''}` },
        h('div', { class: 'stamp-head' }, h('span', { class: 'stamp-mark stamp-mark-off', 'aria-hidden': 'true' }, o ? '城' : '未'), h('strong', {}, '公式スタンプの写真記録'), o ? h('span', { class: 'muted' }, `記録した日 ${o.at}`) : null),
        h('p', { class: 'muted' }, '日本城郭協会のスタンプ帳に押した実物のスタンプを撮影して残せます。写真はこの端末の中だけに保存し、撮影場所などの位置情報は取り除きます。'),
        o ? h('img', { src: photoUrl(o.photo), alt: '公式スタンプの写真（ご自身の記録）', class: 'stamp-photo' }) : null,
        o && o.date ? h('p', {}, `スタンプを押した日 ${o.date}`) : null,
        h('div', { class: 'row' }, fileInput, h('label', { for: `photo-${key}`, class: `btn${o ? ' btn-ghost' : ''}`, role: 'button', tabindex: '0' }, o ? '撮り直す' : '公式スタンプを撮影')),
        o
          ? h(
              'details',
              { class: 'stamp-more' },
              h('summary', {}, '押した日を記録／写真を削除'),
              h('label', { class: 'fld' }, 'スタンプを押した日（任意）', odate),
              h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn-sm', onclick: () => setOfficialDate(key, odate.value).then(route, fail) }, '日付を保存'), confirmBtn('写真を削除', () => removeOfficial(key).then(route, fail))),
            )
          : null,
        h('p', { class: 'muted small' }, 'スタンプの図柄は各城・日本城郭協会などの著作物です。写真はご自身の記録用とし、SNSなどへの公開はお控えください。'),
      ),
    );
  }
  add(box, msg);
  return box;
}

function castleCard(_l: Library, c: LibCastle): HTMLElement {
  const r = stampsLoaded()?.get(c.id);
  return h(
    'a',
    { href: `#/castle/${c.id}`, class: 'card' },
    h('span', { class: 'kind kind-castle' }, `${castleSeries(c)} ${c.n}`),
    h('strong', { class: 'card-title' }, c.t),
    h('span', { class: 'card-sub' }, [c.pref, r?.personal ? '個人スタンプ済み' : '', r?.official ? '公式スタンプ写真あり' : ''].filter(Boolean).join('・')),
  );
}

function renderCastle(id: string): void {
  const main = detailShell('名城');
  const l = needLibrary(main);
  if (!l) return;
  const c = l.castleById.get(id);
  if (!c) return void go('#/stamps');
  const links = (ids: string[], extra: string) =>
    ids.map((x) => (l.spotById.has(x) ? spotCard(l.spotById.get(x)!, extra) : placeById.has(x) ? placeCard(placeById.get(x)!, extra) : null));
  add(
    main,
    backBtn(),
    h('span', { class: 'kind kind-castle' }, castleSeries(c)),
    h('h1', {}, c.t),
    h('p', { class: 'kana' }, `${castleSeries(c)} 第${c.n}番・${c.pref}`),
    c.same.length || c.related.length
      ? [h('h2', {}, '歴史を調べる'), h('div', { class: 'cards' }, links(c.same, 'この城の情報'), links(c.related, '城の一部・関連する場所'))]
      : h('p', { class: 'note' }, 'この城の歴史・位置の情報はまだ収録していません（推測では補っていません）。'),
    stampPanel(c.id, true),
    h(
      'p',
      { class: 'muted' },
      '番号・名称・都道府県は日本城郭協会の公式一覧によります：',
      extLink(c.n <= 100 ? CASTLE_LIST_URL.main : CASTLE_LIST_URL.sequel, `${castleSeries(c)}一覧`),
      '（確認日 2026年11月1日）。日本100名城®・続日本100名城®は公益財団法人日本城郭協会の登録商標です。このアプリは同協会とは関係のない個人プロジェクトです。',
    ),
  );
}

/* スタンプ帳のジャンル。スポットの「種類」の記載から機械的に分類する（1か所が複数ジャンルに入ることがある） */
const GENRES: { id: string; label: string; short: string; re: RegExp }[] = [
  { id: 'castle', label: '城・城跡', short: '城', re: /城郭|城柵|グスク|陣跡|海城/ },
  { id: 'museum', label: '博物館・資料館', short: '博物館', re: /博物館|資料館|記念館|学習施設/ },
  { id: 'shrine', label: '寺院・神社', short: '寺社', re: /寺院|神社|信仰|参詣|祭祀|御嶽/ },
  { id: 'kofun', label: '古墳', short: '古墳', re: /古墳/ },
  { id: 'site', label: '遺跡・史跡', short: '遺跡', re: /遺跡|貝塚|官衙|宮殿|政庁|関所|碑|出土地|跡/ },
  { id: 'battle', label: '古戦場・戦跡', short: '戦跡', re: /戦跡|古戦場|合戦|戦場/ },
  { id: 'modern', label: '近代・産業遺産', short: '近代', re: /産業|鉱山|炭鉱|近代建築|交通|軍港|海軍|博覧会|政治施設|邸宅|収容所/ },
  { id: 'memorial', label: '追悼・平和', short: '追悼', re: /追悼|被爆|慰霊|災害遺構|記念公園/ },
  { id: 'town', label: '町並み・庭園・学び舎', short: '町並み', re: /集落|町並み|庭園|藩校|私塾|学問|教育|都市/ },
];
const genreLabel = (id: string) => GENRES.find((g) => g.id === id)?.label ?? 'その他';

interface StampItem {
  key: string;
  name: string;
  prefs: string[];
  genres: string[];
  href: string;
  /** 名城の番号（名城のみ） */
  no?: number;
}

/** スタンプを押せる場所の一覧（同じ対象は名城にまとめる） */
function stampItems(l: Library): StampItem[] {
  const out: StampItem[] = l.castles.map((c) => {
    const extra = c.same.flatMap((id) => (l.spotById.get(id) ? GENRES.filter((g) => g.re.test(l.spotById.get(id)!.kind)).map((g) => g.id) : []));
    return { key: c.id, name: c.t, prefs: c.pref.split('・'), genres: [...new Set(['castle', ...extra])], href: `#/castle/${c.id}`, no: c.n };
  });
  for (const sp of l.spots) {
    if (l.castleOf.has(sp.id)) continue;
    const g = GENRES.filter((x) => x.re.test(sp.kind)).map((x) => x.id);
    out.push({ key: sp.id, name: sp.t, prefs: [sp.pref], genres: g.length ? g : ['other'], href: `#/spot/${sp.id}` });
  }
  for (const p of places) {
    if (l.castleOf.has(p.id) || l.spots.some((sp) => sp.place === p.id)) continue;
    out.push({ key: p.id, name: p.name, prefs: [p.prefecture], genres: [p.kind === 'castle' ? 'castle' : 'museum'], href: `#/place/${p.id}` });
  }
  return out;
}

function renderStamps(): void {
  const main = detailShell('スタンプ帳');
  const l = needLibrary(main);
  if (!l) return;
  const stamps = stampsLoaded();
  if (!stamps) {
    add(main, h('p', { class: 'status' }, 'スタンプ帳を読み込んでいます…'));
    loadStamps().then(() => location.hash.startsWith('#/stamps') && renderStamps());
    return;
  }
  const msg = h('p', { class: 'status', role: 'status' });
  const all = stampItems(l);
  const f = state.stampFilter;
  const items = all.filter(
    (it) =>
      (!f.pref || it.prefs.includes(f.pref)) &&
      (!f.genre || it.genres.includes(f.genre)) &&
      (f.status === 'all' || (f.status === 'done') === !!(stamps.get(it.key)?.personal || stamps.get(it.key)?.official)),
  );
  const setF = (patch: Partial<typeof f>) => {
    Object.assign(state.stampFilter, patch);
    renderStamps();
  };
  const filtered = !!(f.pref || f.genre || f.status !== 'all');

  const cell = (it: StampItem) => {
    const r = stamps.get(it.key);
    return h(
      'a',
      { href: it.href, class: `cell${r?.personal ? ' cell-p' : ''}${r?.official ? ' cell-o' : ''}`, 'aria-label': `${it.no ? `${it.no} ` : ''}${it.name}${r?.personal ? '、個人スタンプ済み' : ''}${r?.official ? '、公式スタンプ写真あり' : ''}` },
      h('span', { class: 'cell-n' }, it.no ? String(it.no) : it.genres.map((g) => GENRES.find((x) => x.id === g)?.short ?? 'その他').join('・')),
      h('span', { class: 'cell-t' }, it.name),
      f.pref ? null : h('span', { class: 'cell-pref' }, it.prefs.join('・')),
      h('span', { class: 'cell-m', 'aria-hidden': 'true' }, `${r?.personal ? '訪' : ''}${r?.official ? '城' : ''}`),
    );
  };
  const section = (title: string, list: StampItem[], officialTotal = false) => {
    if (!list.length) return null;
    const pers = list.filter((it) => stamps.get(it.key)?.personal).length;
    const off = list.filter((it) => stamps.get(it.key)?.official).length;
    return [
      h('h2', {}, `${title}（${list.length}）`),
      h('p', { class: 'progress' }, h('span', {}, `個人スタンプ ${pers}/${list.length}`), officialTotal ? h('span', {}, `公式スタンプ写真 ${off}/${list.length}`) : null),
      h('div', { class: 'stamp-grid' }, list.map(cell)),
    ];
  };

  const prefSelect = h(
    'select',
    { class: 'inp', 'aria-label': '都道府県で絞り込む', onchange: (e: Event) => setF({ pref: (e.target as HTMLSelectElement).value }) },
    h('option', { value: '' }, 'すべての都道府県'),
    l.prefs.map((pf) => {
      const n = all.filter((it) => it.prefs.includes(pf) && (!f.genre || it.genres.includes(f.genre))).length;
      return h('option', { value: pf, selected: f.pref === pf, disabled: n === 0 }, `${pf}（${n}）`);
    }),
  );
  const genreChip = (id: string, label: string) => {
    const n = all.filter((it) => (!f.pref || it.prefs.includes(f.pref)) && (!id || it.genres.includes(id))).length;
    const on = f.genre === id;
    return h('button', { type: 'button', class: `chip${on ? ' chip-on' : ''}`, 'aria-pressed': on ? 'true' : 'false', disabled: n === 0 && !on, onclick: () => setF({ genre: id }) }, `${label} ${n}`);
  };
  const statusChip = (id: 'all' | 'todo' | 'done', label: string) =>
    h('button', { type: 'button', class: `chip${f.status === id ? ' chip-on' : ''}`, 'aria-pressed': f.status === id ? 'true' : 'false', onclick: () => setF({ status: id }) }, label);

  const meijo = items.filter((it) => it.no);
  const others = items.filter((it) => !it.no);

  const importInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', id: 'stamp-import' });
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    msg.textContent = '読み込んでいます…';
    try {
      const r = await importStamps(file);
      msg.textContent = `読み込みました：個人スタンプ${r.personal}件、公式スタンプ写真${r.official}件${r.skipped ? `（読み込めなかった項目${r.skipped}件）` : ''}。`;
      setTimeout(() => location.hash.startsWith('#/stamps') && renderStamps(), 1500);
    } catch (e) {
      msg.textContent = (e as Error).message;
    }
  });

  add(
    main,
    h('h1', {}, 'スタンプ帳'),
    h('p', { class: 'note' }, 'スタンプと写真は、この端末のブラウザの中にだけ保存されます。外部には送信しません。'),
    h(
      'div',
      { class: 'filters', role: 'group', 'aria-label': '絞り込み' },
      h('label', { class: 'fld' }, '都道府県', prefSelect),
      h('p', { class: 'fld-label' }, 'ジャンル'),
      h('div', { class: 'chips' }, genreChip('', 'すべて'), GENRES.map((g) => genreChip(g.id, g.label)), all.some((it) => it.genres.includes('other')) ? genreChip('other', 'その他') : null),
      h('p', { class: 'fld-label' }, '記録'),
      h('div', { class: 'chips' }, statusChip('all', 'すべて'), statusChip('todo', 'まだ'), statusChip('done', 'スタンプ済み')),
      filtered ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setF({ pref: '', genre: '', status: 'all' }) }, '絞り込みを解除') : null,
    ),
    h('p', { class: 'legend-inline' }, h('span', { class: 'cell-m' }, '訪'), ' 個人スタンプ　', h('span', { class: 'cell-m' }, '城'), ' 公式スタンプの写真記録'),
    items.length ? null : h('p', { class: 'status' }, '条件に合う場所はありません。絞り込みを変えてみてください。'),
    section('日本100名城®', meijo.filter((it) => it.no! <= 100), true),
    section('続日本100名城®', meijo.filter((it) => it.no! > 100), true),
    section(f.genre && f.genre !== 'castle' ? genreLabel(f.genre) : 'そのほかの場所', others),
    h('p', { class: 'muted' }, 'ジャンルは各場所の「種類」の記載から自動で分類しています。1か所が複数のジャンルに入ることがあります。'),
    h('h2', {}, 'バックアップ'),
    h('p', { class: 'muted' }, '機種変更などのときに、記録をファイルに書き出して別の端末で読み込めます。ファイルには公式スタンプの写真も含まれます。個人の記録用として保管し、公開・共有しないでください。'),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: async () => {
            try {
              const blob = await exportStamps();
              const a = h('a', { href: URL.createObjectURL(blob), download: `historyconnect-stamps-${today()}.json` });
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 10000);
              msg.textContent = '書き出しました。';
            } catch (e) {
              msg.textContent = (e as Error).message;
            }
          },
        },
        'ファイルに書き出す',
      ),
      importInput,
      h('label', { for: 'stamp-import', class: 'btn btn-ghost', role: 'button', tabindex: '0' }, 'ファイルから読み込む'),
    ),
    msg,
    h('p', { class: 'muted' }, '日本100名城®・続日本100名城®は公益財団法人日本城郭協会の登録商標です。このアプリは同協会とは関係のない個人プロジェクトで、公式スタンプの認定は行いません。'),
  );
}

/* ---------------- 画面：検索 ---------------- */

function searchForm(autofocus = false): HTMLFormElement {
  const input = h('input', {
    type: 'search',
    name: 'q',
    class: 'search-input',
    placeholder: '人物・城・出来事・地名など',
    'aria-label': '検索する言葉',
    maxlength: '100',
    autocomplete: 'off',
    enterkeyhint: 'search',
    value: state.query,
  });
  if (autofocus) setTimeout(() => input.focus(), 0);
  const form = h(
    'form',
    {
      class: 'search-form',
      role: 'search',
      onsubmit: (e: Event) => {
        e.preventDefault();
        state.query = input.value;
        input.blur();
        if (location.hash.startsWith('#/search')) updateSearchResults();
        else go('#/search');
      },
    },
    input,
    h('button', { type: 'submit', class: 'btn' }, '検索'),
  );
  input.addEventListener('input', () => {
    state.query = input.value;
    if (location.hash.startsWith('#/search')) updateSearchResults();
  });
  return form;
}

const searchResults = h('div', { 'aria-live': 'polite' });

function renderSearch(): void {
  clear(app);
  app.append(
    header('検索'),
    h(
      'main',
      { class: 'detail' },
      h('h1', {}, '検索'),
      searchForm(true),
      h('p', { class: 'note' }, '入力した言葉はこの端末の中だけで検索に使い、どこにも送信・保存しません。空白で区切ると、すべての言葉を含むものを探します。'),
      searchResults,
    ),
  );
  updateSearchResults();
}

function updateSearchResults(): void {
  clear(searchResults);
  const q = state.query.trim();
  if (!q) {
    add(
      searchResults,
      h('h2', {}, '例えば'),
      h(
        'div',
        { class: 'chips' },
        EXAMPLES.map((ex) =>
          h('button', { type: 'button', class: 'chip', onclick: () => { state.query = ex; renderSearch(); } }, ex),
        ),
      ),
    );
    return;
  }
  const r = search(q);
  const l = getLibrary();
  if (!l) loadLibrary().then(() => location.hash.startsWith('#/search') && updateSearchResults()).catch(() => {});
  const lr = l ? searchLibrary(l, q) : null;
  // 試験運用データと同じ人物は重ねて表示しない
  if (lr) lr.people = lr.people.filter((hit) => !l!.pilot[hit.item]);
  const total = r.places.length + r.people.length + r.events.length + (lr ? lr.people.length + lr.events.length + lr.spots.length + lr.themes.length : 0);
  add(searchResults, h('p', { class: 'status' }, total ? `「${q}」の検索結果：${total}件` : l ? `「${q}」に一致する情報は見つかりませんでした。` : '全国の歴史データを読み込んでいます…'));
  const LIMIT = 40;
  const more = (n: number) => (n > LIMIT ? h('p', { class: 'muted' }, `ほか${n - LIMIT}件。言葉を増やして絞り込んでください（空白で区切るとすべてを含むものを探します）。`) : null);
  if (lr?.themes.length)
    add(searchResults, h('h2', {}, `探究テーマ（${lr.themes.length}）`), h('div', { class: 'cards' }, lr.themes.slice(0, LIMIT).map((hit) => h('a', { href: `#/theme/${hit.item.id}`, class: 'card' }, h('span', { class: 'kind kind-theme' }, `テーマ・${hit.item.lv}`), h('strong', { class: 'card-title' }, hit.item.t), h('span', { class: 'card-sub' }, hit.item.q)))));
  if (lr?.events.length)
    add(searchResults, h('h2', {}, `全国の出来事（${lr.events.length}）`), h('div', { class: 'cards' }, lr.events.slice(0, LIMIT).map((hit) => eventCard(hit.item, hit.snippet))), more(lr.events.length));
  const castleHits = l ? l.castles.filter((c) => q.split(/[\s　]+/).filter(Boolean).every((w) => `${c.t}${c.pref}${castleSeries(c)}`.includes(w))) : [];
  if (castleHits.length) add(searchResults, h('h2', {}, `名城（${castleHits.length}）`), h('div', { class: 'cards' }, castleHits.slice(0, LIMIT).map((c) => castleCard(l!, c))));
  if (lr?.spots.length)
    add(searchResults, h('h2', {}, `歴史スポット（${lr.spots.length}）`), h('div', { class: 'cards' }, lr.spots.slice(0, LIMIT).map((hit) => spotCard(hit.item, hit.snippet))), more(lr.spots.length));
  if (r.people.length)
    add(
      searchResults,
      h('h2', {}, `人物（詳しい情報あり）（${r.people.length}）`),
      h('div', { class: 'cards' }, r.people.map((hit) => personCard(hit.item, hit.snippet))),
    );
  if (lr?.people.length)
    add(
      searchResults,
      h('h2', {}, `人物リスト（${lr.people.length}）`),
      h(
        'div',
        { class: 'cards' },
        lr.people.slice(0, LIMIT).map((hit) => {
          const p = l!.people[hit.item];
          return h('a', { href: personHref(l!, hit.item), class: 'card' }, h('span', { class: 'kind kind-person' }, '人物'), h('strong', { class: 'card-title' }, p.n), h('span', { class: 'card-sub' }, [p.g, hit.snippet ?? p.s].filter(Boolean).join('・')));
        }),
      ),
      more(lr.people.length),
    );
  if (r.places.length)
    add(
      searchResults,
      h('h2', {}, `城・博物館（${r.places.length}）`),
      h('div', { class: 'cards' }, r.places.map((hit) => placeCard(hit.item, hit.snippet))),
    );
  if (r.events.length)
    add(
      searchResults,
      h('h2', {}, `小田原攻めの出来事（${r.events.length}）`),
      h(
        'div',
        { class: 'cards' },
        r.events.map((hit) =>
          h(
            'button',
            {
              type: 'button',
              class: 'card card-btn',
              onclick: () => {
                state.focus = { kind: 'event', id: hit.item.id };
                go('#/deep');
              },
            },
            h('span', { class: 'kind kind-event' }, '出来事（試験運用）'),
            h('strong', { class: 'card-title' }, `${hit.item.name}（${hit.item.year}年）`),
            h('span', { class: 'card-sub' }, hit.item.summary.slice(0, 60) + '…'),
          ),
        ),
      ),
    );
}

function personCard(p: Person, extra?: string): HTMLElement {
  return h(
    'a',
    { href: `#/person/${p.id}`, class: 'card' },
    h('span', { class: 'kind kind-person' }, '人物'),
    h('strong', { class: 'card-title' }, p.name),
    h('span', { class: 'card-sub' }, [p.lifespan, extra].filter(Boolean).join('・') || p.kana),
  );
}

/* ---------------- 画面：行きたい場所 ---------------- */

function renderSaved(): void {
  clear(app);
  const list = [...state.saved].map((id) => placeById.get(id)).filter((p): p is Place => !!p);
  const spotIds = [...state.saved].filter((id) => id.startsWith('SPT-'));
  const l = getLibrary();
  if (spotIds.length && !l) loadLibrary().then(() => location.hash.startsWith('#/saved') && renderSaved()).catch(() => {});
  const spots = l ? spotIds.map((id) => l.spotById.get(id)).filter((s): s is LibSpot => !!s) : [];
  app.append(
    header('行きたい場所'),
    h(
      'main',
      { class: 'detail' },
      h('h1', {}, '行きたい場所'),
      h('p', { class: 'note' }, 'この一覧は、お使いの端末のブラウザ内にだけ保存されています。'),
      h('p', {}, h('a', { href: '#/stamps', class: 'btn btn-ghost' }, '訪れた場所はスタンプ帳へ')),
      list.length || spotIds.length
        ? h('div', { class: 'cards' }, list.map((p) => placeCard(p)), spots.map((s) => spotCard(s)))
        : h('p', {}, 'まだ登録がありません。施設・歴史スポットの詳細画面から追加できます。'),
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
      h('p', {}, 'ヒストリーコネクトは、人物・出来事・年代・場所を手がかりに、日本の歴史と関連する施設を探せるWebアプリです。現在は試験版です。'),

      h('h2', {}, '収録しているデータ'),
      h('ul', {}, [
        h('li', {}, '試験運用地域（1590年の小田原攻めと関東の城）：城・博物館8か所と人物・出来事。すべての記述に出典を付け、「史実」「説」「伝承」を区別しています。'),
        h('li', {}, '全国データ（2026年11月1日版）：出来事294件、歴史スポット160か所、人物1,891人と補完人物33人、人物と出来事・場所の関係、探究テーマ42件、歴代天皇。'),
      ]),
      h('h2', {}, '情報の正確性について'),
      h('ul', {}, [
        h('li', {}, '全国データは編集上の整理を含み、専門家による全件の校閲は済んでいません。各項目に確認状況（「確認補助資料あり」「編集整理・未照合」「学習上の関連」「説・比定」など）を表示しています。'),
        h('li', {}, '年代の「ごろ」「〜」「または」などは省略せず表示し、生没年が不詳のものは年表上の点として扱いません。'),
        h('li', {}, '開館時間・料金などは変わることがあります。お出かけ前に公式情報を確認してください。'),
        h('li', {}, '地図上の位置は、公式情報で確認した住所を国土地理院の住所検索で変換したものなど、公的資料で照合できたものだけを表示しています。推定の位置は表示しません。広い史跡では代表点です。'),
        h('li', {}, '人物の画像は掲載していません。参考記事（Wikipedia）へのリンクは追加調査の入口で、リンク先の内容は照合していません。'),
      ]),

      h('h2', { id: 'privacy' }, 'プライバシーポリシー（個人情報の取り扱い）'),
      h('p', {}, 'このアプリはログインや会員登録がなく、運営者のサーバーで利用者の個人情報を収集・保存しません。'),
      h('h3', {}, '1. 現在地（位置情報）'),
      h('p', {}, '「現在地から追う」を押し、ブラウザで許可したときだけ取得します。オンにしている間は位置を繰り返し取得し、地図上の現在地の表示と、場所までの距離の計算・近くに来たときのお知らせにだけ使います。位置はどこにも送信・保存せず、オフにする、またはこの画面を離れると取得を止めて破棄します。'),
      h('h3', {}, '2. 端末内に保存する情報'),
      h('p', {}, '「行きたい」に登録した施設・スポットの一覧を、お使いのブラウザの保存領域（localStorage）に保存します。'),
      h('p', {}, 'スタンプ帳の記録（個人スタンプを押した日・訪問日・メモ、公式スタンプの写真と押した日）を、お使いのブラウザの保存領域（IndexedDB）に保存します。訪問の記録は行動の履歴にあたるため、運営者は受け取らず、外部にも送信しません。'),
      h('p', {}, '公式スタンプの写真は、撮影または選んだ画像をこの端末の中で縮小して描き直してから保存します。この処理で、撮影場所の位置情報などのメタデータ（EXIF）は取り除かれます。カメラは写真を撮るときにだけ、端末の通常の撮影・写真選択の画面で使います。'),
      h('p', {}, 'スタンプ帳は「ファイルに書き出す」でバックアップできます。書き出したファイルには写真と訪問記録が含まれるため、ご自身で管理し、公開・共有しないでください。'),
      h('p', {}, 'Cookie、アクセス解析、広告の仕組みは使っていません。'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost',
          onclick: async () => {
            clearAllLocalData();
            await clearStamps();
            state.saved = new Set();
            state.here = null;
            alertInline('この端末に保存されたデータ（行きたい場所・スタンプ帳・写真）を消去しました。');
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
      h('p', {}, '全国データ（出来事・人物など）はこのサイトのファイルから読み込むため、上記以外への送信は発生しません。出典や参考記事などの外部サイトへのリンクは、利用者が押したときだけそのサイトを開きます。'),
      h('p', {}, '参照元のURL（リファラー）は外部に送らない設定にしています。各送信先での取り扱いは、それぞれの方針をご確認ください：', extLink('https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html', '国土地理院コンテンツ利用規約'), '、', extLink('https://docs.github.com/ja/site-policy/privacy-policies/github-general-privacy-statement', 'GitHub一般プライバシーステートメント'), '。'),
      h('h3', {}, '4. EU・英国などからのご利用（GDPR）'),
      h('p', {}, '運営者は利用者の個人データを収集しません。位置情報は端末内でのみ処理されます。地図の表示と配信のための通信は、上記の各送信先によって処理されます。'),
      h('h3', {}, '5. お問い合わせ・改定'),
      h('p', {}, '運営者：', h('strong', {}, 'Yoshio Fujimatsu（個人プロジェクト）')),
      h(
        'p',
        {},
        'お問い合わせ：',
        extLink('https://github.com/YF1900/historyconnect/issues', 'GitHubのIssues'),
        'で受け付けています。Issuesは公開の場所のため、氏名・住所・連絡先などの個人情報は書き込まないでください。',
      ),
      h('p', {}, 'このポリシーを変更するときは、このページで改定日とともにお知らせします。'),
      h('p', { class: 'muted' }, '制定日：2026年11月1日／改定日：2026年11月1日（運営者・お問い合わせ先・全国データ・スタンプ帳の追加を反映）'),

      h('h2', {}, '商標について'),
      h('p', {}, '日本100名城®・続日本100名城®は公益財団法人日本城郭協会の登録商標です。このアプリは同協会とは関係のない個人プロジェクトで、名城の番号・名称は同協会の公式一覧によります。'),
      h('h2', {}, '地図・ソフトウェア'),
      h('p', {}, '地図：', extLink('https://maps.gsi.go.jp/development/ichiran.html', '地理院タイル（国土地理院）'), '／地図表示：', extLink('https://leafletjs.com', 'Leaflet'), '（BSD-2-Clauseライセンス）'),

      h('h2', {}, '出典一覧（試験運用地域）'),
      sourcesList,
      h('h2', {}, '全国データの出典'),
      h('p', {}, '出来事・歴史スポット・関係・探究テーマ・歴代天皇は、運営者が編集した資料（2026年11月1日版）に基づきます。人物リストの概要はWikidata・Wikipediaの記載、共通テストの氏名登場は大学入試センターの公開問題（2024・2025年度）との照合によるものです。個別に確認に用いた資料は次のとおりです。'),
      (() => {
        const l = getLibrary();
        if (!l) {
          loadLibrary().then(() => location.hash.startsWith('#/about') && renderAbout()).catch(() => {});
          return h('p', { class: 'muted' }, '読み込み中…');
        }
        return h('ul', { class: 'sources' }, Object.values(l.refs).map((r) => h('li', {}, extLink(r.u, r.t), h('span', { class: 'muted' }, ` ${r.s}`))));
      })(),
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
  photoUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  if (!location.hash.startsWith('#/nearby') && state.tracking) {
    stopTracking();
    state.here = null; // 画面を離れたら現在地を破棄する
    hereLayer?.clearLayers();
  }
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
    case 'person':
      return renderPerson(decodeURIComponent(arg ?? ''));
    case 'search':
      return renderSearch();
    case 'event':
      return renderEvent(decodeURIComponent(arg ?? ''));
    case 'spot':
      return renderSpot(decodeURIComponent(arg ?? ''));
    case 'era':
      return renderEra(Number(arg));
    case 'emperors':
      return renderEmperors();
    case 'themes':
      return renderThemes();
    case 'theme':
      return renderTheme(decodeURIComponent(arg ?? ''));
    case 'saved':
      return renderSaved();
    case 'castle':
      return renderCastle(decodeURIComponent(arg ?? ''));
    case 'stamps':
      return renderStamps();
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
