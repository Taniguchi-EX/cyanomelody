import { PLAY_MODES, type AudioFile, type PlaylistItem } from "./api";

/** 項目の元の名前（ファイル名、タグの組み合わせ、プレイリスト名） */
export function itemContent(item: PlaylistItem): string {
  if (item.kind === "file") return item.file?.relPath ?? "（ファイルなし）";
  if (item.kind === "tags") return item.tags.map((t) => t.name).join(" ＋ ");
  return item.playlist?.name ?? "（プレイリストなし）";
}

/** 中央の一覧の行が来た項目の説明（行のアイコンにマウスを乗せたときに出す）。ファイルの項目から来た行は空 */
export function originText(f: AudioFile): string {
  if (!f.origin) return "";
  const mode = PLAY_MODES.find((m) => m.mode === f.origin!.mode);
  const what = f.origin.kind === "tags" ? "タグの組み合わせ" : "プレイリスト";
  return `${what}「${f.origin.label}」（${mode ? `${mode.icon} ${mode.short}` : ""}）から`;
}
