import { useEffect, useRef, useState, type CSSProperties } from "react";

type Tag = { id: number; name: string };

type Props = {
  tags: Tag[];
  /** タグのidから、チップの色を引く表（色のないタグは入らない） */
  tagStyles: Map<number, CSSProperties>;
};

/** たたんだタグを出す欄の高さの目安（画面の下の端なら、行の上に出す） */
const POPUP_ROOM = 120;

/**
 * ファイルの行のタグ。1行に収まる分だけ出し、収まらない分は「+N tags」にまとめる（行の中で改行しない）。
 * チップは折り返す箱に入れて2行目以降を隠し、隠れたチップの数を数える（幅が変わるたびに数え直す）。
 * たたんだタグがあるときは、タグの所にマウスを乗せると、すべてのタグを行の下（下の端なら上）に出す。
 */
export function RowTags({ tags, tagStyles }: Props) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const [hidden, setHidden] = useState(0);
  const [popup, setPopup] = useState<CSSProperties | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // 見始めたときと、箱の大きさが変わったとき（「+N tags」が出て箱が縮んだときを含む）に数える
    const observer = new ResizeObserver(() => {
      const chips = [...box.children] as HTMLElement[];
      const top = chips[0]?.offsetTop ?? 0;
      setHidden(chips.filter((c) => c.offsetTop > top).length);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [tags]);

  if (tags.length === 0) return null;
  const chip = (t: Tag) => (
    <span className="chip" key={t.id} style={tagStyles.get(t.id)} title={t.name}>
      {t.name}
    </span>
  );
  return (
    <span
      className="row-tags"
      data-testid="row-tags"
      onMouseEnter={(e) => {
        if (hidden === 0) return;
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
      <span className="row-tags-box" ref={boxRef}>
        {tags.map(chip)}
      </span>
      {hidden > 0 && (
        <span className="chip more-tags" data-testid="more-tags">
          +{hidden} tags
        </span>
      )}
      {popup && hidden > 0 && (
        <span className="tags-popup" style={popup} data-testid="tags-popup">
          {tags.map(chip)}
        </span>
      )}
    </span>
  );
}
