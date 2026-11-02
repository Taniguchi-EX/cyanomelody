import { useState } from "react";
import type { PlaylistNode } from "../api";

type Props = {
  playlists: PlaylistNode[];
  busy: boolean;
  /** 選んだプレイリストに加える。終わったら true */
  onAdd: (playlistId: number) => Promise<boolean>;
  /** 入力欄の名前（右の欄と一括操作の欄を区別する） */
  label: string;
};

/** プレイリストを選んで、ファイルを加える */
export function PlaylistPicker({ playlists, busy, onAdd, label }: Props) {
  const [id, setId] = useState("");
  if (playlists.length === 0) return <span className="sub">プレイリストはまだありません</span>;
  return (
    <div className="row">
      <select value={id} onChange={(e) => setId(e.target.value)} aria-label={label}>
        <option value="">（プレイリストを選ぶ）</option>
        {playlists.map((p) => (
          <option key={p.id} value={p.id}>
            {"　".repeat(p.depth)}
            {p.name}
          </option>
        ))}
      </select>
      <button
        onClick={async () => {
          if (await onAdd(Number(id))) setId("");
        }}
        disabled={busy || id === ""}
      >
        追加
      </button>
    </div>
  );
}
