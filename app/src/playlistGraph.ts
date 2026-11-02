import type { PlaylistNode } from "./api";

/** from から項目（子・参照）をたどって行けるプレイリスト（from 自身を含む） */
export function reachable(nodes: PlaylistNode[], from: number): Set<number> {
  const refs = new Map(nodes.map((n) => [n.id, n.refs]));
  const seen = new Set<number>([from]);
  const stack = [from];
  while (stack.length > 0) {
    for (const r of refs.get(stack.pop()!) ?? []) {
      if (!seen.has(r)) {
        seen.add(r);
        stack.push(r);
      }
    }
  }
  return seen;
}

/** container の中に playlist を入れるとループになるか */
export function makesLoop(nodes: PlaylistNode[], container: number, playlist: number): boolean {
  return reachable(nodes, playlist).has(container);
}
