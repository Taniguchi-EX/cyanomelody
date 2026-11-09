import { useEffect, useLayoutEffect, useRef, type MouseEvent } from "react";

/**
 * 押した行の、画面の上の位置を変えないようにする。
 * 左の欄で絞り込みの条件を選ぶと上に条件のチップが増え、一覧の行をチェックすると上にチェックの操作の行が出るので、
 * 押した行が下にずれる。押したときの行の位置を覚えておき、画面が変わったら、行が元の位置に来るように欄をスクロールする。
 */

/** 位置を保つ行（左の欄の各行と、中央の一覧の行・タイル） */
const ROWS = [
  "[data-testid=file-row]",
  "[data-testid=tag]",
  "[data-testid=untagged]",
  "[data-testid=playlist]",
  "[data-testid=folder]",
  "[data-testid=other]",
  "[data-testid=source]",
  "[data-testid=license]",
  "[data-testid=source-none]",
  "[data-testid=license-none]",
].join(", ");

/** 押してから位置を保つ時間（ms）。抽選など、押した後に少し遅れて画面が変わるときのため */
const KEEP_MS = 1500;

type Anchor = {
  el: HTMLElement;
  /** 行を持つスクロールする欄 */
  scroller: HTMLElement;
  /** 行の上端の、画面の上での位置 */
  top: number;
  until: number;
};

/** el を含む、縦にスクロールする欄 */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let cur = el.parentElement; cur; cur = cur.parentElement) {
    const overflow = getComputedStyle(cur).overflowY;
    if (overflow === "auto" || overflow === "scroll") return cur;
  }
  return null;
}

/**
 * 返す onClickCapture をアプリの外枠に付ける。
 * 描画するたびに（画面が変わるたびに）、押した行が元の位置に来るように欄をスクロールする
 */
export function useKeepInPlace() {
  const anchor = useRef<Anchor | null>(null);

  const onClickCapture = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(ROWS);
    const scroller = el && scrollerOf(el);
    anchor.current = el && scroller ? { el, scroller, top: el.getBoundingClientRect().top, until: Date.now() + KEEP_MS } : null;
  };

  // 描画のたびに（依存なし）：行がずれていたら、欄をスクロールして戻す
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    if (Date.now() > a.until || !a.el.isConnected) {
      anchor.current = null;
      return;
    }
    const delta = a.el.getBoundingClientRect().top - a.top;
    if (Math.abs(delta) >= 1) a.scroller.scrollTop += delta;
  });

  // 自分でスクロールし始めたら、位置を保つのをやめる（スクロールを打ち消さないように）
  useEffect(() => {
    const stop = () => (anchor.current = null);
    // 押す操作は、押し始め（pointerdown）でいったんやめ、行を押したなら click で覚え直す（スクロールバーのドラッグなど）
    window.addEventListener("pointerdown", stop, true);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("keydown", stop);
    return () => {
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("keydown", stop);
    };
  }, []);

  return onClickCapture;
}
