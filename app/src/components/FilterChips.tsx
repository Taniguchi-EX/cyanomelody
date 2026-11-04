import type { CSSProperties } from "react";

export type FilterChip = {
  key: string;
  /** 条件の種類を表す記号 */
  icon: string;
  label: string;
  title?: string;
  onRemove: () => void;
  testId?: string;
};

type ChipProps = {
  /** 種類を表す記号（🏷 など） */
  icon: string;
  label: string;
  /** 名前の後ろに、色を変えて出す数 */
  count?: number;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  /** タグのチップのとき、タグの名前（data-tag-name。画面テストが使う） */
  tagName?: string;
  /** タグの色など */
  style?: CSSProperties;
};

/** 「記号 名前（数） ✕」のチップ。押すと外す（絞り込みの条件、付いているタグなど） */
export function Chip({ icon, label, count, title, ariaLabel, onClick, disabled, testId, tagName, style }: ChipProps) {
  return (
    <button
      className="chip filter-chip"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
      data-tag-name={tagName}
      style={style}
    >
      <span className="chip-icon">{icon}</span>
      {label}
      {count !== undefined && <span className="chip-count">{count}</span>}
      <span className="chip-x">✕</span>
    </button>
  );
}

/** 選んでいる絞り込みの条件を並べる。押すとその条件だけ外れる */
type Props = {
  chips: FilterChip[];
  /** 条件が2つ以上のときに出す、名前のない「✕」を押したとき（すべての条件を外す） */
  onClearAll?: () => void;
};

export function FilterChips({ chips, onClearAll }: Props) {
  if (chips.length === 0) return null;
  return (
    <div className="filter-chips" data-testid="filter-chips">
      {chips.map((c) => (
        <Chip
          key={c.key}
          icon={c.icon}
          label={c.label}
          onClick={c.onRemove}
          title={c.title ?? "押すと外す"}
          ariaLabel={`${c.label}の条件を外す`}
          testId={c.testId}
        />
      ))}
      {onClearAll && chips.length >= 2 && (
        <button
          className="chip filter-chip clear-chip"
          onClick={onClearAll}
          title="絞り込みの条件をすべて外す"
          aria-label="絞り込みの条件をすべて外す"
        >
          <span className="chip-x">✕</span>
        </button>
      )}
    </div>
  );
}
