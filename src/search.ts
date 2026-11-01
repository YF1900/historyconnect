/**
 * 端末内だけで行う簡単な全文検索。
 * 入力した言葉は外部に送信せず、保存もしない。
 */
import { EVENTS, PEOPLE, PLACES } from './data';
import type { HistEvent, Person, Place } from './types';

/** 全角・半角、カタカナ・ひらがな、大文字・小文字の違いを吸収する */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '');
}

interface Entry<T> {
  item: T;
  title: string;
  /** 名前・よみ（ここに一致すると上位に表示） */
  key: string;
  /** 説明文など */
  body: string;
}

const placeIndex: Entry<Place>[] = PLACES.map((p) => ({
  item: p,
  title: p.name,
  key: normalize(`${p.name}${p.kana}`),
  body: normalize([p.prefecture, p.address, ...p.designations.map((d) => d.label), ...p.claims.map((c) => c.text)].join(' ')),
}));

const personIndex: Entry<Person>[] = PEOPLE.map((p) => ({
  item: p,
  title: p.name,
  key: normalize(`${p.name}${p.kana}`),
  body: normalize([p.note?.text ?? '', p.lifespan ?? '', ...(p.facts ?? []).map((f) => f.text)].join(' ')),
}));

const eventIndex: Entry<HistEvent>[] = EVENTS.map((e) => ({
  item: e,
  title: e.name,
  key: normalize(`${e.name}${e.year}`),
  body: normalize(e.summary),
}));

export interface Hit<T> {
  item: T;
  /** 名前に一致したか（false なら本文の一致） */
  nameMatch: boolean;
  /** 本文中の一致箇所の前後（表示用） */
  snippet?: string;
}

function find<T>(index: Entry<T>[], raw: string, sourceTexts: (item: T) => string[]): Hit<T>[] {
  // 空白で区切った言葉をすべて含むものを探す（AND検索）
  const words = raw
    .split(/[\s　]+/)
    .map(normalize)
    .filter(Boolean);
  if (!words.length) return [];
  const hits: Hit<T>[] = [];
  for (const e of index) {
    const all = e.key + e.body;
    if (!words.every((w) => all.includes(w))) continue;
    const nameMatch = words.every((w) => e.key.includes(w));
    let snippet: string | undefined;
    if (!nameMatch) {
      const w = words.find((x) => !e.key.includes(x)) ?? words[0];
      const text = sourceTexts(e.item).find((t) => normalize(t).includes(w));
      if (text) snippet = text.length > 70 ? `${text.slice(0, 70)}…` : text;
    }
    hits.push({ item: e.item, nameMatch, snippet });
  }
  return hits.sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch));
}

export function search(raw: string) {
  const q = raw.slice(0, 100);
  return {
    places: find(placeIndex, q, (p) => [p.address, ...p.claims.map((c) => c.text)]),
    people: find(personIndex, q, (p) => [p.note?.text ?? '', ...(p.facts ?? []).map((f) => f.text)]),
    events: find(eventIndex, q, (e) => [e.summary]),
  };
}

/** 入力の手がかりとして表示する例 */
export const EXAMPLES = ['北条', '1590', '切腹', '八王子', '夜戦', '尾張'];
