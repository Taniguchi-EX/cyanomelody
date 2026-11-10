import { useEffect, useRef, useState } from "react";

/**
 * Android の画面の試作（Tauri の Android の WebView で思ったとおりに動くかを確かめる。本実装では作り直す）。
 * 1. 端末の戻る操作で、履歴に積んだ画面を戻せるか
 * 2. セーフエリア（ステータスバー・ナビゲーションバー）の大きさを取れるか
 * 3. 長押ししてからのドラッグと、下へのスワイプが動くか（スクロールとぶつからないか）
 */
export function MobileProto() {
  const [log, setLog] = useState<string[]>([]);
  const write = (s: string) => setLog((l) => [...l.slice(-30), `${new Date().toLocaleTimeString()} ${s}`]);
  // 1. 戻る：画面の番号を履歴に積む
  const [screen, setScreen] = useState(0);
  useEffect(() => {
    history.replaceState({ screen: 0 }, "");
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as { screen?: number } | null)?.screen ?? 0;
      setScreen(s);
      setLog((l) => [...l, `popstate → 画面 ${s}`]);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (s: number) => {
    history.pushState({ screen: s }, "");
    setScreen(s);
    write(`push → 画面 ${s}（履歴 ${history.length}）`);
  };

  // 2. セーフエリア
  const probe = useRef<HTMLDivElement>(null);
  const [insets, setInsets] = useState("");
  useEffect(() => {
    const el = probe.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    setInsets(
      `top ${cs.paddingTop} / bottom ${cs.paddingBottom} / left ${cs.paddingLeft} / right ${cs.paddingRight}、` +
        `画面 ${window.innerWidth}×${window.innerHeight}、dpr ${window.devicePixelRatio}`,
    );
  }, []);

  // 3. 長押ししてからのドラッグ
  const [items, setItems] = useState(["項目A", "項目B", "項目C", "項目D", "項目E", "項目F"]);
  const [dragging, setDragging] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const dragFrom = useRef<number | null>(null);
  const moves = useRef(0);
  // 長押しが決まった後の指の動きは、スクロールにさせない（touchmove を止める。React の onTouchMove は passive で止められないので、直に登録する）
  const listRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (dragFrom.current !== null) e.preventDefault();
    };
    el.addEventListener("touchmove", stop, { passive: false });
    return () => el.removeEventListener("touchmove", stop);
  }, []);
  const onDown = (i: number) => (e: React.PointerEvent) => {
    start.current = { x: e.clientX, y: e.clientY };
    const target = e.currentTarget as HTMLElement;
    const id = e.pointerId;
    timer.current = window.setTimeout(() => {
      dragFrom.current = i;
      setDragging(i);
      target.setPointerCapture(id);
      write(`長押し → ドラッグ開始 ${items[i]}`);
    }, 350);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragFrom.current === null) {
      // 長押しの前に動いたら、スクロールとみなして長押しをやめる
      const s0 = start.current;
      if (timer.current !== null && s0 && Math.hypot(e.clientX - s0.x, e.clientY - s0.y) > 8) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      return;
    }
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-proto-item]");
    const to = over ? Number(over.dataset.protoItem) : null;
    moves.current += 1;
    if (moves.current % 5 === 1) write(`move y=${Math.round(e.clientY)} to=${to}`);
    if (to !== null && to !== dragFrom.current) {
      const from = dragFrom.current;
      setItems((list) => {
        const next = [...list];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
      dragFrom.current = to;
      setDragging(to);
    }
  };
  const onUp = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (dragFrom.current !== null) write(`ドラッグ終わり → ${items.join(",")}`);
    dragFrom.current = null;
    setDragging(null);
  };

  // 3. 下へのスワイプ（全画面の再生を閉じる形）
  const [sheet, setSheet] = useState(false);
  const swipe = useRef<{ y: number } | null>(null);

  return (
    <div
      ref={probe}
      data-testid="mobile-proto"
      style={{
        padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)",
        height: "100vh",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        fontSize: 14,
      }}
    >
      <div style={{ background: "#3a6", color: "#fff", padding: 6 }}>一番上（ここがステータスバーに隠れなければよい）</div>
      <div style={{ flex: 1, overflow: "auto", padding: 8 }} data-testid="proto-scroll">
        <div>セーフエリア：{insets}</div>
        <div style={{ margin: "8px 0" }}>
          画面 {screen}{" "}
          <button onClick={() => go(screen + 1)} data-testid="proto-push">
            次の画面へ（履歴に積む）
          </button>
        </div>
        <div style={{ border: "1px solid #888" }} ref={listRef}>
          {items.map((t, i) => (
            <div
              key={t}
              data-proto-item={i}
              data-testid="proto-item"
              onPointerDown={onDown(i)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => {
                write("pointercancel（スクロールに取られた）");
                onUp();
              }}
              // ドラッグ中は、スクロールさせない
              style={{ padding: 14, borderBottom: "1px solid #555", background: dragging === i ? "#46a" : undefined, touchAction: "pan-y", userSelect: "none", WebkitUserSelect: "none" }}
              onContextMenu={(e) => e.preventDefault()}
            >
              {t}
            </div>
          ))}
        </div>
        {Array.from({ length: 20 }, (_, i) => (
          <div key={i} style={{ padding: 10 }}>
            スクロール用の行 {i}
          </div>
        ))}
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }} data-testid="proto-log">
          {log.join("\n")}
        </pre>
      </div>
      <div
        style={{ background: "#246", color: "#fff", padding: 14 }}
        onClick={() => {
          setSheet(true);
          write("全画面を開いた");
        }}
        data-testid="proto-mini"
      >
        再生エリア（小）：押すと全画面
      </div>
      <div style={{ background: "#c33", color: "#fff", padding: 4 }}>一番下（ナビゲーションバーに隠れなければよい）</div>
      {sheet && (
        <div
          data-testid="proto-sheet"
          style={{ position: "fixed", inset: 0, background: "#123", color: "#fff", padding: "calc(env(safe-area-inset-top) + 20px) 20px", touchAction: "none" }}
          onPointerDown={(e) => (swipe.current = { y: e.clientY })}
          onPointerUp={(e) => {
            const dy = swipe.current ? e.clientY - swipe.current.y : 0;
            swipe.current = null;
            if (dy > 120) {
              setSheet(false);
              write(`下へスワイプ（${Math.round(dy)}）→ 閉じた`);
            }
          }}
        >
          全画面の再生（下へスワイプで閉じる）
        </div>
      )}
    </div>
  );
}
