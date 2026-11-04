import type { ChildSort } from "./api";

/** 子のタグの並び順の選び肢（設定画面の、新しく作るタグの既定値でも使う） */
export const SORTS: { value: ChildSort | ""; label: string }[] = [
  { value: "", label: "親の設定を引き継ぐ" },
  { value: "manual", label: "ドラッグで決めた順" },
  { value: "created", label: "登録順" },
  { value: "files", label: "ファイル数順" },
  { value: "romaji", label: "ローマ字順" },
];

/** 色を付けていないときに、色の選択の欄に出しておく色 */
export const DEFAULT_BG = "#e0e0e0";
export const DEFAULT_FG = "#202020";
