import { useMemo, useState } from "react";
import type { MoveTarget, PlaylistNode } from "../api";
import { reachable } from "../playlistGraph";
import { useStoredIdSet } from "../storage";
import { descendantsAndSelf, parentIds, visibleNodes } from "../tree";
import { useTreeDrag } from "../treeDrag";
import { Collapsible } from "./Collapsible";
import { DragHandle, NameInput, Twisty } from "./TreeParts";

type Props = {
  playlists: PlaylistNode[];
  /** 中央で開いているプレイリスト */
  openId: number | null;
  busy: boolean;
  onOpen: (id: number) => void;
  onCreate: (name: string) => Promise<boolean>;
  onMove: (id: number, target: MoveTarget) => void;
  /** エフェクトのまとまりの管理画面を開く */
  onManageEffects: () => void;
};

/** 左の欄の「プレイリスト」。階層表示、開く・たたむ、取っ手での並べ替え、作成（再生・名前変更・削除は中央の詳細画面で行う） */
export function PlaylistPanel({ playlists, openId, busy, onOpen, onCreate, onMove, onManageEffects }: Props) {
  const [collapsed, toggleCollapsed] = useStoredIdSet("cyanomelody.playlistTree.collapsed");
  const [creating, setCreating] = useState(false);

  const parents = useMemo(() => parentIds(playlists), [playlists]);
  const byId = useMemo(() => new Map(playlists.map((p) => [p.id, p])), [playlists]);

  const shown = useMemo(() => visibleNodes(playlists, collapsed), [playlists, collapsed]);

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
      selectedCount={0}
      actions={(expand) => (
        <span className="row">
          <button onClick={onManageEffects} aria-label="エフェクトのまとまりを管理">
            エフェクト
          </button>
          <button
            className="icon"
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
        {shown.map((p) => (
          <li
            key={p.id}
            className={
              (openId === p.id ? "active" : "") + (moving.has(p.id) ? " drag-source" : "") + drag.dropClass(p.id)
            }
            onClick={() => onOpen(p.id)}
            data-testid="playlist"
            data-tree="playlists"
            data-node-id={p.id}
            data-playlist-name={p.name}
            data-depth={p.depth}
            style={{ paddingLeft: 6 + p.depth * 14 }}
          >
            <Twisty
              name={p.name}
              hasChildren={parents.has(p.id)}
              collapsed={collapsed.has(p.id)}
              onToggle={() => toggleCollapsed(p.id)}
            />
            <span className="tag-name">{p.name}</span>
            <span className="sub">{p.itemCount}</span>
            <DragHandle name={p.name} handlers={drag.handleProps(p.id)} />
          </li>
        ))}
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
