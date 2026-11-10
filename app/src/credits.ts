import type { CreditKind, Terms } from "./api";

export const CREDIT_LABEL: Record<CreditKind, string> = {
  source: "出典",
  license: "ライセンス",
};

type TermDef = {
  key: keyof Terms;
  label: string;
  /** true・false のときの言い方 */
  yes: string;
  no: string;
  /** 一覧での短い表示に使う名前 */
  short: string;
  /** 絞り込みの欄に出す記号 */
  icon: string;
  /** 自由に使いやすい側の値（緑で出す） */
  free: boolean;
};

/** 条項の並びと言い方 */
export const TERM_DEFS: TermDef[] = [
  { key: "commercial", label: "商用利用", yes: "可", no: "不可", short: "商用", icon: "¥", free: true },
  { key: "credit", label: "クレジット表記", yes: "必要", no: "不要", short: "表記", icon: "©", free: false },
  { key: "modify", label: "改変", yes: "可", no: "不可", short: "改変", icon: "✎", free: true },
  { key: "redistribute", label: "再配布", yes: "可", no: "不可", short: "再配布", icon: "⇆", free: true },
  { key: "shareAlike", label: "継承", yes: "必要", no: "不要", short: "継承", icon: "↺", free: false },
];

export const UNKNOWN_TERMS: Terms = {
  commercial: null,
  credit: null,
  modify: null,
  redistribute: null,
  shareAlike: null,
};

export function termValueLabel(def: TermDef, value: boolean | null): string {
  if (value === null) return "不明";
  return value ? def.yes : def.no;
}

/** 「商用可」「表記要」「改変？」のような短い表示 */
export function shortTerm(def: TermDef, value: boolean | null): string {
  if (value === null) return `${def.short}？`;
  const word = value ? def.yes : def.no;
  return def.short + word.replace("必要", "要");
}

/** 条項の値の色分け。使いやすい側は free、制約になる側は bound、不明は unknown */
export function termState(def: TermDef, value: boolean | null): "free" | "bound" | "unknown" {
  if (value === null) return "unknown";
  return value === def.free ? "free" : "bound";
}

/** ブラウザで開けるURLか */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** 出典・ライセンスの欄を並べる順 */
export const CREDIT_KINDS: CreditKind[] = ["source", "license"];
