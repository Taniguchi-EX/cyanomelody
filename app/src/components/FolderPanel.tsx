import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { LibraryFolder } from "../api";

type Props = {
  folders: LibraryFolder[];
  busy: boolean;
  onAdd: (path: string) => Promise<boolean>;
  onRemove: (folder: LibraryFolder) => void;
  onScan: (folder: LibraryFolder) => void;
  onScanAll: () => void;
};

export function FolderPanel({ folders, busy, onAdd, onRemove, onScan, onScanAll }: Props) {
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
        <div className="folder" key={f.id} data-testid="folder">
          <div className="folder-path">{f.path}</div>
          <div className="row">
            <span className="sub" style={{ flex: 1 }}>
              {f.fileCount}件
              {f.missingCount > 0 && <span className="warn">（見つからない {f.missingCount}件）</span>}
            </span>
            <button onClick={() => onScan(f)} disabled={busy}>
              スキャン
            </button>
            <button onClick={() => onRemove(f)} disabled={busy}>
              登録解除
            </button>
          </div>
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
