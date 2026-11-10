import { useState, type MouseEvent } from "react";
import { isAndroid } from "../platform";
import { RowMenu } from "./RowMenu";

// 左の欄の行（タグ・プレイリスト・出典・ライセンス）に共通の部品

type TwistyProps = {
  name: string;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** 行の左の字下げ（px）。印の押せる所を、行の左端まで広げる */
  indent: number;
};

/**
 * 開く・たたむの印。押せる所は行の左端から印まで（字下げの分も含む）。
 * 子のない節では空白になり、押すと行を押したことになる
 */
export function Twisty({ name, hasChildren, collapsed, onToggle, indent }: TwistyProps) {
  return (
    <span
      className="twisty"
      // 行の字下げ（padding）の分だけ左へ広げ、印は右端に置く
      style={{ marginLeft: -indent, paddingLeft: indent, boxSizing: "content-box" }}
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

type RowActionsProps = {
  name: string;
  busy: boolean;
  /** 「✎」の言葉（名前を変える・編集） */
  editLabel: string;
  onEdit: () => void;
  onDelete: () => void;
};

/**
 * 行の「✎」「🗑」。行にマウスを乗せたとき（行の中にフォーカスがあるとき）だけ出す。押しても行を押したことにしない。
 * Android では、マウスを乗せられないので、行の右端の「⋮」の選び肢にする
 */
export function RowActions({ name, busy, editLabel, onEdit, onDelete }: RowActionsProps) {
  if (isAndroid)
    return (
      <RowMenu
        label={`${name}の操作`}
        disabled={busy}
        items={[
          { label: editLabel, onClick: onEdit },
          { label: "削除", onClick: onDelete, danger: true },
        ]}
      />
    );
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
