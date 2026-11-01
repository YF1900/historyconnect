/**
 * data-src/ の資料（プロジェクトの追加コンテキストを変換したもの）から
 * public/data/library.json を生成し、件数・ID参照の整合性を検査する。
 * 実行：node --experimental-strip-types scripts/build-library.ts
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { PEOPLE as PILOT_PEOPLE, PLACES as PILOT_PLACES } from '../src/data.ts';

const SRC = new URL('../data-src/', import.meta.url);
const OUT = new URL('../public/data/', import.meta.url);
const errors: string[] = [];
const err = (m: string) => errors.push(m);

function lines(file: string): string[] {
  return readFileSync(new URL(file, SRC), 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '' && !l.startsWith('#'));
}
const pad = (n: number | string) => String(n).padStart(4, '0');
const evtId = (n: number | string) => `EVT-${pad(n)}`;
const sptId = (n: number | string) => `SPT-${pad(n)}`;
const wiki = (w: string, name: string) => (w === '=' ? name : w);

/** 年代表示から並べ替え用のおおよその西暦年を求める（表示には使わない） */
function sortYear(d: string): number {
  let m = d.match(/約(\d+)万(\d+)?千?年前/);
  if (m) return -(Number(m[1]) * 10000 + Number((m[2] ?? '0').padEnd(4, '0').slice(0, 4)));
  m = d.match(/紀元前(\d+)世紀/);
  if (m) return -Number(m[1]) * 100;
  m = d.match(/^(\d+)世紀(後半)?/);
  if (m) return (Number(m[1]) - 1) * 100 + (m[2] ? 50 : 0);
  m = d.match(/(\d{2,4})年/);
  if (m) return Number(m[1]);
  err(`年代を解釈できない: ${d}`);
  return 0;
}

// ---------- 参照資料 ----------
const refs: Record<string, { t: string; u: string; s: string }> = {};
for (const l of lines('refs.txt')) {
  const [id, t, u, s] = l.split('|');
  if (!u.startsWith('https://')) err(`資料URLがhttpsでない: ${id}`);
  refs[id] = { t, u, s };
}
const pairs = (s: string) =>
  s ? s.split(';').map((x) => { const i = x.indexOf(':'); return [x.slice(0, i), x.slice(i + 1)] as [string, string]; }) : [];

// ---------- 出来事 ----------
const eras: string[] = [];
const events: any[] = [];
for (const f of readdirSync(SRC).filter((f) => /^events-\d+\.txt$/.test(f)).sort()) {
  for (const l of lines(f)) {
    if (l.startsWith('@')) { eras.push(l.slice(1)); continue; }
    const c = l.split('|');
    if (c.length !== 11) { err(`出来事の列数が不正(${c.length}): ${l.slice(0, 40)}`); continue; }
    const [n, date, t, field, region, actors, focus, note, spots, conf, w] = c;
    events.push({
      id: evtId(n), era: eras.length - 1, date, y: sortYear(date), t, field, region,
      actors: actors ? actors.split('・') : [], focus, note,
      spots: pairs(spots).map(([s, rel]) => [sptId(s), rel]),
      conf: pairs(conf), wiki: wiki(w, t),
    });
  }
}

// ---------- スポット ----------
const prefs: string[] = [];
const spots: any[] = [];
for (const l of lines('spots.txt')) {
  if (l.startsWith('@')) { prefs.push(l.slice(1)); continue; }
  const c = l.split('|');
  if (c.length !== 8) { err(`スポットの列数が不正(${c.length}): ${l.slice(0, 40)}`); continue; }
  const [n, city, t, kind, era, meaning, conf, w] = c;
  spots.push({ id: sptId(n), pref: prefs[prefs.length - 1], city, t, kind, era, meaning, conf: pairs(conf), wiki: wiki(w, t) });
}
const spotById = new Map(spots.map((s) => [s.id, s]));

