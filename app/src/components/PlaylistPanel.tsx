import { useMemo, useState } from "react";
import type { MoveTarget, PlaylistNode } from "../api";
import { reachable } from "../playlistGraph";
import { useStoredIdSet } from "../storage";
import { descendantsAndSelf, indentOf, parentIds, searchNodes, visibleNodes } from "../tree";
import { useTreeDrag } from "../treeDrag";
import { Collapsible } from "./Collapsible";
import { NameInput, RowActions, Twisty } from "./TreeParts";

type Props = {
  playlists: PlaylistNode[];
  /** 選んでいる（絞り込みの条件にしている）プレイリスト */
  selectedId: number | null;
  busy: boolean;
  /** 行を押したとき：選ぶ（抽選する）・外す */
  onSelect: (id: number) => void;
  /** 行のダブルクリックと「✎」：編集画面を開く */
  onEdit: (id: number) => void;
  onCreate: (name: string) => Promise<boolean>;
  onDelete: (id: number) => void;
  onMove: (id: number, target: MoveTarget) => void;
  /** 左の欄の検索の文字。あてはまるプレイリスト（と、薄くした祖先）だけを出す */
  query: string;
};

/**
 * 左の欄の「プレイリスト」。押すと選んで（抽選して）絞り込み、もう一度押すと外す。
 * 階層表示、開く・たたむ、ドラッグでの並べ替え、作成・削除。中身と名前は編集画面（「✎」・ダブルクリック）で直す
 */
export function PlaylistPanel({ playlists, selectedId, busy, onSelect, onEdit, onCreate, onDelete, onMove, query }: Props) {
  const [collapsed, toggleCollapsed] = useStoredIdSet("cyanomelody.playlistTree.collapsed");
  const [creating, setCreating] = useState(false);

  const parents = useMemo(() => parentIds(playlists), [playlists]);
  const byId = useMemo(() => new Map(playlists.map((p) => [p.id, p])), [playlists]);

  // 検索しているときは、たたんでいてもあてはまるプレイリストを出す（開閉の状態は変えない）
  const search = useMemo(() => searchNodes(playlists, query), [playlists, query]);
  const shown = useMemo(() => search?.shown ?? visibleNodes(playlists, collapsed), [search, playlists, collapsed]);

  /** 落とした先で入る親（最上位なら null） */
  const containerOf = (target: number, pos: "before" | "after" | "child") =>
    pos === "child" ? target : (byId.get(target)?.parentId ?? null);

  const drag = useTreeDrag({
    tree: "playlists",
    busy,
    // 自分自身の前後には落とせない。入る親が、移すプレイリストから（子・参照を）たどれるならループになる
    canDrop: (dragged, target, pos) => {
      if (target === dragged) return false;
      const container = containerOf(target, pos);
      return container === null || !reachable(playlists, dragged).has(container);
    },
    onMove,
  });
  // 一緒に移る（薄く表示する）のは、移すプレイリストと子孫。参照先は移らない
  const moving = useMemo(
    () => (drag.dragId === null ? new Set<number>() : descendantsAndSelf(playlists, drag.dragId)),
    [playlists, drag.dragId],
  );

  return (
    <Collapsible
      id="playlists"
      title="プレイリスト"
      selectedCount={selectedId !== null ? 1 : 0}
      actions={(expand) => (
        <span className="row">
          <button
            className="icon add-button"
            onClick={() => {
              // たたんでいるときは、開いてから入力欄を出す
              expand();
              setCreating(true);
            }}
            disabled={busy}
            title="プレイリストを作る"
            aria-label="プレイリストを作る"
          >
            ＋
          </button>
        </span>
      )}
    >
      {creating && (
        <NameInput
          label="新しいプレイリストの名前"
          placeholder="新しいプレイリストの名前"
          onCommit={async (name) => {
            if (await onCreate(name)) setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      <ul className={`tag-list tag-tree${drag.dragId !== null ? " dragging" : ""}`}>
        {shown.map((p) => {
          const selected = selectedId === p.id;
          // 通しで流して1曲も鳴らないプレイリストは選べない（編集画面はダブルクリック・「✎」で開ける）
          const disabled = p.trackCount === 0 && !selected;
          return (
            <li
              key={p.id}
              className={
                (selected ? "active" : "") +
                (disabled ? " disabled" : "") +
                (moving.has(p.id) ? " drag-source" : "") +
                (search?.dimmed.has(p.id) ? " search-parent" : "") +
                drag.dropClass(p.id)
              }
              // ダブルクリック（編集画面を開く）の2回目の押しでは、選択を切り替えない
              onClick={(e) => e.detail < 2 && !disabled && onSelect(p.id)}
              onDoubleClick={(e) => {
                if (!(e.target as HTMLElement).closest("button, input")) onEdit(p.id);
              }}
              data-testid="playlist"
              data-tree="playlists"
              data-node-id={p.id}
              data-playlist-name={p.name}
              data-depth={p.depth}
              style={{ paddingLeft: indentOf(p.depth) }}
              {...drag.rowProps(p.id)}
            >
              <Twisty
                name={p.name}
                // 検索しているときは、開閉の印を出さない（あてはまるものをすべて開いて見せる）
                hasChildren={!search && parents.has(p.id)}
                collapsed={collapsed.has(p.id)}
                onToggle={() => toggleCollapsed(p.id)}
                indent={indentOf(p.depth)}
              />
              <span className="tag-name">{p.name}</span>
              <RowActions
                name={p.name}
                busy={busy}
                editLabel="編集"
                onEdit={() => onEdit(p.id)}
                onDelete={() => onDelete(p.id)}
              />
              <span className="sub" title="通しで流したときに鳴る曲の数">
                {p.trackCount}
              </span>
            </li>
          );
        })}
      </ul>
      {playlists.length > 0 && (
        <div
          className={`tag-drop-root${drag.dragId !== null ? " dragging" : ""}${drag.drop?.pos === "root" ? " active" : ""}`}
          data-tree-root="playlists"
          data-testid="playlist-drop-root"
        />
      )}
      {playlists.length === 0 && <div className="sub">プレイリストはまだありません</div>}
    </Collapsible>
  );
}
