import { useSyncExternalStore } from "react";

/** 設定画面の「表示」で決めるもの。画面の設定として localStorage に持つ（アプリを閉じても覚えておく） */
export type DisplaySettings = {
  /** 文字の大きさの倍率（1 が標準） */
  textScale: number;
  /** 文字のフォント（CSS の font-family に書く値。"" は標準） */
  font: string;
  /** グリッドで横に並べるカードの数（欄が狭くて入らないときは減らす） */
  gridColumns: number;
  /** ファイル名の拡張子を省いて出す */
  hideExtension: boolean;
};

export const DISPLAY_DEFAULTS: DisplaySettings = { textScale: 1, font: "", gridColumns: 6, hideExtension: false };

/** 文字の大きさの選び肢 */
export const TEXT_SCALES = [
  { value: 0.9, label: "小" },
  { value: 1, label: "標準" },
  { value: 1.15, label: "大" },
  { value: 1.3, label: "特大" },
];

/** フォントのファミリ名を、CSS の font-family に書く値にする（名前を引用符でくくる） */
export const fontValue = (family: string) => `"${family.replace(/["\\]/g, "")}"`;

/** グリッドで横に並べるカードの数の選び肢 */
export const GRID_COLUMNS = [3, 4, 5, 6, 7, 8, 10];

const KEY = "cyanomelody.display";
const listeners = new Set<() => void>();
let cache: DisplaySettings | null = null;

function read(): DisplaySettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = { ...DISPLAY_DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<DisplaySettings>) : {}) };
  } catch {
    cache = { ...DISPLAY_DEFAULTS };
  }
  return cache;
}

/** 表示の設定を変えて保存し、使っている画面に知らせる */
export function setDisplay(change: Partial<DisplaySettings>) {
  cache = { ...read(), ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // 覚えておけなくても、今の画面には効く
  }
  applyDisplay(cache);
  for (const l of listeners) l();
}

/** 文字の大きさとフォントを、画面全体（CSS の変数）に当てる */
export function applyDisplay(s: DisplaySettings = read()) {
  const root = document.documentElement.style;
  root.setProperty("--text-scale", String(s.textScale));
  if (s.font) root.setProperty("--font-family", s.font);
  else root.removeProperty("--font-family");
}

/** 表示の設定（変わると描き直す） */
export function useDisplay(): DisplaySettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
  );
}

/** 表示の設定の localStorage のキー（データのエクスポートの画面の設定に含める） */
export const DISPLAY_KEY = KEY;
