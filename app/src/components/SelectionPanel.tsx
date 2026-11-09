import { useEffect, useState, type ReactNode } from "react";
import { api, playlistApi, type AudioFile, type PlaylistNode, type Tag } from "../api";
import { stem } from "../paths";
import { tagStyle } from "../tagColors";
import { Collapsible } from "./Collapsible";
import { Chip } from "./FilterChips";
import { PlaylistPicker } from "./PlaylistPicker";
import { TagInput } from "./TagInput";

type Props = {
  /** 一覧でクリックしたファイル。なければ null */
  file: AudioFile | null;
  tags: Tag[];
  busy: boolean;
  /** タグを付ける。まだない名前なら、最上位に新しいタグを作って付ける */
  onAddTag: (name: string) => Promise<boolean>;
  onRemoveTag: (tagId: number) => void;
  /** 「ファイルの情報からタグを付ける」（確認のダイアログを出す） */
  onAutotag: () => void;
  /** 「ファイルを削除する」（確認のダイアログを出す） */
  onDelete: () => void;
  onRemoveMissing: () => void;
  onRelink: () => void;
  /** 見つからないファイルを、選んだファイルにひも付ける */
  onLinkFile: () => void;
  /** 見つからないファイルと同じ音声のファイルを、選んだフォルダから探す */
  onFindInFolder: () => void;
  onShowSameAudio: (hash: string) => void;
  /** ファイルのあるフォルダを、そのファイルを選んだ状態でエクスプローラーで開く */
  onReveal: (path: string) => void;
  /** プレイリストの下に出す欄（出典・ライセンス） */
  children?: ReactNode;
  /** 一番上に出す欄（プレイリストの項目を押したときの「プレイリスト上での名前」） */
  top?: ReactNode;
  playlists: PlaylistNode[];
  onAddToPlaylist: (playlistId: number) => void;
  onOpenPlaylist: (playlistId: number) => void;
  /** そのプレイリストから、このファイルの項目を外す */
  onRemoveFromPlaylist: (playlistId: number) => void;
};

/** 右の欄。一覧でクリックした1件のファイルの詳細と操作 */
export function SelectionPanel({
  file,
  tags,
  busy,
  onAddTag,
  onRemoveTag,
  onAutotag,
  onDelete,
  onRemoveMissing,
  onRelink,
  onLinkFile,
  onFindInFolder,
  onShowSameAudio,
  onReveal,
  children,
  top,
  playlists,
  onAddToPlaylist,
  onOpenPlaylist,
  onRemoveFromPlaylist,
}: Props) {
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
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const candidates = tags.filter((t) => !attached.has(t.id));

  return (
    <section data-testid="detail-panel">
      {top}
      {/* タイトル（曲名、なければ拡張子を除いたファイル名）と、ファイルのパス。パスを押すとエクスプローラーで見せる */}
      <div className="track-title" data-testid="track-title">
        {trackTitle ?? stem(file.relPath)}
      </div>
      {file.missing ? (
        <div className="folder-path" data-testid="detail-path">
          {file.path}
        </div>
      ) : (
        <a
          href="#"
          className="folder-path folder-link"
          data-testid="detail-path"
          title="エクスプローラーで見せる"
          onClick={(e) => {
            e.preventDefault();
            onReveal(file.path);
          }}
        >
          {file.path}
        </a>
      )}

      <Collapsible id="detail-tags" title="タグ" count={file.tags.length}>
        <TagInput
          candidates={candidates}
          attachedNames={tags.filter((t) => attached.has(t.id)).flatMap((t) => [t.name, ...t.synonyms])}
          busy={busy}
          onAdd={onAddTag}
        />
        {/* 付いているタグ。左の欄の絞り込みの条件と同じ形のチップで、押すと外す */}
        {file.tags.length > 0 && (
          <div className="filter-chips detail-chips">
            {file.tags.map((t) => (
              <Chip
                key={t.id}
                icon="🏷"
                label={t.name}
                onClick={() => onRemoveTag(t.id)}
                disabled={busy}
                title="押すと外す"
                ariaLabel={`${t.name}を外す`}
                testId="selected-tag"
                tagName={t.name}
                style={tagStyle(tagById.get(t.id))}
              />
            ))}
          </div>
        )}
        <div className="row autotag-row">
          <button
            onClick={onAutotag}
            disabled={busy || file.missing}
            title={file.missing ? "見つからないファイルは読めません" : "アーティスト・アルバム・ジャンル・作曲者のタグを付ける"}
          >
            ファイルの情報からタグを付ける
          </button>
        </div>
      </Collapsible>

      <Collapsible id="detail-playlists" title="プレイリスト" count={usedInPlaylists.length}>
        {/* 入っているプレイリスト。名前を押すと開き、「✕」でそのプレイリストから外す */}
        {usedInPlaylists.length > 0 && (
          <div className="filter-chips detail-chips" data-testid="used-in">
            {usedInPlaylists.map((p) => (
              <span key={p.id} className="chip filter-chip" data-playlist-name={p.name}>
                <button className="chip-part" onClick={() => onOpenPlaylist(p.id)} title="開く" aria-label={`${p.name}を開く`}>
                  <span className="chip-icon">📃</span>
                  {p.name}
                </button>
                <button
                  className="chip-part chip-x"
                  onClick={() => onRemoveFromPlaylist(p.id)}
                  disabled={busy}
                  title="このプレイリストから外す"
                  aria-label={`${p.name}から外す`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <PlaylistPicker playlists={playlists} busy={busy} onAdd={onAddToPlaylist} />
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
          <div className="row" style={{ marginTop: 4 }}>
            <button onClick={onLinkFile} disabled={busy} title="ファイルを選んで、タグなどをそのファイルに移す">
              ファイルを紐づける
            </button>
            <button
              onClick={onFindInFolder}
              disabled={busy || !file.hash}
              title={
                file.hash
                  ? "フォルダを選んで、その中から同じ音声のファイルを探す"
                  : "ハッシュ値がないため、同じ音声のファイルを探せません"
              }
            >
              指定フォルダから自動で探す
            </button>
          </div>
        </>
      )}
      {/* 実際のファイルも消す操作は、一番下に置く */}
      <div className="row delete-row">
        <button
          className="danger"
          onClick={onDelete}
          disabled={busy || file.missing}
          title={file.missing ? "見つからないファイルは「ライブラリから外す」で外せます" : "ごみ箱に移し、ライブラリから外す"}
        >
          ファイルを削除する
        </button>
      </div>
    </section>
  );
}
