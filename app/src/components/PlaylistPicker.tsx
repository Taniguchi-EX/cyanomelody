import { useState } from "react";
import type { PlaylistNode } from "../api";

type Props = {
  playlists: PlaylistNode[];
  busy: boolean;
  /** 選んだプレイリストに加える。終わったら true */
  onAdd: (playlistId: number) => Promise<boolean>;
  /** 入力欄の名前（右の欄と一括操作の欄を区別する） */
  label: string;
  /** 選んだらすぐに加える（「追加」ボタンを出さない）。右の欄で使う */
  immediate?: boolean;
};

/** プレイリストを選んで、ファイルを加える */
export function PlaylistPicker({ playlists, busy, onAdd, label, immediate = false }: Props) {
  const [id, setId] = useState("");
  if (playlists.length === 0) return <span className="sub">プレイリストはまだありません</span>;
  const select = (value: string) => {
    // すぐに加えるときは、加えたらプルダウンを「（プレイリストを選ぶ）」に戻す
    if (immediate) {
      if (value !== "") onAdd(Number(value));
    } else {
      setId(value);
    }
  };
  return (
    <div className="row">
      <select value={immediate ? "" : id} onChange={(e) => select(e.target.value)} disabled={busy} aria-label={label}>
        <option value="">（プレイリストを選ぶ）</option>
        {playlists.map((p) => (
          <option key={p.id} value={p.id}>
            {"　".repeat(p.depth)}
            {p.name}
          </option>
        ))}
      </select>
      {!immediate && (
        <button
          onClick={async () => {
            if (await onAdd(Number(id))) setId("");
          }}
          disabled={busy || id === ""}
        >
          追加
        </button>
      )}
    </div>
  );
}
