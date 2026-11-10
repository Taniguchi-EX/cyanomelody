import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useDisplay } from "../displaySettings";

type Tag = { id: number; name: string };

type Props = {
  tags: Tag[];
  /** タグのidから、チップの色を引く表（色のないタグは入らない） */
  tagStyles: Map<number, CSSProperties>;
};

/** たたんだタグを出す欄の高さの目安（画面の下の端なら、行の上に出す） */
const POPUP_ROOM = 120;

/** チップの幅（左の間を含む） */
const outerWidth = (el: HTMLElement) => el.getBoundingClientRect().width + (parseFloat(getComputedStyle(el).marginLeft) || 0);

/**
 * 出せる幅 room に、頭から何個のチップを出すか決める。すべて入るならすべて。
 * 入らないときは「+N tags」の幅を残して入る分だけ。1個も入らないときは、最初の1個を縮めて（…で省いて）出す
 */
export function fitTags(widths: number[], room: number, moreWidth: (hidden: number) => number): { shown: number; shrink: boolean } {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= room) return { shown: widths.length, shrink: false };
  let used = 0;
  let shown = 0;
  while (shown < widths.length - 1 && used + widths[shown] + moreWidth(widths.length - shown - 1) <= room) {
    used += widths[shown];
    shown += 1;
  }
  return shown === 0 ? { shown: 1, shrink: true } : { shown, shrink: false };
}

/**
 * ファイルの行のタグ。1行に収まる分だけ出し、収まらない分は「+N tags」にまとめる（行の中で改行しない）。
 * 出せる幅（タグの欄が広がれる幅）と各チップの幅を測り、すべて入るならすべて、入らなければ「+N tags」の幅を残して
 * 入る分だけを出す（欄の幅は出したチップの分だけにし、余白を残さない）。行の幅・タグ・文字の大きさが変わるたびに測り直す。
 * たたんだタグがあるときは、タグの所にマウスを乗せると、すべてのタグを行の下（下の端なら上）に出す。
 */
export function RowTags({ tags, tagStyles }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  // 「+N tags」の幅を測るためだけのチップ（中身は測るときに入れる。React は中身を持たない）
  const probeRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{ shown: number; shrink: boolean }>({ shown: tags.length, shrink: false });
  const [popup, setPopup] = useState<CSSProperties | null>(null);
  const { textScale, font } = useDisplay();

  useLayoutEffect(() => {
    const el = ref.current;
    const row = el?.parentElement;
    if (!el || !row) return;
    const measure = () => {
      // すべてのチップを縮めずに並べた状態で、欄が広がれた幅（行の残りか、行の半分まで）と各チップの幅を測る
      el.dataset.measuring = "";
      const room = el.getBoundingClientRect().width;
      const chips = [...el.querySelectorAll<HTMLElement>(":scope > .tag-chip")];
      const widths = chips.map(outerWidth);
      const probe = probeRef.current;
      const moreWidth = (hidden: number) => {
        if (!probe) return 0;
        probe.textContent = `+${hidden} tags`;
        return outerWidth(probe);
      };
      const next = fitTags(widths, room, moreWidth);
      delete el.dataset.measuring;
      setFit((prev) => (prev.shown === next.shown && prev.shrink === next.shrink ? prev : next));
    };
    measure();
    // 行の幅が変わったとき（ウィンドウ・欄の幅を変えたとき）に測り直す。タグの欄そのものは、出すチップで幅が変わるので見ない
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [tags, textScale, font]);

  if (tags.length === 0) return null;
  const shown = Math.min(fit.shown, tags.length);
  const hidden = tags.length - shown;
  const folded = hidden > 0 || fit.shrink;
  const chip = (t: Tag, className = "chip") => (
    <span className={className} key={t.id} style={tagStyles.get(t.id)} title={t.name}>
      {t.name}
    </span>
  );
  return (
    <span
      className="row-tags"
      ref={ref}
      data-testid="row-tags"
      data-shown={shown}
      data-hidden={hidden}
      onMouseEnter={(e) => {
        if (!folded) return;
        const r = e.currentTarget.getBoundingClientRect();
        const right = window.innerWidth - r.right;
        setPopup(
          r.bottom + POPUP_ROOM > window.innerHeight
            ? { right, bottom: window.innerHeight - r.top + 2 }
            : { right, top: r.bottom + 2 },
        );
      }}
      onMouseLeave={() => setPopup(null)}
    >
      {/* 出さないチップも、測るために置いておく（隠す） */}
      {tags.map((t, i) =>
        chip(t, "chip tag-chip" + (i >= shown ? " tag-off" : "") + (fit.shrink && i === 0 ? " tag-shrink" : "")),
      )}
      {hidden > 0 && (
        <span className="chip more-tags" data-testid="more-tags">
          +{hidden} tags
        </span>
      )}
      <span className="chip more-tags tag-probe" ref={probeRef} aria-hidden="true" />
      {popup && folded && (
        <span className="tags-popup" style={popup} data-testid="tags-popup">
          {tags.map((t) => chip(t))}
        </span>
      )}
    </span>
  );
}
