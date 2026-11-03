import { useRef } from "react";

/** この距離（px）より動かしたらドラッグとみなす（クリックと区別する） */
const DRAG_THRESHOLD = 6;

/** ファイルを落とせる先：左の欄のプレイリスト（加える）とタグ（付ける） */
export type FileDropTarget = { kind: "playlists" | "tags"; id: number };

/**
 * ファイルの行を、左の欄のプレイリスト・タグへドラッグして、加える・付ける。
 * ドラッグ中は、つかんだ件数をポインタの横に出し、落とす先の行を枠で示す。「（タグなし）」の行には落とせない。
 * HTMLのドラッグアンドドロップはTauri（Windows）で動かないことがあるので、pointerイベントで作る。
 */
export function useFileDrag(onDrop: (fileIds: number[], target: FileDropTarget) => void) {
  const state = useRef<{
    x: number;
    y: number;
    ids: number[];
    ghost: HTMLElement | null;
    target: HTMLElement | null;
  } | null>(null);

  const targetAt = (x: number, y: number) =>
    document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>('[data-tree="playlists"][data-node-id], [data-tree="tags"][data-node-id]') ?? null;

  const cleanup = () => {
    const s = state.current;
    s?.ghost?.remove();
    s?.target?.classList.remove("drop-target");
    state.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  const onMove = (e: PointerEvent) => {
    const s = state.current;
    if (!s) return;
    if (!s.ghost) {
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_THRESHOLD) return;
      s.ghost = document.createElement("div");
      s.ghost.className = "drag-ghost";
      s.ghost.textContent = `♪ ${s.ids.length}`;
      document.body.appendChild(s.ghost);
    }
    s.ghost.style.left = `${e.clientX + 12}px`;
    s.ghost.style.top = `${e.clientY + 8}px`;
    const t = targetAt(e.clientX, e.clientY);
    if (t !== s.target) {
      s.target?.classList.remove("drop-target");
      t?.classList.add("drop-target");
      s.target = t;
    }
  };

  const onUp = (e: PointerEvent) => {
    const s = state.current;
    const dropped = s?.ghost ? targetAt(e.clientX, e.clientY) : null;
    const ids = s?.ids ?? [];
    cleanup();
    if (dropped) onDrop(ids, { kind: dropped.dataset.tree as FileDropTarget["kind"], id: Number(dropped.dataset.nodeId) });
  };

  /** 行で押したときに呼ぶ。ids はつかむファイル */
  const begin = (e: React.PointerEvent, ids: number[]) => {
    if (e.button !== 0) return;
    // ボタンやチェックボックスを押したときはドラッグにしない
    if ((e.target as HTMLElement).closest("button, input, label")) return;
    cleanup();
    state.current = { x: e.clientX, y: e.clientY, ids, ghost: null, target: null };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return begin;
}