// 座標：公的資料で1件ずつ照合したものだけを登録する（推定値は入れない）
// 形式：番号|緯度|経度|照合した資料名|資料URL|確認日|照合メモ
for (const l of lines('spot-coords.txt')) {
  const [n, lat, lng, srcName, url, checked, memo] = l.split('|');
  const s = spotById.get(sptId(n));
  const la = Number(lat), lo = Number(lng);
  if (!s) { err(`座標の対象スポットがない: ${n}`); continue; }
  if (!(la > 20 && la < 46 && lo > 122 && lo < 154)) err(`座標が日本の範囲外: ${n}`);
  if (!url?.startsWith('https://')) err(`座標の根拠URLがない: ${n}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checked ?? '')) err(`座標の確認日が不正: ${n}`);
  s.lat = la; s.lng = lo; s.coord = { src: srcName, url, checked, memo: memo ?? '' };
}

// 試験運用地域の施設と同一の対象（名称・所在地・施設の実体を確認して統合）
const PILOT_SPOT: Record<string, string> = { 'SPT-0045': 'odawara-castle', 'SPT-0033': 'edo-castle' };
const pilotPlaceIds = new Set(PILOT_PLACES.map((p) => p.id));
for (const [sid, pid] of Object.entries(PILOT_SPOT)) {
  if (!pilotPlaceIds.has(pid)) err(`試験運用施設がない: ${pid}`);
  const s = spotById.get(sid)!;
  s.place = pid;
  const pp = PILOT_PLACES.find((p) => p.id === pid)!;
  if (s.lat === undefined && Number.isFinite(pp.lat)) {
    s.lat = pp.lat; s.lng = pp.lng; s.coord = { src: '試験運用データ（施設ページ参照）', url: '', checked: '', memo: pp.coordNote };
  }
}

// ---------- 人物 ----------
const people: Record<string, any> = {};
let group = '';
for (const raw of readFileSync(new URL('people.md', SRC), 'utf8').split('\n')) {
  const l = raw.replace(/\r$/, '');
  if (l.startsWith('### ')) { group = l.slice(4).trim(); continue; }
  if (!/^\| (Q\d+|candidate-[0-9a-f]+) \|/.test(l)) continue;
  const c = l.split(' | ').map((x) => x.replace(/^\| /, '').replace(/ \|$/, ''));
  if (c.length !== 6) { err(`人物の列数が不正: ${l.slice(0, 50)}`); continue; }
  const [id, nm, summary, wcol, , exam] = c;
  const m = nm.match(/^(.*?)（別名：(.*)）$/);
  const name = m ? m[1] : nm;
  const aliases = m ? m[2].split('・').filter((a) => a && a !== name) : [];
  const wm = wcol.match(/\(<(https:\/\/ja\.wikipedia\.org\/wiki\/[^>]+)>\)/);
  if (people[id]) err(`人物IDが重複: ${id}`);
  people[id] = { n: name, al: aliases, s: summary, g: group, w: wm ? decodeURIComponent(wm[1].slice(30)) : '', x: exam === '未確認' ? '' : exam };
}
for (const l of lines('people-add.txt')) {
  const [id, n] = l.split('|');
  people[id] = { n, al: [], s: '', g: '補完人物（関係資料で追加・人物情報は未補完）', w: '', x: '', add: true };
}

// ---------- 関係 ----------
const evtIds = new Set(events.map((e) => e.id));
const pe = lines('rel-person-event.txt').map((l) => {
  const [p, e, role, note] = l.split('|');
  if (!people[p]) err(`人物―出来事：人物IDがない ${p}`);
  if (!evtIds.has(evtId(e))) err(`人物―出来事：出来事がない ${e}`);
  return [p, evtId(e), role, note];
});
const ps = lines('rel-person-spot.txt').map((l) => {
  const [p, s, role, period, cls, ref, note] = l.split('|');
  if (!people[p]) err(`人物―スポット：人物IDがない ${p}`);
  if (!spotById.has(sptId(s))) err(`人物―スポット：スポットがない ${s}`);
  if (!'ABLH'.includes(cls) || cls.length !== 1) err(`人物―スポット：区分が不正 ${cls}`);
  if (!(refs[ref] || evtIds.has(ref) || spotById.has(ref))) err(`人物―スポット：根拠参照が不明 ${ref}`);
  return [p, sptId(s), role, period, cls, ref, note];
});
for (const e of events) {
  for (const [s] of e.spots) if (!spotById.has(s)) err(`出来事 ${e.id} のスポットがない ${s}`);
  for (const [r] of e.conf) if (!refs[r]) err(`出来事 ${e.id} の資料がない ${r}`);
}
for (const s of spots) for (const [r] of s.conf) if (!refs[r]) err(`スポット ${s.id} の資料がない ${r}`);

// ---------- 探究テーマ ----------
const themes: any[] = [];
for (const l of lines('themes.txt')) {
  if (l.startsWith('=')) {
    const [n, t, lv] = l.slice(1).split('|');
    themes.push({ id: `THM-${pad(n)}`, t, lv, q: '', p: [], e: [], s: [], steps: [], o: '', c: '' });
    continue;
  }
  const th = themes[themes.length - 1];
  const k = l.slice(0, l.indexOf(':')), v = l.slice(l.indexOf(':') + 1);
  const list = (x: string) => (x ? x.split(',') : []);
  if (k === 'Q') th.q = v;
  else if (k === 'P') th.p = list(v);
  else if (k === 'E') th.e = list(v).map(evtId);
  else if (k === 'S') th.s = list(v).map(sptId);
  else if (/^\d$/.test(k)) th.steps.push(v);
  else if (k === 'O') th.o = v;
  else if (k === 'C') th.c = v;
  else err(`テーマの行が不明: ${l}`);
}
for (const th of themes) {
  for (const p of th.p) if (!people[p]) err(`${th.id} 人物がない ${p}`);
  for (const e of th.e) if (!evtIds.has(e)) err(`${th.id} 出来事がない ${e}`);
  for (const s of th.s) if (!spotById.has(s)) err(`${th.id} スポットがない ${s}`);
}

// ---------- 天皇 ----------
const nameIndex = new Map<string, string>();
for (const [id, p] of Object.entries(people)) {
  if (!nameIndex.has(p.n)) nameIndex.set(p.n, id);
  if (p.w && !nameIndex.has(p.w)) nameIndex.set(p.w, id);
}
const emperorSecs: string[] = [];
const emperors = lines('emperors.txt').flatMap((l) => {
  if (l.startsWith('@')) { emperorSecs.push(l.slice(1)); return []; }
  const c = l.split('|');
  if (c.length !== 7) { err(`天皇の列数が不正: ${l.slice(0, 30)}`); return []; }
  const [d, n, y, life, k, ep, w] = c;
  const wk = wiki(w, n);
  return [{ d, n, y, life, k, ep, wiki: wk, sec: emperorSecs.length - 1, pid: nameIndex.get(n) ?? nameIndex.get(wk) ?? '' }];
});
// 重祚：同一人物の在位を相互に参照（資料の注記どおり 35=37、46=48）
const SAME: Record<string, string> = { '35': '37', '37': '35', '46': '48', '48': '46' };
for (const e of emperors) {
  if (!SAME[e.d]) continue;
  const o = emperors.find((x) => x.d === SAME[e.d])!;
  (e as any).same = o.d;
  if (!e.pid) e.pid = o.pid;
}

// ---------- 日本100名城®・続日本100名城® ----------
const castles = lines('castles.txt').map((l) => {
  const [n, t, pref, links] = l.split('|');
  const same: string[] = [], related: string[] = [];
  for (const x of (links ?? '').split(',').filter(Boolean)) {
    const id = x.replace(/^~/, '');
    if (!(spotById.has(id) || pilotPlaceIds.has(id))) err(`名城 ${n} の対応先がない ${id}`);
    (x.startsWith('~') ? related : same).push(id);
  }
  return { id: `JC-${String(n).padStart(3, '0')}`, n: Number(n), t, pref, same, related };
});
castles.forEach((c, i) => { if (c.n !== i + 1) err(`名城の番号が連続していない: ${c.n}`); });
const ownerOf = new Map<string, string>();
for (const c of castles) for (const id of c.same) {
  if (ownerOf.has(id)) err(`同じ対象が複数の名城に対応: ${id}`);
  ownerOf.set(id, c.id);
  const sp = spotById.get(id);
  if (sp) sp.castle = c.id;
}

// 試験運用データの人物と人物リストの対応（氏名の完全一致のみ）
const pilot: Record<string, string> = {};
for (const pp of PILOT_PEOPLE) {
  const id = nameIndex.get(pp.name);
  if (id) pilot[id] = pp.id;
}

// ---------- 件数の検査 ----------
const expect: [string, number, number][] = [
  ['出来事', events.length, 294], ['スポット', spots.length, 160], ['人物', Object.keys(people).length, 1891 + 33],
  ['人物―出来事', pe.length, 441], ['人物―スポット', ps.length, 103],
  ['出来事―スポット', events.reduce((a, e) => a + e.spots.length, 0), 208],
  ['探究テーマ', themes.length, 42], ['名城', castles.length, 200], ['天皇（行）', emperors.length, 131], ['都道府県', prefs.length, 47],
];
for (const [k, got, want] of expect) if (got !== want) err(`${k}の件数 ${got}（期待値 ${want}）`);

if (errors.length) {
  console.error(`ライブラリデータに ${errors.length} 件の問題があります:\n- ` + errors.join('\n- '));
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const lib = { version: '2026-11-01', refs, eras, events, prefs, spots, people, pe, ps, themes, emperorSecs, emperors, pilot, castles };
writeFileSync(new URL('library.json', OUT), JSON.stringify(lib));
console.log(
  `library.json を生成：${expect.map(([k, n]) => `${k}${n}`).join('・')}、座標照合済みスポット${spots.filter((s) => s.lat !== undefined).length}、天皇と人物の対応${emperors.filter((e) => e.pid).length}、試験データ人物の対応${Object.keys(pilot).length}`,
);
