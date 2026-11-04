import type { CSSProperties } from "react";
import type { Tag } from "./api";

/** タグのチップの色（表示の色。親から引き継いだ色を含む）。色がなければ undefined */
export function tagStyle(tag: Pick<Tag, "shownBgColor" | "shownFgColor"> | undefined): CSSProperties | undefined {
  if (!tag || (!tag.shownBgColor && !tag.shownFgColor)) return undefined;
  const bg = tag.shownBgColor ?? undefined;
  // 背景色があるときは、枠も同じ色にする
  return { background: bg, borderColor: bg, color: tag.shownFgColor ?? undefined };
}

/** タグのidから、チップの色を引く表 */
export function tagStyleMap(tags: Tag[]): Map<number, CSSProperties> {
  return new Map(tags.flatMap((t) => {
    const style = tagStyle(t);
    return style ? [[t.id, style] as const] : [];
  }));
}
