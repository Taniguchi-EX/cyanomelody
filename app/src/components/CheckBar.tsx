type Props = {
  checked: Set<number>;
  /** 表示中のファイルがすべてチェック済みか（「全てチェック」を押せない） */
  allShownChecked: boolean;
  checkedOnly: boolean;
  onCheckShown: () => void;
  onClear: () => void;
  onCheckedOnly: (on: boolean) => void;
  /** 右の欄に一括操作を出しているか */
  bulkOpen: boolean;
  /** 「一括操作」：右の欄の一括操作を出す・ファイルの詳細に戻す */
  onToggleBulk: () => void;
};

/** ファイルの一覧の上の、チェックの操作の行。チェックしたファイルへの操作は「一括操作」で右の欄に出す */
export function CheckBar({ checked, allShownChecked, checkedOnly, onCheckShown, onClear, onCheckedOnly, bulkOpen, onToggleBulk }: Props) {
  return (
    <div className="toolbar check-bar">
      <button onClick={onCheckShown} disabled={allShownChecked}>
        全てチェック
      </button>
      <button onClick={onClear} disabled={checked.size === 0}>
        チェックをすべて外す
      </button>
      <label>
        <input type="checkbox" checked={checkedOnly} onChange={(e) => onCheckedOnly(e.target.checked)} />
        チェックしたファイルだけ表示
      </label>
      <BulkButton open={bulkOpen} disabled={checked.size === 0} onToggle={onToggleBulk} />
    </div>
  );
}

/** 「一括操作」のボタン。押すと右の欄に一括操作を出し、もう一度押すとファイルの詳細に戻す */
export function BulkButton({ open, disabled, onToggle }: { open: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <button
      className={`bulk-button${open ? " active" : ""}`}
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={open}
      title={open ? "ファイルの詳細に戻す" : "チェックしたものに、右の欄でまとめて操作する"}
    >
      一括操作
    </button>
  );
}
