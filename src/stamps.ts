/**
 * スタンプ帳（訪問記録）。すべてこの端末のブラウザ内（IndexedDB）にだけ保存し、外部へは送信しない。
 *
 * - 個人スタンプ：利用者が自分で押す訪問記録（訪問日・メモは任意）
 * - 公式スタンプの写真記録：日本100名城®・続日本100名城®のスタンプ帳に押した実物のスタンプを
 *   利用者が撮影した写真。私的な記録用。端末内で縮小し、位置情報などのメタデータ（EXIF）を
 *   取り除くため、画像を描き直してから保存する。
 */

export interface PersonalStamp {
  /** スタンプを押した日（端末の日付、YYYY-MM-DD） */
  at: string;
  /** 訪問日（任意、YYYY-MM-DD） */
  visited?: string;
  memo?: string;
}
export interface OfficialStamp {
  at: string;
  /** 公式スタンプを押した日（任意、YYYY-MM-DD） */
  date?: string;
  photo: Blob;
}
export interface StampRecord {
  key: string;
  personal?: PersonalStamp;
  official?: OfficialStamp;
}

const DB_NAME = 'historyconnect-stamps';
const STORE = 'stamps';
export const KEY_RE = /^(?:JC-\d{3}|SPT-\d{4}|[a-z0-9-]{1,64})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MEMO_MAX = 200;
const PHOTO_MAX_SIDE = 1200;
const INPUT_MAX_BYTES = 30 * 1024 * 1024;
const IMPORT_MAX_BYTES = 200 * 1024 * 1024;

let cache: Map<string, StampRecord> | null = null;
let loading: Promise<Map<string, StampRecord>> | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('この端末ではスタンプを保存できません（ブラウザの保存領域が使えません）。'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('スタンプの保存領域を開けませんでした。プライベートブラウズでは保存できない場合があります。'));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(r ? r.result : undefined);
        };
        t.onerror = t.onabort = () => {
          db.close();
          reject(new Error('スタンプを保存できませんでした。端末の空き容量を確認してください。'));
        };
      }),
  );
}

export function stampsLoaded(): Map<string, StampRecord> | null {
  return cache;
}

export function loadStamps(): Promise<Map<string, StampRecord>> {
  if (cache) return Promise.resolve(cache);
  loading ??= tx<StampRecord[]>('readonly', (s) => s.getAll())
    .then((all) => {
      cache = new Map((all ?? []).filter((r) => KEY_RE.test(r.key)).map((r) => [r.key, r]));
      return cache;
    })
    .catch(() => {
      cache = new Map();
      return cache;
    });
  return loading;
}

async function save(rec: StampRecord): Promise<void> {
  if (!KEY_RE.test(rec.key)) throw new Error('対象が正しくありません。');
  if (!rec.personal && !rec.official) {
    await tx('readwrite', (s) => s.delete(rec.key));
    cache?.delete(rec.key);
    return;
  }
  await tx('readwrite', (s) => s.put(rec));
  cache?.set(rec.key, rec);
}

export const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const cleanDate = (v: unknown) => (typeof v === 'string' && DATE_RE.test(v) ? v : undefined);
const cleanMemo = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MEMO_MAX) : undefined);

export async function setPersonal(key: string, visited: string, memo: string): Promise<void> {
  const cur = (await loadStamps()).get(key) ?? { key };
  await save({ ...cur, personal: { at: cur.personal?.at ?? today(), visited: cleanDate(visited), memo: cleanMemo(memo) } });
}
export async function removePersonal(key: string): Promise<void> {
  const cur = (await loadStamps()).get(key);
  if (cur) await save({ key, official: cur.official });
}
export async function setOfficial(key: string, photo: Blob, date: string): Promise<void> {
  if (!key.startsWith('JC-')) throw new Error('公式スタンプの記録は日本100名城®・続日本100名城®だけが対象です。');
  const cur = (await loadStamps()).get(key) ?? { key };
  await save({ ...cur, official: { at: today(), date: cleanDate(date), photo } });
}
export async function setOfficialDate(key: string, date: string): Promise<void> {
  const cur = (await loadStamps()).get(key);
  if (cur?.official) await save({ ...cur, official: { ...cur.official, date: cleanDate(date) } });
}
export async function removeOfficial(key: string): Promise<void> {
  const cur = (await loadStamps()).get(key);
  if (cur) await save({ key, personal: cur.personal });
}

