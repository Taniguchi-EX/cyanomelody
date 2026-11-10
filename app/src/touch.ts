/**
 * 指での操作（Android）の共通の決まり。
 * 指で触ったとき、並べ替えのドラッグやチェックは長押ししてから始める（すぐに動かしたらスクロール）。
 * ドラッグを始めた後は、指の動きでスクロールしないように止める
 */

/** 長押しとみなすまでの時間（ミリ秒） */
export const LONG_PRESS_MS = 350;
/** 長押しの間に、この距離（px）より動いたらスクロールとみなし、長押しをやめる */
export const HOLD_SLOP = 8;

let locks = 0;
const stopTouchMove = (e: TouchEvent) => e.preventDefault();

/**
 * 指の動きでスクロールしないようにする（ドラッグの間）。戻すための関数を返す。
 * React の onTouchMove は passive で止められないので、document に passive: false で登録する
 */
export function lockTouchScroll(): () => void {
  if (locks++ === 0) document.addEventListener("touchmove", stopTouchMove, { passive: false });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0) document.removeEventListener("touchmove", stopTouchMove);
  };
}

/**
 * 指で押したとき、長押しを待つ。HOLD_SLOP より動くか指を離したらやめる（onHold は呼ばない）。
 * 長押しになったら onHold を呼ぶ。待つのをやめる関数を返す
 */
export function waitForHold(start: { clientX: number; clientY: number }, onHold: () => void): () => void {
  const x = start.clientX;
  const y = start.clientY;
  const timer = window.setTimeout(() => {
    stop();
    onHold();
  }, LONG_PRESS_MS);
  const move = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - x, e.clientY - y) > HOLD_SLOP) stop();
  };
  const stop = () => {
    window.clearTimeout(timer);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  return stop;
}
