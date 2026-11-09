import { useRef } from "react";

/** この距離（px）より動かしたらドラッグとみなす（クリックと区別する） */
const DRAG_THRESHOLD = 6;

/** ファイルを落とせる先：左の欄のプレイリスト（加える）、タグ（付ける）、出典・ライセンス（設定する） */
export type FileDropTarget = { kind: "playlists" | "tags" | "source" | "license"; id: number };

/**
 * 同じドラッグで、つかんだ所の中での並べ替えもするとき（プレイリストの項目）。
 * ポインタの下が並べ替えの落とす先なら、左の欄には落とさず、並べ替えにする
 */
export type LocalDrop = {
  /** ポインタの下が並べ替えの落とす先か（落とす先の表示もここで行う） */
  over: (x: number, y: number) => boolean;
  drop: (x: number, y: number) => void;
  /** ドラッグの終わり（表示を消す） */
  end: () => void;
};

const TARGETS = (["playlists", "tags", "source", "license"] as const)
  .map((kind) => `[data-tree="${kind}"][data-node-id]`)
  .join(", ");

/**
 * ファイルの行を、左の欄のプレイリスト・タグ・出典・ライセンスへドラッグして、加える・付ける・設定する。
 * ドラッグ中は、つかんだ件数をポインタの横に出し、落とす先の行を枠で示す。「（タグなし）」などの「なし」の行には落とせない。
 * HTMLのドラッグアンドドロップはTauri（Windows）で動かないことがあるので、pointerイベントで作る。
 */
export function useFileDrag(onDrop: (ids: number[], target: FileDropTarget) => void) {
  const state = useRef<{
    x: number;
    y: number;
    ids: number[];
    local: LocalDrop | undefined;
    ghost: HTMLElement | null;
    target: HTMLElement | null;
  } | null>(null);

  const targetAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>(TARGETS) ?? null;

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
    // 並べ替えの落とす先の上では、件数を出さず、左の欄の行も示さない
    const local = s.local?.over(e.clientX, e.clientY) ?? false;
    s.ghost.style.display = local ? "none" : "";
    const t = local ? null : targetAt(e.clientX, e.clientY);
    if (t !== s.target) {
      s.target?.classList.remove("drop-target");
      t?.classList.add("drop-target");
      s.target = t;
    }
  };

  const onUp = (e: PointerEvent) => {
    const s = state.current;
    const moved = !!s?.ghost;
    const local = moved && s?.local ? s.local.over(e.clientX, e.clientY) : false;
    const dropped = moved && !local ? targetAt(e.clientX, e.clientY) : null;
    const ids = s?.ids ?? [];
    s?.local?.end();
    cleanup();
    if (local) s?.local?.drop(e.clientX, e.clientY);
    else if (dropped) onDrop(ids, { kind: dropped.dataset.tree as FileDropTarget["kind"], id: Number(dropped.dataset.nodeId) });
  };

  /** 行で押したときに呼ぶ。ids はつかむファイル。local は、同じドラッグでの並べ替え */
  const begin = (e: React.PointerEvent, ids: number[], local?: LocalDrop) => {
    if (e.button !== 0) return;
    // ボタン・チェックボックス・プルダウンを押したときはドラッグにしない
    if ((e.target as HTMLElement).closest("button, input, label, select")) return;
    cleanup();
    state.current = { x: e.clientX, y: e.clientY, ids, local, ghost: null, target: null };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return begin;
}
