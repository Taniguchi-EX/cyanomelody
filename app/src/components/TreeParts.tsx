import { useState, type MouseEvent } from "react";

// 左の欄の行（タグ・プレイリスト・出典・ライセンス）に共通の部品

type TwistyProps = {
  name: string;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
};

/** 開く・たたむの印。子のない節では空白になり、押すと行を押したことになる */
export function Twisty({ name, hasChildren, collapsed, onToggle }: TwistyProps) {
  return (
    <span
      className="twisty"
      onClick={(e) => {
        if (!hasChildren) return;
        e.stopPropagation();
        onToggle();
      }}
      role={hasChildren ? "button" : undefined}
      aria-label={hasChildren ? `${name}を${collapsed ? "開く" : "たたむ"}` : undefined}
      data-testid="tag-twisty"
    >
      {hasChildren ? (collapsed ? "▶" : "▼") : ""}
    </span>
  );
}

type HandleProps = {
  name: string;
  /** useTreeDrag の handleProps(id) */
  handlers: ReturnType<ReturnType<typeof import("../treeDrag").useTreeDrag>["handleProps"]>;
};

/** 並べ替えの取っ手 */
export function DragHandle({ name, handlers }: HandleProps) {
  return (
    <span
      className="drag-handle"
      title="ドラッグして並べ替え"
      aria-label={`${name}を移す`}
      data-testid="drag-handle"
      {...handlers}
    >
      ≡
    </span>
  );
}

/** 取っ手のない行（「（タグなし）」など）で、件数の位置をほかの行とそろえるために、取っ手の幅だけ空ける */
export function HandleSpace() {
  return (
    <span className="drag-handle handle-space" aria-hidden="true">
      ≡
    </span>
  );
}

type RowActionsProps = {
  name: string;
  busy: boolean;
  /** 「✎」の言葉（名前を変える・編集） */
  editLabel: string;
  onEdit: () => void;
  onDelete: () => void;
};

/** 行の「✎」「🗑」。行にマウスを乗せたとき（行の中にフォーカスがあるとき）だけ出す。押しても行を押したことにしない */
export function RowActions({ name, busy, editLabel, onEdit, onDelete }: RowActionsProps) {
  const click = (action: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    action();
  };
  return (
    <span className="row-actions" data-testid="row-actions">
      <button className="row-icon" title={editLabel} aria-label={`${name}の${editLabel}`} disabled={busy} onClick={click(onEdit)}>
        ✎
      </button>
      <button className="row-icon" title="削除" aria-label={`${name}を削除`} disabled={busy} onClick={click(onDelete)}>
        🗑
      </button>
    </span>
  );
}

type NameInputProps = {
  label: string;
  initial?: string;
  placeholder?: string;
  /** Enterで呼ぶ。入力欄を閉じるのは呼んだ側が決める */
  onCommit: (name: string) => unknown;
  onCancel: () => void;
};

/** その場で名前を入れる欄。Enterで決め、Escか、ほかを押してフォーカスが外れるとやめる */
export function NameInput({ label, initial = "", placeholder, onCommit, onCancel }: NameInputProps) {
  const [value, setValue] = useState(initial);
  return (
    <input
      type="text"
      className="name-input"
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.trim()) onCommit(value);
        if (e.key === "Escape") {
          // 入力をやめるだけにし、ほかのEsc（useEscape）まで届かせない
          e.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}
