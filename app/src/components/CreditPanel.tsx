import type { Credit, CreditKind } from "../api";
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
};

/** 左の欄の「出典で絞り込む」「ライセンスで絞り込む」 */
export function CreditPanel({ kind, credits, selectedIds, noneSelected, onToggle, onToggleNone, onManage }: Props) {
  const label = CREDIT_LABEL[kind];
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
        <li className={noneSelected ? "active" : ""} onClick={onToggleNone} data-testid={`${kind}-none`}>
          <span>（{label}なし）</span>
        </li>
        {credits.map((c) => (
          <li
            key={c.id}
            className={selectedIds.includes(c.id) ? "active" : ""}
            onClick={() => onToggle(c.id)}
            data-testid={kind}
          >
            <span>{c.name}</span>
            <span className="sub">{c.fileCount}</span>
          </li>
        ))}
      </ul>
      {credits.length === 0 && <div className="sub">{label}はまだありません</div>}
    </Collapsible>
  );
}
