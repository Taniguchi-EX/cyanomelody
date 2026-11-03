import { useEffect, useState, type ReactNode } from "react";
import { api, playlistApi, type AudioFile, type PlaylistNode, type Tag } from "../api";
import { Collapsible } from "./Collapsible";
import { PlaylistPicker } from "./PlaylistPicker";

type Props = {
  /** 一覧でクリックしたファイル。なければ null */
  file: AudioFile | null;
  tags: Tag[];
  busy: boolean;
  /** タグを付ける。まだない名前なら、最上位に新しいタグを作って付ける */
  onAddTag: (name: string) => Promise<boolean>;
  onRemoveTag: (tagId: number) => void;
  onRemoveMissing: () => void;
  onRelink: () => void;
  onShowSameAudio: (hash: string) => void;
  /** プレイリストの下に出す欄（出典・ライセンス） */
  children?: ReactNode;
  /** 一番上に出す欄（プレイリストの項目を押したときの「プレイリスト上での名前」） */
  top?: ReactNode;
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
  top,
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

  // 候補に出すのは、まだ付いていないタグ
  const attached = new Set(file.tags.map((t) => t.id));
  const candidates = tags.filter((t) => !attached.has(t.id));
  /** 付ける。既にあるタグ名（大文字・小文字は区別しない）ならそのタグを、なければ新しいタグを作って付ける */
  const add = async (input: string) => {
    const key = input.trim().toLowerCase();
    if (!key || busy) return;
    // 既に付いているタグなら何もしない
    if (file.tags.some((t) => t.name.toLowerCase() === key)) {
      setName("");
      return;
    }
    const existing = tags.find((t) => t.name.toLowerCase() === key);
    if (await onAddTag(existing?.name ?? input)) setName("");
  };

  return (
    <section data-testid="detail-panel">
      {top}
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
            placeholder="名前（Enterで付ける）"
            value={name}
            onChange={(e) => {
              // 候補の一覧から選んだとき（打ち込みではなく置き換え）は、すぐに付ける
              const picked = (e.nativeEvent as InputEvent).inputType === "insertReplacementText";
              const tag = picked ? candidates.find((t) => t.name === e.target.value) : undefined;
              if (tag) add(tag.name);
              else setName(e.target.value);
            }}
            onKeyDown={(e) => e.key === "Enter" && add(name)}
            aria-label="付けるタグ名"
          />
          <datalist id="tag-names">
            {candidates.map((t) => (
              <option key={t.id} value={t.name} />
            ))}
          </datalist>
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
        <PlaylistPicker
          playlists={playlists}
          busy={busy}
          onAdd={onAddToPlaylist}
          label="このファイルを加えるプレイリスト"
          immediate
        />
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
            <button
              onClick={onRelink}
              disabled={busy}
              title="ライブラリの中から同じ音声のファイルを探して、タグなどを移す"
            >
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
