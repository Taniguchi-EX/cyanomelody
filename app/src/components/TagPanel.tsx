import { useMemo, useRef, useState } from "react";
import type { Facets, FileFilter, MoveTarget, Tag } from "../api";
import { descendantsAndSelf, parentIds, visibleTags } from "../tagTree";
import { Collapsible } from "./Collapsible";

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

/** ドラッグ中に、どこに落とすかの表示 */
type Drop = { tagId: number; pos: "before" | "after" | "child" } | { tagId: null; pos: "root" };

const COLLAPSED_KEY = "cyanomelody.tagTree.collapsed";
/** この距離（px）より動かしたらドラッグとみなす */
const DRAG_THRESHOLD = 4;

function loadCollapsed(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as number[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: Set<number>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // 覚えておけなくても動作には困らない
  }
}

export function TagPanel({ tags, filter, busy, onToggleTag, onToggleUntagged, onManage, onMove, facets }: Props) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [dragId, setDragId] = useState<number | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const start = useRef<{ tag: Tag; x: number; y: number; moving: boolean } | null>(null);

  const parents = useMemo(() => parentIds(tags), [tags]);
  // 選んだときの件数。0件になる項目はグレーアウトし、選べないようにする（選んでいる項目は外せる）
  const facetMap = useMemo(() => new Map(facets?.tags.map((c) => [c.id, c.count])), [facets]);
  const countOf = (t: Tag) => (facets ? (facetMap.get(t.id) ?? 0) : t.fileCount);
  const untaggedCount = facets?.untagged ?? null;
  const untaggedDisabled = untaggedCount === 0 && !filter.untaggedOnly;
  const shown = useMemo(() => visibleTags(tags, collapsed), [tags, collapsed]);
  const forbidden = useMemo(
    () => (dragId === null ? new Set<number>() : descendantsAndSelf(tags, dragId)),
    [tags, dragId],
  );

  const toggleCollapsed = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsed(next);
      return next;
    });
  };

  /** ポインタの下にある、落とせる場所 */
  const dropAt = (x: number, y: number, dragging: number): Drop | null => {
    const el = document.elementFromPoint(x, y);
    if (el?.closest("[data-drop-root]")) return { tagId: null, pos: "root" };
    const row = el?.closest<HTMLElement>("[data-tag-id]");
    if (!row) return null;
    const tagId = Number(row.dataset.tagId);
    const banned = descendantsAndSelf(tags, dragging);
    if (banned.has(tagId)) return null;
    const rect = row.getBoundingClientRect();
    const ratio = (y - rect.top) / rect.height;
    // 上の端は前、下の端は後ろ、真ん中は子の最後
    const pos = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "child";
    return { tagId, pos };
  };

  const onPointerDown = (e: React.PointerEvent, tag: Tag) => {
    if (busy || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { tag, x: e.clientX, y: e.clientY, moving: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    if (!s.moving) {
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_THRESHOLD) return;
      s.moving = true;
      setDragId(s.tag.id);
    }
    setDrop(dropAt(e.clientX, e.clientY, s.tag.id));
  };

  const finish = (e: React.PointerEvent, commit: boolean) => {
    const s = start.current;
    start.current = null;
    setDragId(null);
    setDrop(null);
    if (!s?.moving || !commit) return;
    const d = dropAt(e.clientX, e.clientY, s.tag.id);
    if (!d) return;
    onMove(s.tag, d.tagId === null ? { kind: "root" } : { kind: d.pos, tagId: d.tagId });
  };

  const dropClass = (id: number) => (drop && drop.tagId === id ? ` drop-${drop.pos}` : "");

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
      <ul className={`tag-list tag-tree${dragId !== null ? " dragging" : ""}`}>
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
                (forbidden.has(t.id) ? " drag-source" : "") +
                dropClass(t.id)
              }
              onClick={() => !disabled && onToggleTag(t.id)}
              aria-disabled={disabled}
              data-testid="tag"
              data-tag-id={t.id}
              data-tag-name={t.name}
              data-depth={t.depth}
              style={{ paddingLeft: 6 + t.depth * 14 }}
            >
              <span
                className="twisty"
                onClick={(e) => {
                  // 子のないタグでは、行のクリック（絞り込み）として扱う
                  if (!parents.has(t.id)) return;
                  e.stopPropagation();
                  toggleCollapsed(t.id);
                }}
                role={parents.has(t.id) ? "button" : undefined}
                aria-label={parents.has(t.id) ? `${t.name}を${collapsed.has(t.id) ? "開く" : "たたむ"}` : undefined}
                data-testid="tag-twisty"
              >
                {parents.has(t.id) ? (collapsed.has(t.id) ? "▶" : "▼") : ""}
              </span>
              <span className="tag-name">{t.name}</span>
              <span className="sub">{countOf(t)}</span>
              <span
                className="drag-handle"
                title="ドラッグして並べ替え"
                aria-label={`${t.name}を移す`}
                data-testid="drag-handle"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => onPointerDown(e, t)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => finish(e, true)}
                onPointerCancel={(e) => finish(e, false)}
              >
                ≡
              </span>
            </li>
          );
        })}
      </ul>
      {tags.length > 0 && (
        <div
          className={`tag-drop-root${drop?.pos === "root" ? " active" : ""}`}
          data-drop-root
          data-testid="tag-drop-root"
        >
          {dragId !== null && "ここに落とすと最上位の最後へ"}
        </div>
      )}
      {tags.length === 0 && <div className="sub">タグはまだありません</div>}
    </Collapsible>
  );
}
