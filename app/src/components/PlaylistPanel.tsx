import { useMemo, useState } from "react";
import type { MoveTarget, PlaylistNode } from "../api";
import { reachable } from "../playlistGraph";
import { useTreeDrag } from "../treeDrag";
import { Collapsible } from "./Collapsible";

type Props = {
  playlists: PlaylistNode[];
  /** 中央で開いているプレイリスト */
  openId: number | null;
  busy: boolean;
  onOpen: (id: number) => void;
  onPlay: (id: number) => void;
  onCreate: (name: string) => Promise<boolean>;
  onMove: (id: number, target: MoveTarget) => void;
};

const COLLAPSED_KEY = "cyanomelody.playlistTree.collapsed";

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

/** 左の欄の「プレイリスト」。階層表示、開く・たたむ、取っ手での並べ替え、作成、再生 */
export function PlaylistPanel({ playlists, openId, busy, onOpen, onPlay, onCreate, onMove }: Props) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const parents = useMemo(() => new Set(playlists.flatMap((p) => (p.parentId === null ? [] : [p.parentId]))), [playlists]);
  const byId = useMemo(() => new Map(playlists.map((p) => [p.id, p])), [playlists]);

  // たたんでいるプレイリストの子孫は出さない
  const shown = useMemo(() => {
    const hidden = new Set<number>();
    return playlists.filter((p) => {
      if (p.parentId !== null && (hidden.has(p.parentId) || collapsed.has(p.parentId))) {
        hidden.add(p.id);
        return false;
      }
      return true;
    });
  }, [playlists, collapsed]);

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
  const moving = useMemo(() => {
    const set = new Set<number>();
    if (drag.dragId === null) return set;
    set.add(drag.dragId);
    // playlists は階層の順（親の次にその子孫）に並んでいるので、1回なめれば足りる
    for (const p of playlists) if (p.parentId !== null && set.has(p.parentId)) set.add(p.id);
    return set;
  }, [playlists, drag.dragId]);

  const toggleCollapsed = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsed(next);
      return next;
    });

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
        <button onClick={() => setCreating((c) => !c)} aria-label="プレイリストを作る">
          作成
        </button>
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
            <span
              className="twisty"
              onClick={(e) => {
                if (!parents.has(p.id)) return;
                e.stopPropagation();
                toggleCollapsed(p.id);
              }}
              role={parents.has(p.id) ? "button" : undefined}
              aria-label={parents.has(p.id) ? `${p.name}を${collapsed.has(p.id) ? "開く" : "たたむ"}` : undefined}
            >
              {parents.has(p.id) ? (collapsed.has(p.id) ? "▶" : "▼") : ""}
            </span>
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
            <span
              className="drag-handle"
              title="ドラッグして並べ替え"
              aria-label={`${p.name}を移す`}
              data-testid="drag-handle"
              {...drag.handleProps(p.id)}
            >
              ≡
            </span>
          </li>
        ))}
      </ul>
      {playlists.length > 0 && (
        <div
          className={`tag-drop-root${drag.drop?.pos === "root" ? " active" : ""}`}
          data-tree-root="playlists"
          data-testid="playlist-drop-root"
        >
          {drag.dragId !== null && "ここに落とすと最上位の最後へ"}
        </div>
      )}
      {playlists.length === 0 && <div className="sub">プレイリストはまだありません</div>}
    </Collapsible>
  );
}
