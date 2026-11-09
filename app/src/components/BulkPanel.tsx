import { useEffect, useRef, useState } from "react";
import { api, type BulkSummary, type Credit, type CreditKind, type PlaylistNode, type Tag, type TagCount } from "../api";
import { CREDIT_LABEL } from "../credits";
import { tagStyle } from "../tagColors";
import { Collapsible } from "./Collapsible";
import { Chip } from "./FilterChips";
import { PlaylistPicker } from "./PlaylistPicker";
import { TagInput } from "./TagInput";

const MIXED = "mixed";

type Props = {
  /** 対象のファイル（チェックしたファイル、またはチェックした項目に入る曲） */
  fileIds: number[];
  /** 対象の説明（「チェックしたファイル」など） */
  targetLabel: string;
  tags: Tag[];
  playlists: PlaylistNode[];
  creditsOf: (kind: CreditKind) => Credit[];
  busy: boolean;
  /** データを読み直すたびに変わる（内訳を数え直す） */
  dataVersion: number;
  onAddTag: (name: string) => Promise<boolean>;
  onRemoveTag: (tag: TagCount) => void;
  /** 「ファイルの情報からタグを付ける」（確認のダイアログを出す） */
  onAutotag: () => void;
  /** 「ファイルを削除する」（確認のダイアログを出す。リンク切れのファイルは除く） */
  onDelete: () => void;
  onAddToPlaylist: (playlistId: number) => void;
  onOpenPlaylist: (playlistId: number) => void;
  onRemoveFromPlaylist: (playlist: TagCount) => void;
  /** 出典・ライセンスを設定する（null なら外す） */
  onSetCredit: (kind: CreditKind, name: string | null) => void;
  /** リンク切れの操作。ids は対象の中のリンク切れのファイル */
  onRelink: (ids: number[]) => void;
  onFindInFolder: (ids: number[]) => void;
  onRemoveMissing: (ids: number[]) => void;
  onError: (e: unknown) => void;
};

