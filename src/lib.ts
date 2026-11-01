/**
 * 全国データ（出来事・歴史スポット・人物・関係・探究テーマ・歴代天皇）。
 * public/data/library.json を同じサイトから一度だけ読み込む（外部送信なし）。
 * 元資料：プロジェクトの追加コンテキスト（版1.0、2026-11-01）。scripts/build-library.ts で変換・検査。
 */

export interface LibRef { t: string; u: string; s: string }
export interface LibEvent {
  id: string; era: number; date: string; y: number; t: string; field: string; region: string;
  actors: string[]; focus: string; note: string; spots: [string, string][]; conf: [string, string][]; wiki: string;
}
export interface LibSpot {
  id: string; pref: string; city: string; t: string; kind: string; era: string; meaning: string;
  conf: [string, string][]; wiki: string; place?: string; castle?: string;
  lat?: number; lng?: number; coord?: { src: string; url: string; checked: string; memo: string };
}
/** 日本100名城®（1〜100）・続日本100名城®（101〜200） */
export interface LibCastle { id: string; n: number; t: string; pref: string; same: string[]; related: string[] }
export interface LibPerson { n: string; al: string[]; s: string; g: string; w: string; x: string; add?: boolean }
export interface LibTheme { id: string; t: string; lv: string; q: string; p: string[]; e: string[]; s: string[]; steps: string[]; o: string; c: string }
export interface LibEmperor { d: string; n: string; y: string; life: string; k: string; ep: string; wiki: string; sec: number; pid: string; same?: string }
/** [人物ID, 出来事ID, 役割, 注記] */
export type PE = [string, string, string, string];
/** [人物ID, スポットID, 役割, 時期, 区分, 根拠参照, 注意] */
export type PS = [string, string, string, string, 'A' | 'B' | 'L' | 'H', string, string];

export interface Library {
  version: string;
  refs: Record<string, LibRef>;
  eras: string[];
  events: LibEvent[];
  prefs: string[];
  spots: LibSpot[];
  people: Record<string, LibPerson>;
  pe: PE[];
  ps: PS[];
  themes: LibTheme[];
  emperorSecs: string[];
  emperors: LibEmperor[];
  /** 人物リストのID → 試験運用データの人物ID */
  pilot: Record<string, string>;
  castles: LibCastle[];
  // 以下は読み込み後に作る索引
  eventById: Map<string, LibEvent>;
  spotById: Map<string, LibSpot>;
  peByPerson: Map<string, PE[]>;
  peByEvent: Map<string, PE[]>;
  psByPerson: Map<string, PS[]>;
  psBySpot: Map<string, PS[]>;
  eventsBySpot: Map<string, { ev: LibEvent; rel: string }[]>;
  emperorByPerson: Map<string, LibEmperor[]>;
  pilotReverse: Map<string, string>;
  themeById: Map<string, LibTheme>;
  castleById: Map<string, LibCastle>;
  /** スポット・施設のID → 同じ対象の名城ID */
  castleOf: Map<string, string>;
}

let lib: Library | null = null;
let loading: Promise<Library> | null = null;

export function getLibrary(): Library | null {
  return lib;
}

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function loadLibrary(): Promise<Library> {
  if (lib) return Promise.resolve(lib);
  if (!loading) {
    loading = fetch('./data/library.json', { credentials: 'omit' })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((raw: Library) => {
        raw.eventById = new Map(raw.events.map((e) => [e.id, e]));
        raw.spotById = new Map(raw.spots.map((s) => [s.id, s]));
        raw.peByPerson = group(raw.pe, (r) => r[0]);
        raw.peByEvent = group(raw.pe, (r) => r[1]);
        raw.psByPerson = group(raw.ps, (r) => r[0]);
        raw.psBySpot = group(raw.ps, (r) => r[1]);
        raw.eventsBySpot = new Map();
        for (const ev of raw.events)
          for (const [sid, rel] of ev.spots) {
            const arr = raw.eventsBySpot.get(sid) ?? [];
            arr.push({ ev, rel });
            raw.eventsBySpot.set(sid, arr);
          }
        raw.emperorByPerson = group(raw.emperors.filter((e) => e.pid), (e) => e.pid);
        raw.pilotReverse = new Map(Object.entries(raw.pilot).map(([k, v]) => [v, k]));
        raw.themeById = new Map(raw.themes.map((t) => [t.id, t]));
        raw.castleById = new Map(raw.castles.map((c) => [c.id, c]));
        raw.castleOf = new Map(raw.castles.flatMap((c) => c.same.map((id) => [id, c.id] as [string, string])));
        lib = raw;
        return raw;
      })
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

/* ---------- 確認状況の表示ラベル（資料の指示に沿う） ---------- */

export const PS_CLASS: Record<PS[4], { label: string; help: string }> = {
  A: { label: '公式資料で確認', help: '公式資料で関係を個別に確認。記載された役割の範囲で表示しています。' },
  B: { label: '編集整理・未照合', help: '既存データと歴史知識による編集上の整理です。個別の根拠史料・公式資料との照合はまだ終わっていません。' },
  L: { label: '学習上の関連', help: '後世の施設を含む学習上のつながりです。本人の訪問・居住・活動場所という意味ではありません。' },
  H: { label: '説・比定', help: '比定・学説・陵墓の治定などに関する関連です。確定した所在地・被葬者ではありません。' },
};

export const PE_DEFAULT_ROLE = '関連人物として登録（具体的な役割は未確認）';

export function eventStatus(e: LibEvent): { cls: string; label: string } {
  return e.conf.length
    ? { cls: 'st-checked', label: '確認補助資料あり（記載の論点のみ）' }
    : { cls: 'st-unchecked', label: '編集整理・未照合' };
}

export function wikiUrl(title: string): string {
  return `https://ja.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

export function personName(l: Library, id: string): string {
  return l.people[id]?.n ?? id;
}

export const castleSeries = (c: LibCastle) => (c.n <= 100 ? '日本100名城®' : '続日本100名城®');
export const CASTLE_LIST_URL = {
  main: 'https://jokaku.jp/business/great-castles/',
  sequel: 'https://jokaku.jp/business/great-castles-sequel/',
};
