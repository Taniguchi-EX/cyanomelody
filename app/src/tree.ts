/** 親を持つ節（タグ・プレイリスト）。一覧は階層の順（親の次にその子孫）に並んでいるものとする */
type TreeNode = { id: number; parentId: number | null };

/** 子を持つ節のid */
export function parentIds(nodes: TreeNode[]): Set<number> {
  return new Set(nodes.flatMap((n) => (n.parentId === null ? [] : [n.parentId])));
}

/** 節自身と、その子孫のid */
export function descendantsAndSelf(nodes: TreeNode[], id: number): Set<number> {
  const result = new Set([id]);
  // 階層の順に並んでいるので、1回なめれば足りる
  for (const n of nodes) {
    if (n.parentId !== null && result.has(n.parentId)) result.add(n.id);
  }
  return result;
}

/** たたんでいる節の子孫を除いた、表示する節 */
export function visibleNodes<T extends TreeNode>(nodes: T[], collapsed: Set<number>): T[] {
  const hidden = new Set<number>();
  return nodes.filter((n) => {
    if (n.parentId !== null && (hidden.has(n.parentId) || collapsed.has(n.parentId))) {
      hidden.add(n.id);
      return false;
    }
    return true;
  });
}

/** 左の欄の検索で、名前があてはまるか（部分一致、大文字・小文字は区別しない）。query は小文字にして渡す */
export const nameMatches = (name: string, query: string) => name.toLowerCase().includes(query);

/**
 * 左の欄の検索。名前があてはまる節と、その祖先を出す（祖先は、あてはまらなければ dimmed）。
 * たたんでいる節の中でも出す。query が空なら null（検索していない）
 */
export function searchNodes<T extends TreeNode & { name: string; synonyms?: string[] }>(
  nodes: T[],
  query: string,
): { shown: T[]; dimmed: Set<number> } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // シノニムがあれば、シノニムでも引っかける（タグ）
  const matched = new Set(
    nodes.filter((n) => nameMatches(n.name, q) || n.synonyms?.some((s) => nameMatches(s, q))).map((n) => n.id),
  );
  const keep = new Set(matched);
  for (const id of matched) {
    let parent = byId.get(id)?.parentId ?? null;
    while (parent !== null && !keep.has(parent)) {
      keep.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
  }
  return {
    shown: nodes.filter((n) => keep.has(n.id)),
    dimmed: new Set([...keep].filter((id) => !matched.has(id))),
  };
}
