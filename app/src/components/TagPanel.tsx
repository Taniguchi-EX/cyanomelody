import { useMemo, useState } from "react";
import type { Facets, FileFilter, MoveTarget, Tag } from "../api";
import { useStoredIdSet } from "../storage";
import { descendantsAndSelf, indentOf, parentIds, searchNodes, visibleNodes } from "../tree";
import { useTreeDrag } from "../treeDrag";
import { Collapsible } from "./Collapsible";
import { NameInput, RowActions, Twisty } from "./TreeParts";

type Props = {
  tags: Tag[];
  filter: FileFilter;
  busy: boolean;
  onToggleTag: (tagId: number) => void;
  onToggleUntagged: () => void;
  onCreate: (name: string) => Promise<boolean>;
  /** 「✎」を押したとき（タグの詳細画面を開く） */
  onEdit: (tag: Tag) => void;
  onDelete: (tag: Tag) => void;
  onMove: (tag: Tag, target: MoveTarget) => void;
  /** 各項目を選んだときの件数。まだ求めていなければ null（タグの総数を出す） */
  facets: Facets | null;
  /** 左の欄の検索の文字。あてはまるタグ（と、薄くした祖先）だけを出す */
  query: string;
};

/** 左の欄の「タグ」。階層表示、開く・たたむ、行のドラッグでの並べ替え、選んだときの件数とグレーアウト、作成・詳細画面を開く・削除 */
export function TagPanel({
  tags,
  filter,
  busy,
  onToggleTag,
  onToggleUntagged,
  onCreate,
  onEdit,
  onDelete,
  onMove,
  facets,
  query,
}: Props) {
  const [collapsed, toggleCollapsed] = useStoredIdSet("cyanomelody.tagTree.collapsed");
  const [creating, setCreating] = useState(false);

  const parents = useMemo(() => parentIds(tags), [tags]);
  // 選んだときの件数。0件になる項目はグレーアウトし、選べないようにする（選んでいる項目は外せる）
  const facetMap = useMemo(() => new Map(facets?.tags.map((c) => [c.id, c.count])), [facets]);
  const countOf = (t: Tag) => (facets ? (facetMap.get(t.id) ?? 0) : t.fileCount);
  const untaggedCount = facets?.untagged ?? null;
  const untaggedDisabled = untaggedCount === 0 && !filter.untaggedOnly;
  // 検索しているときは、たたんでいてもあてはまるタグを出す（開閉の状態は変えない）
  const search = useMemo(() => searchNodes(tags, query), [tags, query]);
  const shown = useMemo(() => search?.shown ?? visibleNodes(tags, collapsed), [search, tags, collapsed]);

  // 自分自身や子孫の中（前・後ろ・子のどれでも）には落とせない
  const drag = useTreeDrag({
    tree: "tags",
    busy,
    canDrop: (dragged, target) => !descendantsAndSelf(tags, dragged).has(target),
    onMove: (id, target) => {
      const tag = tags.find((t) => t.id === id);
      if (tag) onMove(tag, target);
    },
  });
  const moving = useMemo(
    () => (drag.dragId === null ? new Set<number>() : descendantsAndSelf(tags, drag.dragId)),
    [tags, drag.dragId],
  );

  return (
    <Collapsible
      id="tags"
      title="タグ"
      selectedCount={filter.tagIds.length + (filter.untaggedOnly ? 1 : 0)}
      actions={(expand) => (
        <button
          className="icon add-button"
          onClick={() => {
            // たたんでいるときは、開いてから入力欄を出す
            expand();
            setCreating(true);
          }}
          disabled={busy}
          title="タグを作る"
          aria-label="タグを作る"
        >
          ＋
        </button>
      )}
    >
      {creating && (
        <NameInput
          label="新しいタグの名前"
          placeholder="新しいタグの名前"
          onCommit={async (name) => {
            if (await onCreate(name)) setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      <ul className={`tag-list tag-tree${drag.dragId !== null ? " dragging" : ""}`}>
        {/* 検索しているときは「（タグなし）」を出さない */}
        {!search && (
          <li
            className={(filter.untaggedOnly ? "active" : "") + (untaggedDisabled ? " disabled" : "")}
            onClick={() => !untaggedDisabled && onToggleUntagged()}
            aria-disabled={untaggedDisabled}
            data-testid="untagged"
          >
            <span className="tag-name">（タグなし）</span>
            {untaggedCount !== null && <span className="sub">{untaggedCount}</span>}
          </li>
        )}
        {shown.map((t) => {
          const selected = filter.tagIds.includes(t.id);
          const disabled = countOf(t) === 0 && !selected;
          return (
            <li
              key={t.id}
              className={
                (selected ? "active" : "") +
                (disabled ? " disabled" : "") +
                (moving.has(t.id) ? " drag-source" : "") +
                (search?.dimmed.has(t.id) ? " search-parent" : "") +
                drag.dropClass(t.id)
              }
              // aria-disabled は付けない（中の「✎」「🗑」まで押せない扱いになるため）。グレーアウトは class で示す
              onClick={() => !disabled && onToggleTag(t.id)}
              data-testid="tag"
              data-tree="tags"
              data-node-id={t.id}
              data-tag-name={t.name}
              data-depth={t.depth}
              style={{ paddingLeft: indentOf(t.depth) }}
              {...drag.rowProps(t.id)}
            >
              <Twisty
                name={t.name}
                // 検索しているときは、開閉の印を出さない（あてはまるものをすべて開いて見せる）
                hasChildren={!search && parents.has(t.id)}
                collapsed={collapsed.has(t.id)}
                onToggle={() => toggleCollapsed(t.id)}
                indent={indentOf(t.depth)}
              />
              <span className="tag-name" title={t.synonyms.length > 0 ? `${t.name}\nシノニム：${t.synonyms.join("、")}` : undefined}>
                {t.name}
              </span>
              <RowActions
                name={t.name}
                busy={busy}
                editLabel="詳細を設定する"
                onEdit={() => onEdit(t)}
                onDelete={() => onDelete(t)}
              />
              <span className="sub">{countOf(t)}</span>
            </li>
          );
        })}
      </ul>
      {tags.length > 0 && (
        <div
          className={`tag-drop-root${drag.dragId !== null ? " dragging" : ""}${drag.drop?.pos === "root" ? " active" : ""}`}
          data-tree-root="tags"
          data-testid="tag-drop-root"
        />
      )}
      {tags.length === 0 && <div className="sub">タグはまだありません</div>}
    </Collapsible>
  );
}
