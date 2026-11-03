import type { PlaylistItem } from "./api";

/** 項目の元の名前（ファイル名、タグの組み合わせ、プレイリスト名） */
export function itemContent(item: PlaylistItem): string {
  if (item.kind === "file") return item.file?.relPath ?? "（ファイルなし）";
  if (item.kind === "tags") return item.tags.map((t) => t.name).join(" ＋ ");
  return item.playlist?.name ?? "（プレイリストなし）";
}
