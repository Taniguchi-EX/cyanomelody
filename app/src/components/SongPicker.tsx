// 曲を選んでプレイリストに追加する画面。指定フォルダをたどり、ファイル単位かフォルダ単位で追加する。

import { useEffect, useState } from "react";
import { api, type Listing, type Playlist, type SourceName } from "../api";
import { useShared } from "../state";

export default function SongPicker({ playlist, onDone }: { playlist: Playlist; onDone: (p: Playlist | null) => void }) {
  const { run, busy } = useShared();
  const [source, setSource] = useState<SourceName>("drive");
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [latest, setLatest] = useState<Playlist | null>(null);
  const [added, setAdded] = useState(0);

  useEffect(() => {
    api.browse(source, folder).then(setListing).catch(() => setListing({ folders: [], songs: [] }));
  }, [source, folder]);

  const parts = folder ? folder.split("/") : [];
  const enter = (name: string) => setFolder(folder ? `${folder}/${name}` : name);
  const up = () => setFolder(parts.slice(0, -1).join("/"));

  const add = async (label: string, action: () => Promise<Playlist>, count: number) => {
    const p = await run(label, action);
    if (p) {
      setLatest(p);
      setAdded((n) => n + count);
    }
  };

  return (
    <section>
      <div className="row">
        <button onClick={() => onDone(latest)}>← 完了</button>
        <h2 className="grow">「{playlist.name}」に追加</h2>
        {added > 0 && <span className="dim">{added} 曲を追加しました</span>}
      </div>
      <div className="row">
        <button className={source === "drive" ? "tab active" : "tab"} onClick={() => { setSource("drive"); setFolder(""); }}>
          Google Drive
        </button>
        <button className={source === "local" ? "tab active" : "tab"} onClick={() => { setSource("local"); setFolder(""); }}>
          この端末
        </button>
      </div>
      <div className="row path">
        <button className="icon" disabled={!folder} onClick={up} title="上のフォルダへ">
          ↑
        </button>
        <span className="grow">/{folder}</span>
        {folder && (
          <button disabled={busy !== null} onClick={() => add("フォルダの追加", () => api.addFolder(playlist.id, source, folder), 0)}>
            このフォルダを全部追加
          </button>
        )}
      </div>
      {listing === null ? (
        <p className="empty">読み込んでいます…</p>
      ) : listing.folders.length === 0 && listing.songs.length === 0 ? (
        <p className="empty">曲がありません。設定のタブで指定フォルダを選び、「曲の一覧を更新」を押してください。</p>
      ) : (
        <ul className="list">
          {listing.folders.map((name) => (
            <li key={`f-${name}`}>
              <span className="grow clickable" onClick={() => enter(name)}>
                📁 {name}
              </span>
              <button
                disabled={busy !== null}
                onClick={() => add("フォルダの追加", () => api.addFolder(playlist.id, source, folder ? `${folder}/${name}` : name), 0)}
              >
                フォルダごと追加
              </button>
            </li>
          ))}
          {listing.songs.map((song) => (
            <li key={`s-${song.key}`}>
              <span className="grow">
                {song.title}
                {song.artist && <span className="dim"> / {song.artist}</span>}
              </span>
              <button disabled={busy !== null} onClick={() => add("曲の追加", () => api.addSong(playlist.id, source, song.key), 1)}>
                追加
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
