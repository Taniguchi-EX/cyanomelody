import { useEffect, useState } from "react";

/** 見える範囲がこれ（px）より縮んだら、キーボードが出ているとみなす */
const KEYBOARD_MIN = 120;

/** 見える範囲（キーボードを除く）の上端と高さ */
type Visible = { top: number; height: number };

/**
 * キーボードの出ている間の、見える範囲。キーボードが出ていなければ null。
 * Android の WebView は、キーボードが出ても画面（innerHeight）が縮まず、キーボードが画面の下に重なるので、
 * 見える範囲（visualViewport）を見て、アプリの画面をその範囲に収める
 */
export function useKeyboard(): Visible | null {
  const [visible, setVisible] = useState<Visible | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      setVisible(window.innerHeight - vv.height > KEYBOARD_MIN ? { top: vv.offsetTop, height: vv.height } : null);
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return visible;
}
