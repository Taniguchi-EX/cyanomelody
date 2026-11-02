import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { LibraryFolder } from "../api";
import { baseName } from "../paths";

type Props = {
  folders: LibraryFolder[];
  busy: boolean;
  onAdd: (path: string) => Promise<boolean>;
  onRemove: (folder: LibraryFolder) => void;
  onScan: (folder: LibraryFolder) => void;
  onScanAll: () => void;
  /** 絞り込みに選んでいるフォルダ */
  selectedId: number | null;
  /** 押したフォルダで絞り込む（選んでいるフォルダなら外す） */
  onSelect: (id: number) => void;
};

export function FolderPanel({ folders, busy, onAdd, onRemove, onScan, onScanAll, selectedId, onSelect }: Props) {
  const [path, setPath] = useState("");

  const browse = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setPath(selected);
  };

  const add = async () => {
    if (await onAdd(path.trim())) setPath("");
  };

  return (
    <section>
      <h2>ライブラリフォルダ</h2>
      <div className="row">
        <input
          type="text"
          placeholder="フォルダのパス"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && path.trim() && add()}
          aria-label="フォルダのパス"
        />
        <button onClick={browse} disabled={busy}>
          参照
        </button>
        <button onClick={add} disabled={busy || !path.trim()}>
          登録
        </button>
      </div>
      {folders.map((f) => (
        <div
          className={"folder" + (selectedId === f.id ? " active" : "")}
          key={f.id}
          data-testid="folder"
          data-folder-path={f.path}
          title={f.path}
          onClick={() => onSelect(f.id)}
        >
          <span className="folder-name">{baseName(f.path)}</span>
          <span className="sub">
            {f.fileCount}
            {f.missingCount > 0 && (
              <span className="warn" title={`見つからない ${f.missingCount}件`}>
                {" "}
                ⚠{f.missingCount}
              </span>
            )}
          </span>
          <button
            className="icon"
            onClick={(e) => {
              e.stopPropagation();
              onScan(f);
            }}
            disabled={busy}
            title="スキャン"
            aria-label="スキャン"
          >
            ⟳
          </button>
          <button
            className="icon"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(f);
            }}
            disabled={busy}
            title="登録解除"
            aria-label="登録解除"
          >
            ✕
          </button>
        </div>
      ))}
      {folders.length > 1 && (
        <div className="row" style={{ marginTop: 6 }}>
          <button onClick={onScanAll} disabled={busy}>
            すべてスキャン
          </button>
        </div>
      )}
    </section>
  );
}
