import { useMemo, useState } from "react";
import type { AudioFile, Tag } from "../api";

type Props = {
  files: AudioFile[];
  tags: Tag[];
  busy: boolean;
  onAddTag: (name: string) => Promise<boolean>;
  onRemoveTag: (tagId: number) => void;
  onRemoveMissing: () => void;
};

export function SelectionPanel({ files, tags, busy, onAddTag, onRemoveTag, onRemoveMissing }: Props) {
  const [name, setName] = useState("");

  // 選んだファイルに付いているタグと、そのタグが付いたファイルの数
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of files) for (const t of f.tags) map.set(t, (map.get(t) ?? 0) + 1);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, "ja"));
  }, [files]);

  const tagId = (tagName: string) => tags.find((t) => t.name.toLowerCase() === tagName.toLowerCase())?.id;
  const missingCount = files.filter((f) => f.missing).length;

  if (files.length === 0) {
    return (
      <section>
        <h2>選んだファイル</h2>
        <div className="sub">一覧からファイルを選んでください（Ctrl・Shiftで複数選択）</div>
      </section>
    );
  }

  const add = async () => {
    if (await onAddTag(name)) setName("");
  };

  return (
    <section>
      <h2>選んだファイル（{files.length}件）</h2>
      {files.length === 1 && <div className="folder-path sub">{files[0].path}</div>}

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
      {counts.length === 0 && <div className="sub">タグは付いていません</div>}
      <ul className="selected-tags">
        {counts.map(([t, n]) => (
          <li key={t} data-testid="selected-tag">
            <span>
              {t}
              {files.length > 1 && (
                <span className="sub">
                  {" "}
                  {n}/{files.length}
                </span>
              )}
            </span>
            <button
              onClick={() => {
                const id = tagId(t);
                if (id !== undefined) onRemoveTag(id);
              }}
              disabled={busy}
              aria-label={`${t}を外す`}
            >
              外す
            </button>
          </li>
        ))}
      </ul>

      {missingCount > 0 && (
        <>
          <h2>見つからないファイル</h2>
          <div className="sub">選んだうち {missingCount}件 のファイルが見つかりません。</div>
          <div className="row" style={{ marginTop: 4 }}>
            <button onClick={onRemoveMissing} disabled={busy}>
              ライブラリから外す
            </button>
          </div>
        </>
      )}
    </section>
  );
}
