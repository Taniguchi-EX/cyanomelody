export type FilterChip = {
  key: string;
  /** 条件の種類を表す記号 */
  icon: string;
  label: string;
  title?: string;
  onRemove: () => void;
  testId?: string;
};

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
        <button
          key={c.key}
          className="chip filter-chip"
          onClick={c.onRemove}
          title={c.title ? `${c.title}（押すと外す）` : "押すと外す"}
          aria-label={`${c.label}の条件を外す`}
          data-testid={c.testId}
        >
          <span className="chip-icon">{c.icon}</span>
          {c.label}
          <span className="chip-x">✕</span>
        </button>
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
