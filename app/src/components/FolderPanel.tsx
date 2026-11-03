import type { LibraryFolder } from "../api";
import { baseName } from "../paths";
import { Collapsible } from "./Collapsible";

type Props = {
  folders: LibraryFolder[];
  busy: boolean;
  /** フォルダを選んで登録する */
  onAdd: () => void;
  onRemove: (folder: LibraryFolder) => void;
  onScan: (folder: LibraryFolder) => void;
  /** 絞り込みに選んでいるフォルダ */
  selectedId: number | null;
  /** 押したフォルダで絞り込む（選んでいるフォルダなら外す） */
  onSelect: (id: number) => void;
};

/** 左の欄の「ライブラリ」。登録したフォルダの一覧 */
export function FolderPanel({ folders, busy, onAdd, onRemove, onScan, selectedId, onSelect }: Props) {
  return (
    <Collapsible
      id="folders"
      title="ライブラリ"
      selectedCount={selectedId !== null ? 1 : 0}
      actions={
        <button className="icon" onClick={onAdd} disabled={busy} title="フォルダを追加" aria-label="フォルダを追加">
          ＋
        </button>
      }
    >
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
    </Collapsible>
  );
}
