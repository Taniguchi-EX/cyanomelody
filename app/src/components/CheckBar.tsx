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
  onError,
}: Props) {
  const [tags, setTags] = useState<TagCount[]>([]);
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
    return () => {
      alive = false;
    };
  }, [checked, dataVersion]);

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
    </div>
  );
}
