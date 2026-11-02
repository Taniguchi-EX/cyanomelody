import { useMemo } from "react";
import type { Facets, FileFilter, MoveTarget, Tag } from "../api";
import { useStoredIdSet } from "../storage";
import { descendantsAndSelf, parentIds, visibleNodes } from "../tree";
import { useTreeDrag } from "../treeDrag";
import { Collapsible } from "./Collapsible";
import { DragHandle, Twisty } from "./TreeParts";

type Props = {
  tags: Tag[];
  filter: FileFilter;
  busy: boolean;
  onToggleTag: (tagId: number) => void;
  onToggleUntagged: () => void;
  onManage: () => void;
  onMove: (tag: Tag, target: MoveTarget) => void;
  /** 各項目を選んだときの件数。まだ求めていなければ null（タグの総数を出す） */
  facets: Facets | null;
};

/** 左の欄の「タグで絞り込む」。階層表示、開く・たたむ、取っ手での並べ替え、選んだときの件数とグレーアウト */
export function TagPanel({ tags, filter, busy, onToggleTag, onToggleUntagged, onManage, onMove, facets }: Props) {
  const [collapsed, toggleCollapsed] = useStoredIdSet("cyanomelody.tagTree.collapsed");

  const parents = useMemo(() => parentIds(tags), [tags]);
  // 選んだときの件数。0件になる項目はグレーアウトし、選べないようにする（選んでいる項目は外せる）
  const facetMap = useMemo(() => new Map(facets?.tags.map((c) => [c.id, c.count])), [facets]);
  const countOf = (t: Tag) => (facets ? (facetMap.get(t.id) ?? 0) : t.fileCount);
  const untaggedCount = facets?.untagged ?? null;
  const untaggedDisabled = untaggedCount === 0 && !filter.untaggedOnly;
  const shown = useMemo(() => visibleNodes(tags, collapsed), [tags, collapsed]);

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
      title="タグで絞り込む"
      selectedCount={filter.tagIds.length + (filter.untaggedOnly ? 1 : 0)}
      actions={
        <button onClick={onManage} aria-label="タグを管理">
          管理
        </button>
      }
    >
      <ul className={`tag-list tag-tree${drag.dragId !== null ? " dragging" : ""}`}>
        <li
          className={(filter.untaggedOnly ? "active" : "") + (untaggedDisabled ? " disabled" : "")}
          onClick={() => !untaggedDisabled && onToggleUntagged()}
          aria-disabled={untaggedDisabled}
          data-testid="untagged"
        >
          <span className="tag-name">（タグなし）</span>
          {untaggedCount !== null && <span className="sub">{untaggedCount}</span>}
        </li>
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
                drag.dropClass(t.id)
              }
              onClick={() => !disabled && onToggleTag(t.id)}
              aria-disabled={disabled}
              data-testid="tag"
              data-tree="tags"
              data-node-id={t.id}
              data-tag-name={t.name}
              data-depth={t.depth}
              style={{ paddingLeft: 6 + t.depth * 14 }}
            >
              <Twisty
                name={t.name}
                hasChildren={parents.has(t.id)}
                collapsed={collapsed.has(t.id)}
                onToggle={() => toggleCollapsed(t.id)}
              />
              <span className="tag-name">{t.name}</span>
              <span className="sub">{countOf(t)}</span>
              <DragHandle name={t.name} handlers={drag.handleProps(t.id)} />
            </li>
          );
        })}
      </ul>
      {tags.length > 0 && (
        <div
          className={`tag-drop-root${drag.drop?.pos === "root" ? " active" : ""}`}
          data-tree-root="tags"
          data-testid="tag-drop-root"
        >
          {drag.dragId !== null && "ここに落とすと最上位の最後へ"}
        </div>
      )}
      {tags.length === 0 && <div className="sub">タグはまだありません</div>}
    </Collapsible>
  );
}
