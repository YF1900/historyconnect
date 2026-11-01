/**
 * データの整合性チェック（npm run check-data）
 * - 参照している出典・人物・出来事がすべて定義されているか
 * - すべての記述に出典が付いているか
 * - IDの形式が正しいか
 */
import { EVENTS, PEOPLE, PLACES, SOURCES } from '../src/data.ts';

const errors: string[] = [];
const src = new Set(SOURCES.map((s) => s.id));
const ppl = new Set(PEOPLE.map((p) => p.id));
const evs = new Set(EVENTS.map((e) => e.id));
const idOk = (id: string) => /^[a-z0-9-]{1,64}$/.test(id);

for (const s of SOURCES) if (!/^https:\/\//.test(s.url)) errors.push(`出典 ${s.id} のURLが https ではありません`);
for (const e of EVENTS) for (const s of e.sourceIds) if (!src.has(s)) errors.push(`出来事 ${e.id}: 出典 ${s} が未定義`);
for (const p of PEOPLE) {
  if (p.note && !src.has(p.note.sourceId)) errors.push(`人物 ${p.id}: 出典 ${p.note.sourceId} が未定義`);
  if (p.deathBattle && !src.has(p.deathBattle.sourceId)) errors.push(`人物 ${p.id}: 最期の出典が未定義`);
  for (const f of p.facts ?? []) {
    if (!f.sourceIds.length) errors.push(`人物 ${p.id}: 「${f.label}」に出典がありません`);
    for (const s of f.sourceIds) if (!src.has(s)) errors.push(`人物 ${p.id}: 出典 ${s} が未定義`);
  }
}

const seen = new Set<string>();
for (const p of PLACES) {
  if (!idOk(p.id)) errors.push(`施設ID ${p.id} の形式が不正`);
  if (seen.has(p.id)) errors.push(`施設ID ${p.id} が重複`);
  seen.add(p.id);
  if (!src.has(p.addressSourceId)) errors.push(`${p.id}: 所在地の出典 ${p.addressSourceId} が未定義`);
  for (const d of p.designations) if (!src.has(d.sourceId)) errors.push(`${p.id}: 指定の出典 ${d.sourceId} が未定義`);
  for (const v of p.visit ?? []) if (!src.has(v.sourceId)) errors.push(`${p.id}: 訪問情報の出典 ${v.sourceId} が未定義`);
  if (Number.isFinite(p.lat) !== Number.isFinite(p.lng)) errors.push(`${p.id}: 緯度・経度の片方だけが設定されています`);
  if (Number.isFinite(p.lat) && (p.lat < 20 || p.lat > 46 || p.lng < 122 || p.lng > 154))
    errors.push(`${p.id}: 座標が日本の範囲外です`);
  p.claims.forEach((c, i) => {
    if (!c.sourceIds.length) errors.push(`${p.id} 記述${i + 1}: 出典がありません`);
    for (const s of c.sourceIds) if (!src.has(s)) errors.push(`${p.id} 記述${i + 1}: 出典 ${s} が未定義`);
    for (const x of c.people ?? []) if (!ppl.has(x)) errors.push(`${p.id} 記述${i + 1}: 人物 ${x} が未定義`);
    for (const x of c.events ?? []) if (!evs.has(x)) errors.push(`${p.id} 記述${i + 1}: 出来事 ${x} が未定義`);
  });
}

const located = PLACES.filter((p) => Number.isFinite(p.lat)).length;
console.log(`施設 ${PLACES.length}件（地図位置確認済み ${located}件）、人物 ${PEOPLE.length}名、出来事 ${EVENTS.length}件、出典 ${SOURCES.length}件`);
if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log('✓ データの整合性に問題はありません');
