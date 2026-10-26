// プレイリストの一覧。お気に入りを上に表示する（並べ替えは Rust 側で行う）。

import { useCallback, useEffect, useState } from "react";
import { api, type Summary } from "../api";
import { useShared } from "../state";

export default function PlaylistList({ onOpen }: { onOpen: (id: string) => void }) {
  const { offline, run } = useShared();
  const [list, setList] = useState<Summary[] | null>(null);
  const [name, setName] = useState("");

  const reload = useCallback(async () => {
    const result = await run("プレイリストの読み込み", api.listPlaylists);
    if (result) setList(result);
  }, [run]);
  useEffect(() => {
    reload();
  }, [reload]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const created = await run("プレイリストの作成", () => api.createPlaylist(trimmed));
    if (created) {
      setName("");
      onOpen(created.id);
    }
  };

  return (
    <section>
      <div className="row">
        <input
          value={name}
          placeholder="新しいプレイリストの名前"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          disabled={offline}
        />
        <button onClick={create} disabled={offline || !name.trim()}>
          作成
        </button>
        <button onClick={reload} title="Drive から読み直す">
          更新
        </button>
      </div>
      {list === null ? (
        <p className="empty">読み込んでいます…</p>
      ) : list.length === 0 ? (
        <p className="empty">プレイリストがありません。</p>
      ) : (
        <ul className="list">
          {list.map((p) => (
            <li key={p.id} onClick={() => onOpen(p.id)} className="clickable">
              <span className="star">{p.favorite ? "★" : ""}</span>
              <span className="grow">{p.name}</span>
              <span className="dim">{p.count} 曲</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
