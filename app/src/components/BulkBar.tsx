import { useState } from "react";
import type { Credit, CreditKind, FileSummary, LicenseType, Tag } from "../api";
import { CreditField } from "./CreditField";

type Mode = "addTag" | "removeTag" | CreditKind;

type Props = {
  /** チェックしている件数（内訳を求める前から正しい件数を出すため、内訳とは別に受け取る） */
  checkedCount: number;
  /** チェックしたファイルの内訳。読み込み中は null */
  summary: FileSummary | null;
  tags: Tag[];
  sources: Credit[];
  licenses: Credit[];
  licenseTypes: LicenseType[];
  busy: boolean;
  onAddTag: (name: string) => Promise<boolean>;
  onRemoveTag: (tag: Tag) => void;
  onSetCredit: (kind: CreditKind, name: string) => Promise<boolean>;
  onClearCredit: (kind: CreditKind) => void;
  onRelink: () => void;
  onRemoveMissing: () => void;
  onError: (e: unknown) => void;
};

const MODES: { mode: Mode; label: string }[] = [
  { mode: "addTag", label: "タグを付ける" },
  { mode: "removeTag", label: "タグを外す" },
  { mode: "source", label: "出典" },
  { mode: "license", label: "ライセンス" },
];

/** 一覧の上の一括操作の欄。チェックしたファイルすべてが対象 */
export function BulkBar({
  checkedCount,
  summary,
  tags,
  sources,
  licenses,
  licenseTypes,
  busy,
  onAddTag,
  onRemoveTag,
  onSetCredit,
  onClearCredit,
  onRelink,
  onRemoveMissing,
  onError,
}: Props) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [name, setName] = useState("");
  const total = checkedCount;
  const missing = summary?.missing ?? 0;

  const addTag = async () => {
    if (await onAddTag(name)) setName("");
  };

  return (
    <div className="bulk" data-testid="bulk-bar">
      <div className="toolbar bulk-bar">
        <span>チェックした{total}件をまとめて：</span>
        {MODES.map((m) => (
          <button
            key={m.mode}
            className={mode === m.mode ? "on" : ""}
            aria-pressed={mode === m.mode}
            onClick={() => setMode((cur) => (cur === m.mode ? null : m.mode))}
          >
            {m.label}
          </button>
        ))}
        {/* 見つからないファイルの操作は、チェックしたファイルに見つからないファイルがあるときだけ出す */}
        {missing > 0 && (
          <>
            <span className="sub">見つからない {missing}件：</span>
            <button onClick={onRelink} disabled={busy}>
              ひも付け直す
            </button>
            <button onClick={onRemoveMissing} disabled={busy}>
              ライブラリから外す
            </button>
          </>
        )}
      </div>

      {mode === "addTag" && (
        <div className="toolbar bulk-detail">
          <input
            type="text"
            list="bulk-tag-names"
            placeholder="タグ名（新しい名前なら作成）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && addTag()}
            aria-label="まとめて付けるタグ名"
          />
          <datalist id="bulk-tag-names">
            {tags.map((t) => (
              <option key={t.id} value={t.name} />
            ))}
          </datalist>
          <button onClick={addTag} disabled={busy || !name.trim()}>
            付ける
          </button>
        </div>
      )}

      {mode === "removeTag" && (
        <div className="toolbar bulk-detail" data-testid="bulk-tags">
          {summary && summary.tags.length === 0 && <span className="sub">タグは付いていません</span>}
          {summary?.tags.map((c) => {
            const tag = tags.find((t) => t.id === c.id);
            if (!tag) return null;
            return (
              <span className="bulk-tag" key={tag.id} data-testid="bulk-tag" data-tag-name={tag.name}>
                {tag.name}
                <span className="sub">
                  {" "}
                  {c.count}/{total}
                </span>
                <button onClick={() => onRemoveTag(tag)} disabled={busy} aria-label={`${tag.name}をまとめて外す`}>
                  外す
                </button>
              </span>
            );
          })}
        </div>
      )}

      {(mode === "source" || mode === "license") && summary && (
        <div className="bulk-detail bulk-credit">
          <CreditField
            key={mode}
            kind={mode}
            groups={mode === "source" ? summary.sources : summary.licenses}
            credits={mode === "source" ? sources : licenses}
            licenseTypes={licenseTypes}
            busy={busy}
            onSet={(n) => onSetCredit(mode, n)}
            onClear={() => onClearCredit(mode)}
            onError={onError}
            bulk
          />
        </div>
      )}
    </div>
  );
}
