import { useEffect, useRef, useState } from "react";
import type { MoveTarget } from "./api";

/** ドラッグ中に、どこに落とすかの表示 */
export type Drop = { id: number; pos: "before" | "after" | "child" } | { id: null; pos: "root" };

/** この距離（px）より動かしたらドラッグとみなす */
const DRAG_THRESHOLD = 4;

type Options = {
  /** 行に付ける data-tree の値。別の木の行には落とさない */
  tree: string;
  busy: boolean;
  /** 階層のない一覧（出典・ライセンス）。子には落とさず、行の上半分は前、下半分は後ろ */
  flat?: boolean;
  /** dragged を target の位置（前・後ろ・子）に落とせるか */
  canDrop: (dragged: number, target: number, pos: "before" | "after" | "child") => boolean;
  onMove: (dragged: number, target: MoveTarget) => void;
};

/**
 * 木（タグ・プレイリスト）と一覧（出典・ライセンス）の行を、行そのもののドラッグアンドドロップで並べ替える。
 * 少し動かしてからドラッグにする（押しただけなら行を押したことになる）。行の中のボタン・入力欄からは始めない。
 * HTMLのドラッグアンドドロップはTauri（Windows）で動かないことがあるので、pointerイベントで作る。
 * 行には data-tree と data-node-id を、一覧の下の空いた所には data-tree-root を付ける。
 */
export function useTreeDrag(options: Options) {
  // window のイベントから、いつも最新の値を見る
  const opts = useRef(options);
  useEffect(() => {
    opts.current = options;
  });
  const [dragId, setDragId] = useState<number | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  /** ドラッグを終えた直後の click（同じ行の上で離したとき）を、行を押したことにしない */
  const suppressClick = useRef(false);

  /** ポインタの下にある、落とせる場所 */
  const dropAt = (x: number, y: number, dragged: number): Drop | null => {
    const { tree, flat = false, canDrop } = opts.current;
    const el = document.elementFromPoint(x, y);
    if (el?.closest(`[data-tree-root="${tree}"]`)) return { id: null, pos: "root" };
    const row = el?.closest<HTMLElement>(`[data-tree="${tree}"][data-node-id]`);
    if (!row) return null;
    const id = Number(row.dataset.nodeId);
    const rect = row.getBoundingClientRect();
    const ratio = (y - rect.top) / rect.height;
    // 上の端は前、下の端は後ろ、真ん中は子の最後（階層のない一覧は、上半分が前、下半分が後ろ）
    const pos = flat ? (ratio < 0.5 ? "before" : "after") : ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "child";
    return canDrop(dragged, id, pos) ? { id, pos } : null;
  };

  /** 行に付けるイベント */
  const rowProps = (id: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (opts.current.busy || e.button !== 0) return;
      // 開く・たたむ、✎、🗑、名前の入力欄などは、その操作だけにする
      if ((e.target as HTMLElement).closest("button, input, select, label, [role=button]")) return;
      const s = { x: e.clientX, y: e.clientY, moving: false };
      const move = (ev: PointerEvent) => {
        if (!s.moving) {
          if (Math.hypot(ev.clientX - s.x, ev.clientY - s.y) < DRAG_THRESHOLD) return;
          s.moving = true;
          setDragId(id);
        }
        setDrop(dropAt(ev.clientX, ev.clientY, id));
      };
      const end = (ev: PointerEvent, commit: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        setDragId(null);
        setDrop(null);
        if (!s.moving) return;
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
        if (!commit) return;
        const d = dropAt(ev.clientX, ev.clientY, id);
        if (d) opts.current.onMove(id, d.id === null ? { kind: "root" } : { kind: d.pos, id: d.id });
      };
      const up = (ev: PointerEvent) => end(ev, true);
      const cancel = (ev: PointerEvent) => end(ev, false);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!suppressClick.current) return;
      e.stopPropagation();
      suppressClick.current = false;
    },
  });

  const dropClass = (id: number) => (drop && drop.id === id ? ` drop-${drop.pos}` : "");

  return { dragId, drop, rowProps, dropClass };
}
