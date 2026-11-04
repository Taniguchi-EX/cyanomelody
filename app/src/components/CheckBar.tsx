import { useEffect, useRef, useState } from "react";
import { api, type TagCount } from "../api";
import { Chip } from "./FilterChips";

type Props = {
  checked: Set<number>;
  /** 表示中のファイルがすべてチェック済みか（「全てチェック」を押せない） */
  allShownChecked: boolean;
  checkedOnly: boolean;
  busy: boolean;
  /** データを読み直すたびに変わる（チェックしたファイルのタグを読み直す） */
  dataVersion: number;
  onCheckShown: () => void;
  onClear: () => void;
  onCheckedOnly: (on: boolean) => void;
  /** タグのチップを押したとき（チェックしたファイルすべてから外す） */
  onRemoveTag: (tag: TagCount) => void;
  /** チェックしたファイルがすべてリンク切れのときの操作（右端のボタン） */
  onRelink: () => void;
  onFindInFolder: () => void;
  onRemoveMissing: () => void;
  onError: (e: unknown) => void;
};

/** ファイルの一覧の上の、チェックの操作の行。チェックしたファイルに付いているタグを、件数と一緒に出す */
export function CheckBar({
  checked,
  allShownChecked,
  checkedOnly,
  busy,
  dataVersion,
  onCheckShown,
  onClear,
  onCheckedOnly,
  onRemoveTag,
  onRelink,
  onFindInFolder,
  onRemoveMissing,
  onError,
}: Props) {
  const [tags, setTags] = useState<TagCount[]>([]);
  /** チェックしたファイルのうち、リンク切れの数（表示していないファイルも含めて数える） */
  const [missing, setMissing] = useState<{ ids: Set<number>; count: number } | null>(null);
  // onError は描くたびに作り直されるので、読み直しのきっかけにしないよう ref で持つ
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });
  useEffect(() => {
    if (checked.size === 0) return;
    let alive = true;
    api
      .checkedTagCounts([...checked])
      .then((list) => alive && setTags(list))
      .catch((e) => onErrorRef.current(e));
    api
      .countMissing([...checked])
      .then((count) => alive && setMissing({ ids: checked, count }))
      .catch((e) => onErrorRef.current(e));
    return () => {
      alive = false;
    };
  }, [checked, dataVersion]);

  // 数え終えたチェックが今のチェックと同じで、すべてがリンク切れのときだけ、リンク切れの操作を出す
  const allMissing = missing !== null && missing.ids === checked && checked.size > 0 && missing.count === checked.size;
  return (
    <div className="toolbar">
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
      {/* チェックしたファイルに付いているタグ。名前・件数・✕（押すとチェックしたファイルすべてから外す） */}
      {checked.size > 0 && tags.length > 0 && (
        <div className="filter-chips checked-tags" data-testid="checked-tags">
          {tags.map((t) => (
            <Chip
              key={t.id}
              icon="🏷"
              label={t.name}
              count={t.count}
              onClick={() => onRemoveTag(t)}
              disabled={busy}
              title="押すと、チェックしたファイルすべてから外す"
              ariaLabel={`${t.name}をチェックしたファイルから外す`}
              testId="checked-tag"
              tagName={t.name}
            />
          ))}
        </div>
      )}
      {allMissing && (
        <div className="missing-actions" data-testid="missing-actions">
          <span className="warn">⚠ リンク切れ {checked.size}件</span>
          <button onClick={onRelink} disabled={busy} title="ライブラリの中から同じ音声のファイルを探して、タグなどを移す">
            ひも付け直す
          </button>
          <button onClick={onFindInFolder} disabled={busy} title="フォルダを選んで、その中から同じ音声のファイルを探す">
            指定フォルダから自動で探す
          </button>
          <button onClick={onRemoveMissing} disabled={busy} title="ファイルの情報と、付けたタグなどの設定を消す">
            ライブラリから外す
          </button>
        </div>
      )}
    </div>
  );
}
