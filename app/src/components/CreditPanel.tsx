import type { CountItem, Credit, CreditKind, MoveTarget } from "../api";
import { CREDIT_LABEL } from "../credits";
import { nameMatches } from "../tree";
import { useTreeDrag } from "../treeDrag";
import { Collapsible } from "./Collapsible";
import { TermMarks } from "./TermMarks";
import { RowActions } from "./TreeParts";

type Props = {
  kind: CreditKind;
  credits: Credit[];
  /** 絞り込みに選んでいるid */
  selectedIds: number[];
  /** 「なし」で絞り込んでいるか */
  noneSelected: boolean;
  onToggle: (id: number) => void;
  onToggleNone: () => void;
  busy: boolean;
  /** 作る・編集するフォームを開く（作るときは null） */
  onEdit: (credit: Credit | null) => void;
  onDelete: (credit: Credit) => void;
  onMove: (credit: Credit, target: MoveTarget) => void;
  /** 各項目を選んだときの件数（id が null は「なし」）。まだ求めていなければ null（総数を出す） */
  counts: CountItem[] | null;
  /** 左の欄の検索の文字。あてはまるものだけを出す */
  query: string;
};

/** 左の欄の「出典」「ライセンス」。取っ手での並べ替え（階層はない）、選んだときの件数とグレーアウト、編集・削除 */
export function CreditPanel({
  kind,
  credits,
  selectedIds,
  noneSelected,
  onToggle,
  onToggleNone,
  busy,
  onEdit,
  onDelete,
  onMove,
  counts,
  query,
}: Props) {
  const label = CREDIT_LABEL[kind];
  // 選んだときの件数。0件になる項目はグレーアウトし、選べないようにする（選んでいる項目は外せる）
  const countMap = new Map(counts?.map((c) => [c.id, c.count]));
  const countOf = (id: number | null, total: number | null) => (counts ? (countMap.get(id) ?? 0) : total);
  const noneCount = countOf(null, null);
  const noneDisabled = noneCount === 0 && !noneSelected;
  const q = query.trim().toLowerCase();
  const shown = q ? credits.filter((c) => nameMatches(c.name, q)) : credits;

  // 階層はないので、前・後ろと一覧の下の空いた所（最後）にだけ落とせる
  const drag = useTreeDrag({
    tree: kind,
    busy,
    flat: true,
    canDrop: (dragged, target) => dragged !== target,
    onMove: (id, target) => {
      const credit = credits.find((c) => c.id === id);
      if (credit) onMove(credit, target);
    },
  });

  return (
    <Collapsible
      id={kind}
      title={label}
      selectedCount={selectedIds.length + (noneSelected ? 1 : 0)}
      actions={
        <button className="icon add-button" onClick={() => onEdit(null)} disabled={busy} title={`${label}を作る`} aria-label={`${label}を作る`}>
          ＋
        </button>
      }
    >
      <ul className={`tag-list${drag.dragId !== null ? " dragging" : ""}`}>
        {/* 検索しているときは「（なし）」を出さない */}
        {!q && (
          <li
            className={(noneSelected ? "active" : "") + (noneDisabled ? " disabled" : "")}
            onClick={() => !noneDisabled && onToggleNone()}
            aria-disabled={noneDisabled}
            data-testid={`${kind}-none`}
          >
            <span className="credit-name">（{label}なし）</span>
            {noneCount !== null && <span className="sub">{noneCount}</span>}
          </li>
        )}
        {shown.map((c) => {
          const selected = selectedIds.includes(c.id);
          const count = countOf(c.id, c.fileCount);
          const disabled = count === 0 && !selected;
          return (
            <li
              key={c.id}
              className={
                (selected ? "active" : "") +
                (disabled ? " disabled" : "") +
                (drag.dragId === c.id ? " drag-source" : "") +
                drag.dropClass(c.id)
              }
              // aria-disabled は付けない（中の「✎」「🗑」まで押せない扱いになるため）。グレーアウトは class で示す
              onClick={() => !disabled && onToggle(c.id)}
              data-testid={kind}
              data-credit-name={c.name}
              // 並べ替えの落とす先（useTreeDrag）と、ファイルの行を落とす先（useFileDrag）
              data-tree={kind}
              data-node-id={c.id}
              {...drag.rowProps(c.id)}
            >
              <span className="credit-name">{c.name}</span>
              {kind === "license" && <TermMarks terms={c.terms} />}
              <RowActions name={c.name} busy={busy} editLabel="編集" onEdit={() => onEdit(c)} onDelete={() => onDelete(c)} />
              <span className="sub" data-testid="credit-count">
                {count}
              </span>
            </li>
          );
        })}
      </ul>
      {credits.length > 0 && (
        <div
          className={`tag-drop-root${drag.dragId !== null ? " dragging" : ""}${drag.drop?.pos === "root" ? " active" : ""}`}
          data-tree-root={kind}
          data-testid={`${kind}-drop-root`}
        />
      )}
      {credits.length === 0 && <div className="sub">{label}はまだありません</div>}
    </Collapsible>
  );
}
