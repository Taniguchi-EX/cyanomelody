import { useState, type ReactNode } from "react";
import type { AudioFile, PlaylistNode, Tag } from "../api";
import { PlaylistPicker } from "./PlaylistPicker";

type Props = {
  /** 一覧でクリックしたファイル。なければ null */
  file: AudioFile | null;
  tags: Tag[];
  busy: boolean;
  onAddTag: (name: string) => Promise<boolean>;
  onRemoveTag: (tagId: number) => void;
  onRemoveMissing: () => void;
  onRelink: () => void;
  onShowSameAudio: (hash: string) => void;
  /** タグの下に出す欄（出典・ライセンス） */
  children?: ReactNode;
  playlists: PlaylistNode[];
  onAddToPlaylist: (playlistId: number) => Promise<boolean>;
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
}: Props) {
  const [name, setName] = useState("");

  if (!file) {
    return (
      <section>
        <h2>ファイルの詳細</h2>
        <div className="sub">一覧のファイルをクリックすると、ここに詳細が出ます</div>
      </section>
    );
  }

  const add = async () => {
    if (await onAddTag(name)) setName("");
  };

  return (
    <section data-testid="detail-panel">
      <h2>ファイルの詳細</h2>
      <div className="folder-path" data-testid="detail-path">
        {file.relPath}
      </div>
      <div className="folder-path sub">{file.path}</div>
      <h2>ハッシュ値</h2>
      <div className="folder-path hash" data-testid="selected-hash">
        {file.hash ?? (file.hashError ? `計算できませんでした（${file.hashError}）` : "未計算")}
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <button onClick={() => file.hash && onShowSameAudio(file.hash)} disabled={!file.hash}>
          同じ音声のファイルを探す
        </button>
      </div>

      <h2>タグを付ける</h2>
      <div className="row">
        <input
          type="text"
          list="tag-names"
          placeholder="タグ名（新しい名前なら作成）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && add()}
          aria-label="付けるタグ名"
        />
        <datalist id="tag-names">
          {tags.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
        <button onClick={add} disabled={busy || !name.trim()}>
          付ける
        </button>
      </div>

      <h2>付いているタグ</h2>
      {file.tags.length === 0 && <div className="sub">タグは付いていません</div>}
      <ul className="selected-tags">
        {file.tags.map((t) => (
          <li key={t.id} data-testid="selected-tag">
            <span>{t.name}</span>
            <button
              onClick={() => onRemoveTag(t.id)}
              disabled={busy}
              aria-label={`${t.name}を外す`}
            >
              外す
            </button>
          </li>
        ))}
      </ul>

      {children}

      <h2>プレイリストに追加</h2>
      <PlaylistPicker playlists={playlists} busy={busy} onAdd={onAddToPlaylist} label="このファイルを加えるプレイリスト" />

      {file.missing && (
        <>
          <h2>見つからないファイル</h2>
          <div className="sub">
            このファイルは見つかりません。
            「ひも付け直す」で、ライブラリの中から同じ音声のファイルを探してタグなどを移します。
          </div>
          <div className="row" style={{ marginTop: 4 }}>
            <button onClick={onRelink} disabled={busy}>
              ひも付け直す
            </button>
            <button onClick={onRemoveMissing} disabled={busy}>
              ライブラリから外す
            </button>
          </div>
        </>
      )}
    </section>
  );
}
