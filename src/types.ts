/** 記述の種類。確認された事実・研究上の説・伝承を混同しないために必ず付ける */
export type ClaimType = 'fact' | 'theory' | 'legend';

export interface Source {
  id: string;
  title: string;
  publisher: string;
  url: string;
  /** 出典を確認した日（YYYY-MM-DD） */
  checked: string;
  /** 掲載ページ自身の更新日・掲載日など（分かる場合のみ） */
  pageDate?: string;
}

export interface Claim {
  text: string;
  type: ClaimType;
  sourceIds: string[];
  /** 出来事の年（西暦）。年代での絞り込みに使う */
  year?: number;
  people?: string[];
  events?: string[];
}

export interface VisitInfo {
  text: string;
  sourceId: string;
}

export type PlaceKind = 'castle' | 'museum';

export interface Place {
  id: string;
  name: string;
  kana: string;
  kind: PlaceKind;
  /** 日本100名城の番号など（日本城郭協会の公式番号） */
  designations: { label: string; sourceId: string }[];
  prefecture: string;
  address: string;
  addressSourceId: string;
  lat: number;
  lng: number;
  /** 座標の求め方・精度の説明 */
  coordNote: string;
  officialUrl?: string;
  visit?: VisitInfo[];
  claims: Claim[];
}

export type PersonFactLabel = '生年' | '出身' | '没年' | '最期' | '家族' | 'エピソード';

export interface PersonFact {
  label: PersonFactLabel;
  text: string;
  type: ClaimType;
  sourceIds: string[];
}

export interface Person {
  id: string;
  name: string;
  kana: string;
  /** 出典に書かれている範囲の説明だけを記載する */
  note?: { text: string; sourceId: string };
  /** 生没年の表示用（例："1515〜1571"、不確かな年には「?」を付ける） */
  lifespan?: string;
  /** 戦いで亡くなった、または戦いが直接の原因で亡くなった場合の戦いの名前 */
  deathBattle?: { name: string; diedInBattle: boolean; sourceId: string };
  facts?: PersonFact[];
}

export interface HistEvent {
  id: string;
  name: string;
  year: number;
  summary: string;
  sourceIds: string[];
}