/**
 * 写真を端末内で縮小し、JPEGに描き直す。描き直すことで撮影位置などのメタデータ（EXIF）は残らない。
 */
export async function processPhoto(file: Blob): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('画像ファイルを選んでください。');
  if (file.size > INPUT_MAX_BYTES) throw new Error('画像が大きすぎます（30MBまで）。');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('この画像は読み込めませんでした。別の写真で試してください。');
  }
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hgt = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を処理できませんでした。');
  ctx.drawImage(bmp, 0, 0, w, hgt);
  bmp.close();
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!out) throw new Error('画像を処理できませんでした。');
  return out;
}

/* ---------- 書き出し・読み込み（機種変更・バックアップ用） ---------- */

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(b);
  });
}

export async function exportStamps(): Promise<Blob> {
  const all = [...(await loadStamps()).values()];
  const stamps = await Promise.all(
    all.map(async (r) => ({
      key: r.key,
      personal: r.personal,
      official: r.official ? { at: r.official.at, date: r.official.date, photo: await blobToDataUrl(r.official.photo) } : undefined,
    })),
  );
  const doc = {
    app: 'historyconnect',
    type: 'stamps',
    version: 1,
    exportedAt: new Date().toISOString(),
    note: '個人の記録用バックアップです。公式スタンプの写真を含むため、公開・共有しないでください。',
    stamps,
  };
  return new Blob([JSON.stringify(doc)], { type: 'application/json' });
}

/** 読み込んだファイルを検査し、同じ対象の記録は読み込んだ内容で上書きする */
export async function importStamps(file: File): Promise<{ personal: number; official: number; skipped: number }> {
  if (file.size > IMPORT_MAX_BYTES) throw new Error('ファイルが大きすぎます。');
  let doc: any;
  try {
    doc = JSON.parse(await file.text());
  } catch {
    throw new Error('スタンプ帳の書き出しファイルではありません。');
  }
  if (doc?.app !== 'historyconnect' || doc?.type !== 'stamps' || doc?.version !== 1 || !Array.isArray(doc.stamps))
    throw new Error('スタンプ帳の書き出しファイルではありません。');
  await loadStamps();
  const res = { personal: 0, official: 0, skipped: 0 };
  for (const s of doc.stamps.slice(0, 2000)) {
    if (typeof s?.key !== 'string' || !KEY_RE.test(s.key)) {
      res.skipped++;
      continue;
    }
    const cur = cache!.get(s.key) ?? { key: s.key };
    const rec: StampRecord = { ...cur };
    if (s.personal && cleanDate(s.personal.at)) {
      rec.personal = { at: s.personal.at, visited: cleanDate(s.personal.visited), memo: cleanMemo(s.personal.memo) };
      res.personal++;
    }
    if (s.official && s.key.startsWith('JC-') && typeof s.official.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(s.official.photo)) {
      try {
        // data URL をその場で復号する（通信は発生しない）。描き直してから保存する
        const [head, b64] = s.official.photo.split(',', 2);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: head.slice(5, head.indexOf(';')) });
        rec.official = { at: cleanDate(s.official.at) ?? today(), date: cleanDate(s.official.date), photo: await processPhoto(blob) };
        res.official++;
      } catch {
        res.skipped++;
      }
    }
    await save(rec);
  }
  return res;
}

export async function clearStamps(): Promise<void> {
  cache = new Map();
  loading = null;
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
