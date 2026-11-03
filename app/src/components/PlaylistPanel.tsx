import { useMemo, useState } from "react";
import type { MoveTarget, PlaylistNode } from "../api";
import { reachable } from "../playlistGraph";
import { useStoredIdSet } from "../storage";
import { descendantsAndSelf, parentIds, visibleNodes } from "../tree";
import { useTreeDrag } from "../treeDrag";
import { Collapsible } from "./Collapsible";
import { DragHandle, Twisty } from "./TreeParts";

type Props = {
  playlists: PlaylistNode[];
  /** 中央で開いているプレイリスト */
  openId: number | null;
  busy: boolean;
  onOpen: (id: number) => void;
  onPlay: (id: number) => void;
  onCreate: (name: string) => Promise<boolean>;
  onMove: (id: number, target: MoveTarget) => void;
  /** エフェクトのまとまりの管理画面を開く */
  onManageEffects: () => void;
};

/** 左の欄の「プレイリスト」。階層表示、開く・たたむ、取っ手での並べ替え、作成、再生 */
export function PlaylistPanel({ playlists, openId, busy, onOpen, onPlay, onCreate, onMove, onManageEffects }: Props) {
  const [collapsed, toggleCollapsed] = useStoredIdSet("cyanomelody.playlistTree.collapsed");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

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

  const create = async () => {
    if (await onCreate(name)) {
      setName("");
      setCreating(false);
    }
  };

  return (
    <Collapsible
      id="playlists"
      title="プレイリスト"
      selectedCount={0}
      actions={
        <span className="row">
          <button onClick={onManageEffects} aria-label="エフェクトのまとまりを管理">
            エフェクト
          </button>
          <button onClick={() => setCreating((c) => !c)} aria-label="プレイリストを作る">
            作成
          </button>
        </span>
      }
    >
      {creating && (
        <div className="row" style={{ marginBottom: 4 }}>
          <input
            type="text"
            autoFocus
            placeholder="新しいプレイリストの名前"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) create();
              if (e.key === "Escape") setCreating(false);
            }}
            aria-label="新しいプレイリストの名前"
          />
          <button onClick={create} disabled={busy || !name.trim()}>
            作る
          </button>
        </div>
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
            <button
              className="mini-play"
              title="再生"
              aria-label={`${p.name}を再生`}
              onClick={(e) => {
                e.stopPropagation();
                onPlay(p.id);
              }}
            >
              ▶
            </button>
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