/** 右の欄の一括操作。対象のファイルすべてに、タグ・プレイリスト・出典・ライセンス・リンク切れの操作をする */
export function BulkPanel({
  fileIds,
  targetLabel,
  tags,
  playlists,
  creditsOf,
  busy,
  dataVersion,
  onAddTag,
  onRemoveTag,
  onAutotag,
  onDelete,
  onAddToPlaylist,
  onOpenPlaylist,
  onRemoveFromPlaylist,
  onSetCredit,
  onRelink,
  onFindInFolder,
  onRemoveMissing,
  onError,
}: Props) {
  const [summary, setSummary] = useState<{ key: string; data: BulkSummary } | null>(null);
  const key = fileIds.join(",");
  // onError は描くたびに作り直されるので、数え直しのきっかけにしないよう ref で持つ
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });
  useEffect(() => {
    if (key === "") return;
    let alive = true;
    api
      .bulkSummary(key.split(",").map(Number))
      .then((data) => alive && setSummary({ key, data }))
      .catch((e) => onErrorRef.current(e));
    return () => {
      alive = false;
    };
  }, [key, dataVersion]);
  // 対象が変わった直後は、前の対象の内訳を出さない
  const data = summary && summary.key === key ? summary.data : null;
  const tagById = new Map(tags.map((t) => [t.id, t]));
  // 候補に出すのは、対象すべてにはまだ付いていないタグ
  const fullyAttached = new Set(data?.tags.filter((t) => t.count === fileIds.length).map((t) => t.id) ?? []);
  const candidates = tags.filter((t) => !fullyAttached.has(t.id));

  return (
    <section data-testid="bulk-panel">
      <div className="track-title">一括操作</div>
      <div className="sub" data-testid="bulk-count">
        {targetLabel} {fileIds.length}件
      </div>
      {!data && <div className="sub">数えています…</div>}
      {data && (
        <>
          <Collapsible id="bulk-tags" title="タグ" count={data.tags.length}>
            <TagInput
              candidates={candidates}
              attachedNames={tags.filter((t) => fullyAttached.has(t.id)).flatMap((t) => [t.name, ...t.synonyms])}
              busy={busy}
              onAdd={onAddTag}
            />
            {/* 付いているタグ。「名前 件数 ✕」で、押すと対象のファイルすべてから外す */}
            {data.tags.length > 0 && (
              <div className="filter-chips detail-chips" data-testid="bulk-tags">
                {data.tags.map((t) => (
                  <Chip
                    key={t.id}
                    icon="🏷"
                    label={t.name}
                    count={t.count}
                    onClick={() => onRemoveTag(t)}
                    disabled={busy}
                    title="押すと、対象のファイルすべてから外す"
                    ariaLabel={`${t.name}を対象のファイルから外す`}
                    testId="bulk-tag"
                    tagName={t.name}
                    style={tagStyle(tagById.get(t.id))}
                  />
                ))}
              </div>
            )}
            <div className="row autotag-row">
              <button onClick={onAutotag} disabled={busy} title="アーティスト・アルバム・ジャンル・作曲者のタグを付ける">
                ファイルの情報からタグを付ける
              </button>
            </div>
          </Collapsible>

          <Collapsible id="bulk-playlists" title="プレイリスト" count={data.playlists.length}>
            {/* 対象のファイルを入れているプレイリスト。名前を押すと開き、「✕」でそのプレイリストから外す */}
            {data.playlists.length > 0 && (
              <div className="filter-chips detail-chips" data-testid="bulk-playlists">
                {data.playlists.map((p) => (
                  <span key={p.id} className="chip filter-chip" data-playlist-name={p.name}>
                    <button className="chip-part" onClick={() => onOpenPlaylist(p.id)} title="編集画面を開く" aria-label={`${p.name}を開く`}>
                      <span className="chip-icon">📃</span>
                      {p.name}
                      <span className="chip-count">{p.count}</span>
                    </button>
                    <button
                      className="chip-part chip-x"
                      onClick={() => onRemoveFromPlaylist(p)}
                      disabled={busy}
                      title="このプレイリストから、対象のファイルを外す"
                      aria-label={`${p.name}から対象のファイルを外す`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <PlaylistPicker playlists={playlists} busy={busy} onAdd={onAddToPlaylist} label="対象のファイルを加えるプレイリスト" />
          </Collapsible>

          {(["source", "license"] as const).map((kind) => {
            const counts = kind === "source" ? data.sources : data.licenses;
            // 対象すべてで同じならそれ、ばらばらなら「（複数）」
            const value = counts.length === 1 ? String(counts[0].id ?? "") : MIXED;
            const label = CREDIT_LABEL[kind];
            return (
              <div key={kind} className="credit-field" data-testid={`bulk-credit-${kind}`}>
                <h2>{label}</h2>
                <select
                  value={value}
                  disabled={busy}
                  aria-label={`${label}を選ぶ`}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === MIXED) return;
                    const credit = creditsOf(kind).find((c) => c.id === Number(v));
                    onSetCredit(kind, v === "" ? null : (credit?.name ?? null));
                  }}
                >
                  {value === MIXED && <option value={MIXED}>（複数）</option>}
                  <option value="">（なし）</option>
                  {creditsOf(kind).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}

          {/* リンク切れの操作は、対象の中のリンク切れのファイルだけが対象 */}
          {data.missingIds.length > 0 && (
            <div data-testid="bulk-missing">
              <h2 className="warn">⚠ リンク切れ {data.missingIds.length}件</h2>
              <div className="row">
                <button
                  onClick={() => onRelink(data.missingIds)}
                  disabled={busy}
                  title="ライブラリの中から同じ音声のファイルを探して、タグなどを移す"
                >
                  ひも付け直す
                </button>
                <button
                  onClick={() => onRemoveMissing(data.missingIds)}
                  disabled={busy}
                  title="ファイルの情報と、付けたタグなどの設定を消す"
                >
                  ライブラリから外す
                </button>
              </div>
              <div className="row" style={{ marginTop: 4 }}>
                <button
                  onClick={() => onFindInFolder(data.missingIds)}
                  disabled={busy}
                  title="フォルダを選んで、その中から同じ音声のファイルを探す"
                >
                  指定フォルダから自動で探す
                </button>
              </div>
            </div>
          )}
          {/* 実際のファイルも消す操作は、一番下に置く */}
          <div className="row delete-row">
            <button
              className="danger"
              onClick={onDelete}
              disabled={busy || data.missingIds.length === fileIds.length}
              title="見つかっているファイルをごみ箱に移し、ライブラリから外す（リンク切れのファイルは除く）"
            >
              ファイルを削除する
            </button>
          </div>
        </>
      )}
    </section>
  );
}
