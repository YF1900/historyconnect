/**
 * 端末内保存（localStorage）。
 * 保存するのは「行きたい場所」に登録した施設・スポットのIDの一覧だけ。
 * サーバーには送信されず、利用者はいつでも消去できる。
 */
const KEY = 'historyconnect:saved:v1';

export function loadSaved(): Set<string> {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string' && /^(?:[a-z0-9-]{1,64}|SPT-\d{4})$/.test(v)));
  } catch {
    return new Set();
  }
}

export function storeSaved(ids: Set<string>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // 保存できない環境（プライベートモード等）では何もしない
  }
}

export function clearAllLocalData(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // noop
  }
}
