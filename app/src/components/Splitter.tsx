import { useRef } from "react";

type Props = {
  /** 動かす欄の今の幅 */
  width: number;
  /** 境界を右へ動かすと広がる欄なら 1（左の欄）、狭まる欄なら -1（右の欄） */
  direction: 1 | -1;
  min: number;
  /** 動かす欄の最大の幅（中央の欄の最小の幅を残す） */
  max: () => number;
  onChange: (width: number) => void;
  /** ドラッグを終えたとき（幅を覚える） */
  onCommit: () => void;
  label: string;
};

/** 欄の境界。ドラッグすると隣の欄の幅を変える */
export function Splitter({ width, direction, min, max, onChange, onCommit, label }: Props) {
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const next = start.current.width + direction * (e.clientX - start.current.x);
        onChange(Math.round(Math.max(min, Math.min(max(), next))));
      }}
      onPointerUp={() => {
        if (!start.current) return;
        start.current = null;
        onCommit();
      }}
    />
  );
}
