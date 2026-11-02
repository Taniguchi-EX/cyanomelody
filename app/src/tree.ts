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
