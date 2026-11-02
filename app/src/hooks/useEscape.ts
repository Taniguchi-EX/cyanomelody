import { useEffect, useRef } from "react";

/**
 * Escキーで handler を呼ぶ。フォーカスがどこにあっても効く（重ねて表示する画面を閉じるのに使う）。
 * 入力欄などでEscを別の意味（入力をやめるなど）に使うときは、その入力欄で stopPropagation してここに届かせない。
 */
export function useEscape(handler: () => void) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
