/** 2点間の距離（km）。計算は端末内だけで行う */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatKm(km: number): string {
  if (km < 1) return `約${Math.round(km * 1000)}m`;
  if (km < 10) return `約${km.toFixed(1)}km`;
  return `約${Math.round(km)}km`;
}

/**
 * 現在地を1回だけ取得する。
 * 位置情報は呼び出し元のメモリ上でのみ使い、保存・送信はしない。
 */
export function getCurrentPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('この端末・ブラウザでは現在地を取得できません。'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? '現在地の利用が許可されませんでした。地図を動かして探すこともできます。'
            : '現在地を取得できませんでした。電波の良い場所で再度お試しください。';
        reject(new Error(msg));
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
    );
  });
}

/**
 * 現在地を追い続ける（「現在地を追う」をオンにしている間だけ）。
 * 位置は端末のメモリ上でのみ使い、保存・送信はしない。戻り値の関数で停止する。
 */
export function watchPosition(
  onPos: (p: { lat: number; lng: number; acc: number }) => void,
  onErr: (msg: string) => void,
): () => void {
  if (!('geolocation' in navigator)) {
    onErr('この端末・ブラウザでは現在地を取得できません。');
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onPos({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
    (err) =>
      onErr(
        err.code === err.PERMISSION_DENIED
          ? '現在地の利用が許可されませんでした。ブラウザの設定で許可すると使えます。'
          : '現在地を取得できませんでした。電波の良い場所で再度お試しください。',
      ),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}
