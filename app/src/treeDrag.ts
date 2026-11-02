import { useRef, useState } from "react";
import type { MoveTarget } from "./api";

/** ドラッグ中に、どこに落とすかの表示 */
export type Drop = { id: number; pos: "before" | "after" | "child" } | { id: null; pos: "root" };

/** この距離（px）より動かしたらドラッグとみなす */
const DRAG_THRESHOLD = 4;

type Options = {
  /** 行に付ける data-tree の値。別の木の行には落とさない */
  tree: string;
  busy: boolean;
  /** dragged を target の位置（前・後ろ・子）に落とせるか */
  canDrop: (dragged: number, target: number, pos: "before" | "after" | "child") => boolean;
  onMove: (dragged: number, target: MoveTarget) => void;
};

/**
 * 木（タグ・プレイリスト）の行を、取っ手のドラッグアンドドロップで並べ替える。
 * HTMLのドラッグアンドドロップはTauri（Windows）で動かないことがあるので、pointerイベントで作る。
 * 行には data-tree と data-node-id を、一覧の下の空いた所には data-tree-root を付ける。
 */
export function useTreeDrag({ tree, busy, canDrop, onMove }: Options) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const start = useRef<{ id: number; x: number; y: number; moving: boolean } | null>(null);

  /** ポインタの下にある、落とせる場所 */
  const dropAt = (x: number, y: number, dragged: number): Drop | null => {
    const el = document.elementFromPoint(x, y);
    if (el?.closest(`[data-tree-root="${tree}"]`)) return { id: null, pos: "root" };
    const row = el?.closest<HTMLElement>(`[data-tree="${tree}"][data-node-id]`);
    if (!row) return null;
    const id = Number(row.dataset.nodeId);
    const rect = row.getBoundingClientRect();
    const ratio = (y - rect.top) / rect.height;
    // 上の端は前、下の端は後ろ、真ん中は子の最後
    const pos = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "child";
    return canDrop(dragged, id, pos) ? { id, pos } : null;
  };

  const finish = (e: React.PointerEvent, commit: boolean) => {
    const s = start.current;
    start.current = null;
    setDragId(null);
    setDrop(null);
    if (!s?.moving || !commit) return;
    const d = dropAt(e.clientX, e.clientY, s.id);
    if (!d) return;
    onMove(s.id, d.id === null ? { kind: "root" } : { kind: d.pos, id: d.id });
  };

  /** 取っ手に付けるイベント */
  const handleProps = (id: number) => ({
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: React.PointerEvent) => {
      if (busy || e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { id, x: e.clientX, y: e.clientY, moving: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current;
      if (!s) return;
      if (!s.moving) {
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_THRESHOLD) return;
        s.moving = true;
        setDragId(s.id);
      }
      setDrop(dropAt(e.clientX, e.clientY, s.id));
    },
    onPointerUp: (e: React.PointerEvent) => finish(e, true),
    onPointerCancel: (e: React.PointerEvent) => finish(e, false),
  });

  const dropClass = (id: number) => (drop && drop.id === id ? ` drop-${drop.pos}` : "");

  return { dragId, drop, handleProps, dropClass };
}
