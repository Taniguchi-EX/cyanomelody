import type { CountItem, Credit, CreditKind } from "../api";
import { CREDIT_LABEL } from "../credits";
import { Collapsible } from "./Collapsible";

type Props = {
  kind: CreditKind;
  credits: Credit[];
  /** 絞り込みに選んでいるid */
  selectedIds: number[];
  /** 「なし」で絞り込んでいるか */
  noneSelected: boolean;
  onToggle: (id: number) => void;
  onToggleNone: () => void;
  onManage: () => void;
  /** 各項目を選んだときの件数（id が null は「なし」）。まだ求めていなければ null（総数を出す） */
  counts: CountItem[] | null;
};

/** 左の欄の「出典で絞り込む」「ライセンスで絞り込む」 */
export function CreditPanel({
  kind,
  credits,
  selectedIds,
  noneSelected,
  onToggle,
  onToggleNone,
  onManage,
  counts,
}: Props) {
  const label = CREDIT_LABEL[kind];
  // 選んだときの件数。0件になる項目はグレーアウトし、選べないようにする（選んでいる項目は外せる）
  const countMap = new Map(counts?.map((c) => [c.id, c.count]));
  const countOf = (id: number | null, total: number | null) => (counts ? (countMap.get(id) ?? 0) : total);
  const noneCount = countOf(null, null);
  const noneDisabled = noneCount === 0 && !noneSelected;
  return (
    <Collapsible
      id={kind}
      title={`${label}で絞り込む`}
      selectedCount={selectedIds.length + (noneSelected ? 1 : 0)}
      actions={
        <button onClick={onManage} aria-label={`${label}を管理`}>
          管理
        </button>
      }
    >
      <ul className="tag-list">
        <li
          className={(noneSelected ? "active" : "") + (noneDisabled ? " disabled" : "")}
          onClick={() => !noneDisabled && onToggleNone()}
          aria-disabled={noneDisabled}
          data-testid={`${kind}-none`}
        >
          <span>（{label}なし）</span>
          {noneCount !== null && <span className="sub">{noneCount}</span>}
        </li>
        {credits.map((c) => {
          const selected = selectedIds.includes(c.id);
          const count = countOf(c.id, c.fileCount);
          const disabled = count === 0 && !selected;
          return (
            <li
              key={c.id}
              className={(selected ? "active" : "") + (disabled ? " disabled" : "")}
              onClick={() => !disabled && onToggle(c.id)}
              aria-disabled={disabled}
              data-testid={kind}
              data-credit-name={c.name}
            >
              <span>{c.name}</span>
              <span className="sub">{count}</span>
            </li>
          );
        })}
      </ul>
      {credits.length === 0 && <div className="sub">{label}はまだありません</div>}
    </Collapsible>
  );
}
