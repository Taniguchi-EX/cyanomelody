import { useEffect, useState, type ReactNode } from "react";
import { api, playlistApi, type AudioFile, type PlaylistNode, type Tag } from "../api";
import { Collapsible } from "./Collapsible";
import { PlaylistPicker } from "./PlaylistPicker";

type Props = {
  /** 一覧でクリックしたファイル。なければ null */
  file: AudioFile | null;
  tags: Tag[];
  busy: boolean;
  /** 既にあるタグを付ける（右の欄では新しいタグは作らない） */
  onAddTag: (name: string) => Promise<boolean>;
  onRemoveTag: (tagId: number) => void;
  onRemoveMissing: () => void;
  onRelink: () => void;
  onShowSameAudio: (hash: string) => void;
  /** プレイリストの下に出す欄（出典・ライセンス） */
  children?: ReactNode;
  playlists: PlaylistNode[];
  onAddToPlaylist: (playlistId: number) => Promise<boolean>;
  onOpenPlaylist: (playlistId: number) => void;
};

/** 右の欄。一覧でクリックした1件のファイルの詳細と操作 */
export function SelectionPanel({
  file,
  tags,
  busy,
  onAddTag,
  onRemoveTag,
  onRemoveMissing,
  onRelink,
  onShowSameAudio,
  children,
  playlists,
  onAddToPlaylist,
  onOpenPlaylist,
}: Props) {
  const [name, setName] = useState("");
  // このファイルを直接入れているプレイリスト。プレイリストが変わったら（項目の数が変わる）求め直す
  const [usedIn, setUsedIn] = useState<{ fileId: number; ids: number[] } | null>(null);
  // トラック名はデータベースに持たないので、出すときにファイルから読む
  const [title, setTitle] = useState<{ path: string; title: string | null } | null>(null);
  const fileId = file?.id;
  const filePath = file && !file.missing ? file.path : null;
  useEffect(() => {
    if (fileId === undefined) return;
    let alive = true;
    playlistApi
      .withFile(fileId)
      .then((ids) => alive && setUsedIn({ fileId, ids }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [fileId, playlists]);
  useEffect(() => {
    if (filePath === null) return;
    let alive = true;
    api
      .trackTitle(filePath)
      .then((t) => alive && setTitle({ path: filePath, title: t }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [filePath]);
  const usedInIds = usedIn && usedIn.fileId === fileId ? usedIn.ids : [];
  // 左の欄と同じ並び
  const usedInPlaylists = playlists.filter((p) => usedInIds.includes(p.id));
  const trackTitle = title && title.path === filePath ? title.title : null;

  if (!file) return null;

  // 付けられるのは、既にあって、まだ付いていないタグだけ
  const attached = new Set(file.tags.map((t) => t.id));
  const candidates = tags.filter((t) => !attached.has(t.id));
  const match = candidates.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
  const add = async () => {
    if (match && (await onAddTag(match.name))) setName("");
  };

  return (
    <section data-testid="detail-panel">
      {trackTitle && (
        <div className="track-title" data-testid="track-title">
          {trackTitle}
        </div>
      )}
      <div className="folder-path" data-testid="detail-path" title={file.path}>
        {file.relPath}
      </div>

      <Collapsible id="detail-tags" title="タグ" count={file.tags.length}>
        <div className="row">
          <input
            type="text"
            list="tag-names"
            placeholder="名前"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            aria-label="付けるタグ名"
          />
          <datalist id="tag-names">
            {candidates.map((t) => (
              <option key={t.id} value={t.name} />
            ))}
          </datalist>
          <button className="icon" onClick={add} disabled={busy || !match} title="付ける" aria-label="付ける">
            ＋
          </button>
        </div>
        <ul className="selected-tags">
          {file.tags.map((t) => (
            <li key={t.id} data-testid="selected-tag">
              <span>{t.name}</span>
              <button
                className="icon"
                onClick={() => onRemoveTag(t.id)}
                disabled={busy}
                title="外す"
                aria-label={`${t.name}を外す`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </Collapsible>

      <Collapsible id="detail-playlists" title="プレイリスト" count={usedInPlaylists.length}>
        {usedInPlaylists.length > 0 && (
          <div className="used-in" data-testid="used-in">
            {usedInPlaylists.map((p) => (
              <button key={p.id} className="chip" onClick={() => onOpenPlaylist(p.id)} title="開く">
                {p.name}
              </button>
            ))}
          </div>
        )}
        <PlaylistPicker playlists={playlists} busy={busy} onAdd={onAddToPlaylist} label="このファイルを加えるプレイリスト" />
      </Collapsible>

      {children}

      <h2>ハッシュ値</h2>
      <div className="folder-path" data-testid="selected-hash">
        {file.hash ?? (file.hashError ? `計算できませんでした（${file.hashError}）` : "未計算")}
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <button onClick={() => file.hash && onShowSameAudio(file.hash)} disabled={!file.hash}>
          同じ音声のファイルを探す
        </button>
      </div>

      {file.missing && (
        <>
          <h2 className="warn">⚠ 見つからないファイル</h2>
          <div className="row">
            <button onClick={onRelink} disabled={busy} title="ライブラリの中から同じ音声のファイルを探して、タグなどを移す">
              ひも付け直す
            </button>
            <button onClick={onRemoveMissing} disabled={busy} title="ファイルの情報と、付けたタグなどの設定を消す">
              ライブラリから外す
            </button>
          </div>
        </>
      )}
    </section>
  );
}
