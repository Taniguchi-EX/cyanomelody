import type { Tag } from "./api";

/** 子を持つタグのid */
export function parentIds(tags: Tag[]): Set<number> {
  return new Set(tags.flatMap((t) => (t.parentId === null ? [] : [t.parentId])));
}

/** タグ自身と、その子孫のタグのid */
export function descendantsAndSelf(tags: Tag[], tagId: number): Set<number> {
  const result = new Set([tagId]);
  // tags は階層の順（親の次にその子孫）に並んでいるので、1回なめれば足りる
  for (const t of tags) {
    if (t.parentId !== null && result.has(t.parentId)) result.add(t.id);
  }
  return result;
}

/** たたんでいるタグの子孫を除いた、表示するタグ */
export function visibleTags(tags: Tag[], collapsed: Set<number>): Tag[] {
  const hidden = new Set<number>();
  return tags.filter((t) => {
    if (t.parentId !== null && (hidden.has(t.parentId) || collapsed.has(t.parentId))) {
      hidden.add(t.id);
      return false;
    }
    return true;
  });
}
