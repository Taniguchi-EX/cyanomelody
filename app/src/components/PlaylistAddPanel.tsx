import { useState } from "react";
import type { PlaylistNode, Tag } from "../api";
import { makesLoop } from "../playlistGraph";
import { TagInput } from "./TagInput";
import { isAndroid } from "../platform";

type Props = {
  /** 開いているプレイリスト */
  playlistId: number;
  playlists: PlaylistNode[];
  tags: Tag[];
  busy: boolean;
  /** タグの組み合わせの項目を加える。加えられたら true */
  onAddTags: (tagIds: number[]) => Promise<boolean>;
  /** プレイリスト（参照）の項目を加える */
  onAddRef: (refId: number) => void;
  onError: (e: unknown) => void;
};

/** 編集画面の、項目を加える欄：タグの組み合わせ（タグを並べて「追加」）と、プレイリスト（選んだらすぐ加える） */
export function PlaylistAddPanel({ playlistId, playlists, tags, busy, onAddTags, onAddRef, onError }: Props) {
  /** タグの組み合わせの項目として加えるため、並べたタグ */
  const [comboIds, setComboIds] = useState<number[]>([]);
  const combo = comboIds.map((id) => tags.find((t) => t.id === id)).filter((t): t is Tag => t !== undefined);
  // ループになるプレイリスト（自分自身と、自分を含むもの）は、候補に出すが選べないようにする
  const loops = new Set(playlists.filter((p) => makesLoop(playlists, playlistId, p.id)).map((p) => p.id));

  return (
    <div className="playlist-add">
      <div className="row combo-row">
        <TagInput
          candidates={tags.filter((t) => !comboIds.includes(t.id))}
          attachedNames={combo.flatMap((t) => [t.name, ...t.synonyms])}
          busy={busy}
          label="組み合わせに加えるタグ"
          placeholder="タグ（Enterで並べる）"
          onAdd={async (input) => {
            const key = input.trim().toLowerCase();
            const tag = tags.find((t) => t.name.toLowerCase() === key || t.synonyms.some((s) => s.toLowerCase() === key));
            if (!tag) {
              onError(`タグ「${input.trim()}」はありません`);
              return false;
            }
            setComboIds((ids) => [...ids, tag.id]);
            return true;
          }}
        />
        <span className="chips" data-testid="combo-tags">
          {combo.map((t) => (
            <button key={t.id} className="chip" onClick={() => setComboIds((ids) => ids.filter((id) => id !== t.id))} title="押すと外す">
              🏷 {t.name} ✕
            </button>
          ))}
        </span>
        <button
          onClick={async () => {
            if (await onAddTags(comboIds)) setComboIds([]);
          }}
          disabled={busy || comboIds.length === 0}
        >
          タグの組み合わせを追加
        </button>
      </div>
      <div className="row">
        <select
          value=""
          onChange={(e) => e.target.value !== "" && onAddRef(Number(e.target.value))}
          disabled={busy}
          aria-label="加えるプレイリスト"
        >
          <option value="">プレイリストを追加</option>
          {playlists.map((p) => (
            <option key={p.id} value={p.id} disabled={loops.has(p.id)}>
              {"　".repeat(p.depth)}
              {p.name}
              {loops.has(p.id) ? "（ループになるため選べません）" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="sub">
        {isAndroid
          ? "ファイルは、ファイルの詳細か一括操作の「プレイリスト」で加えます。"
          : "ファイルは、中央の一覧の行を左の欄のプレイリストへドラッグして加えます。"}
      </div>
    </div>
  );
}
