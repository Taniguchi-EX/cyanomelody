/** 中央の一覧の並び順と、再生方法の選び肢 */
import type { FileSort, PlayMode } from "./types";

/** ライブラリの並び順のプルダウンの選び肢。同じ値どうしはパス順 */
export const FILE_SORTS: { value: string; sort: FileSort; desc: boolean; label: string }[] = [
  { value: "path", sort: "path", desc: false, label: "パス順" },
  { value: "name", sort: "name", desc: false, label: "ファイル名順" },
  { value: "added-desc", sort: "added", desc: true, label: "追加した順（新しい順）" },
  { value: "added", sort: "added", desc: false, label: "追加した順（古い順）" },
  { value: "modified-desc", sort: "modified", desc: true, label: "更新日時順（新しい順）" },
  { value: "duration", sort: "duration", desc: false, label: "長さ順（短い順）" },
  { value: "duration-desc", sort: "duration", desc: true, label: "長さ順（長い順）" },
];

/** プレイリストを選んでいるときの並び順のプルダウンの選び肢。最初は「プレイリストの順」（抽選した順） */
export const PLAYLIST_SORTS: typeof FILE_SORTS = [
  { value: "playlist", sort: "playlist", desc: false, label: "プレイリストの順" },
  ...FILE_SORTS,
];

export const PLAY_MODES: { mode: PlayMode; icon: string; label: string; short: string }[] = [
  { mode: "order", icon: "▶", label: "順に再生", short: "順に" },
  { mode: "shuffle", icon: "🔀", label: "シャッフル再生", short: "シャッフル" },
  { mode: "random", icon: "🎲", label: "ランダムセレクト再生", short: "1曲" },
];
