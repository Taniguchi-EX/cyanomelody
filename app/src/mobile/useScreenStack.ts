import { useCallback, useEffect, useRef, useState } from "react";

/** Android の動的エリアに出す画面 */
export type Screen =
  | { kind: "list" }
  | { kind: "filter" }
  | { kind: "detail" }
  | { kind: "bulk" }
  | { kind: "editor" }
  | { kind: "player" };

/**
 * 動的エリアの画面の積み重ね。画面を開くたびにブラウザの履歴に積み、端末の戻る操作（popstate）で1つ戻る。
 * 一番下はファイルの一覧。一覧で戻る操作をすると、履歴が尽きてアプリが閉じる（Android の決まり）
 */
export function useScreenStack() {
  const [stack, setStack] = useState<Screen[]>([{ kind: "list" }]);
  // 押したときの処理から、今の積み重ねを読む
  const stackRef = useRef(stack);
  useEffect(() => {
    stackRef.current = stack;
  }, [stack]);

  useEffect(() => {
    history.replaceState({ depth: 0 }, "");
    const onPop = (e: PopStateEvent) => {
      const depth = (e.state as { depth?: number } | null)?.depth ?? 0;
      setStack((s) => s.slice(0, depth + 1));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /** 画面を開く（今の画面と同じ種類なら開かない） */
  const push = useCallback((screen: Screen) => {
    const s = stackRef.current;
    if (s[s.length - 1].kind === screen.kind) return;
    history.pushState({ depth: s.length }, "");
    setStack([...s, screen]);
  }, []);

  /** 1つ戻る（端末の戻る操作と同じ） */
  const back = useCallback(() => {
    if (stackRef.current.length > 1) history.back();
  }, []);

  /** kind の画面が開いていたら、それより上を閉じてその前の画面に戻る */
  const close = useCallback((kind: Screen["kind"]) => {
    const s = stackRef.current;
    const i = s.findIndex((x) => x.kind === kind);
    if (i > 0) history.go(i - s.length);
  }, []);

  return { stack, top: stack[stack.length - 1], push, back, close };
}
