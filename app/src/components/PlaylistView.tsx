// プレイリストの中身。再生、曲の追加・削除・並べ替え、名前の変更、お気に入り、削除。

import { useCallback, useEffect, useState } from "react";
import { api, type Playlist } from "../api";
import { useShared } from "../state";
import SongPicker from "./SongPicker";

export default function PlaylistView({ id, onBack }: { id: string; onBack: () => void }) {
  const { offline, busy, run } = useShared();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const p = await run("プレイリストの読み込み", () => api.getPlaylist(id));
    if (p) setPlaylist(p);
  }, [id, run]);
  useEffect(() => {
    reload();
  }, [reload]);

  // 編集は Rust 側で Drive から読み直してから保存し、保存後の内容を返す
  const edit = async (label: string, action: () => Promise<Playlist>) => {
    const p = await run(label, action);
    if (p) setPlaylist(p);
  };

  if (!playlist) {
    return (
      <section>
        <button onClick={onBack}>← 一覧</button>
        <p className="empty">読み込んでいます…</p>
      </section>
    );
  }

  if (picking) {
    return <SongPicker playlist={playlist} onDone={(p) => { if (p) setPlaylist(p); setPicking(false); }} />;
  }

  const locked = offline || busy !== null;
  const remove = async () => {
    if (!window.confirm(`「${playlist.name}」を削除しますか？（Google Drive のゴミ箱に移します）`)) return;
    const done = await run("プレイリストの削除", () => api.deletePlaylist(id));
    if (done !== undefined) onBack();
  };

  return (
    <section>
      <div className="row">
        <button onClick={onBack}>← 一覧</button>
        {renaming === null ? (
          <h2 className="grow">{playlist.name}</h2>
        ) : (
          <input
            className="grow"
            value={renaming}
            autoFocus
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renaming.trim()) {
                edit("名前の変更", () => api.renamePlaylist(id, renaming.trim()));
                setRenaming(null);
              }
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        )}
        <button
          className={playlist.favorite ? "star on" : "star"}
          disabled={locked}
          title="お気に入り"
          onClick={() => edit("お気に入りの変更", () => api.setFavorite(id, !playlist.favorite))}
        >
          ★
        </button>
      </div>
      <div className="row">
        <button className="primary" disabled={playlist.items.length === 0} onClick={() => run("再生", () => api.play(id, 0))}>
          ▶ 最初から再生
        </button>
        <button disabled={locked} onClick={() => setPicking(true)}>
          ＋ 曲を追加
        </button>
        <button disabled={locked} onClick={() => setRenaming(playlist.name)}>
          名前の変更
        </button>
        <button disabled={locked} onClick={remove}>
          削除
        </button>
      </div>
      {playlist.items.length === 0 ? (
        <p className="empty">曲がありません。「曲を追加」から追加してください。</p>
      ) : (
        <ol className="list">
          {playlist.items.map((item, i) => (
            <li key={`${i}-${item.key}`} className={item.available ? "" : "unavailable"}>
              <button className="icon" title="ここから再生" onClick={() => run("再生", () => api.play(id, i))}>
                ▶
              </button>
              <span className="grow">
                {item.title}
                {item.artist && <span className="dim"> / {item.artist}</span>}
                {item.source === "local" && <span className="tag">ローカル</span>}
              </span>
              <button className="icon" disabled={locked || i === 0} title="上へ" onClick={() => edit("並べ替え", () => api.moveItem(id, i, i - 1))}>
                ↑
              </button>
              <button
                className="icon"
                disabled={locked || i === playlist.items.length - 1}
                title="下へ"
                onClick={() => edit("並べ替え", () => api.moveItem(id, i, i + 1))}
              >
                ↓
              </button>
              <button className="icon" disabled={locked} title="プレイリストから外す" onClick={() => edit("曲の削除", () => api.removeItem(id, i))}>
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
