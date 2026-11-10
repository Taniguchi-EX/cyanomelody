import { useEffect, useRef, useState, type CSSProperties } from "react";

export type RowMenuItem = {
  label: string;
  onClick: () => void;
  /** 消すなど、元に戻せない操作（赤で出す） */
  danger?: boolean;
  disabled?: boolean;
};

type Props = {
  /** 読み上げの名前（「雨の操作」など） */
  label: string;
  items: RowMenuItem[];
  disabled?: boolean;
};

/**
 * 行の「⋮」：押すと選び肢を出す（Android で、マウスを乗せたときだけ出していた ✎・🗑 などの代わり）。
 * 選び肢の外を押すと閉じる。押しても行を押したことにしない
 */
export function RowMenu({ label, items, disabled }: Props) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setPos(null);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [pos]);
  return (
    <>
      <button
        className="icon row-menu"
        aria-label={label}
        title={label}
        disabled={disabled}
        data-testid="row-menu"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          // 画面の下の方なら、上に出す
          const below = r.bottom + 160 < window.innerHeight;
          setPos(below ? { right: window.innerWidth - r.right, top: r.bottom } : { right: window.innerWidth - r.right, bottom: window.innerHeight - r.top });
        }}
      >
        ⋮
      </button>
      {pos && (
        <div className="row-menu-items" style={pos} ref={menuRef} role="menu" data-testid="row-menu-items" onClick={(e) => e.stopPropagation()}>
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                setPos(null);
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
