import type { PlaylistNode } from "../api";

type Props = {
  playlists: PlaylistNode[];
  busy: boolean;
  /** 選んだプレイリストに加える */
  onAdd: (playlistId: number) => void;
};

/** 右の欄の、ファイルを加えるプレイリストのプルダウン。選ぶとすぐ加え、「（プレイリストを選ぶ）」に戻る */
export function PlaylistPicker({ playlists, busy, onAdd }: Props) {
  if (playlists.length === 0) return <span className="sub">プレイリストはまだありません</span>;
  return (
    <select
      value=""
      onChange={(e) => e.target.value !== "" && onAdd(Number(e.target.value))}
      disabled={busy}
      aria-label="このファイルを加えるプレイリスト"
    >
      <option value="">（プレイリストを選ぶ）</option>
      {playlists.map((p) => (
        <option key={p.id} value={p.id}>
          {"　".repeat(p.depth)}
          {p.name}
        </option>
      ))}
    </select>
  );
}
