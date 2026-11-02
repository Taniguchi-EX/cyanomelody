import { useState } from "react";
import type { Tag } from "../api";

type Props = {
  tags: Tag[];
  busy: boolean;
  onCreate: (name: string) => Promise<boolean>;
  /** 名前を変える。別のタグと同じ名前なら統合を確認する。終わったら true */
  onRename: (tag: Tag, name: string) => Promise<boolean>;
  onDelete: (tag: Tag) => void;
  onDeleteUnused: () => void;
  onClose: () => void;
};

export function TagManager({ tags, busy, onCreate, onRename, onDelete, onDeleteUnused, onClose }: Props) {
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const unused = tags.filter((t) => t.fileCount === 0).length;

  const create = async () => {
    if (await onCreate(newName)) setNewName("");
  };

  const startEdit = (tag: Tag) => {
    setEditingId(tag.id);
    setEditName(tag.name);
  };

  const commitEdit = async (tag: Tag) => {
    if (editName.trim() === tag.name) {
      setEditingId(null);
      return;
    }
    if (await onRename(tag, editName)) setEditingId(null);
  };

  return (
    <div className="overlay" onKeyDown={(e) => e.key === "Escape" && editingId === null && onClose()}>
      <div className="dialog" role="dialog" aria-label="タグの管理">
        <div className="dialog-head">
          <h2>タグの管理（{tags.length}件）</h2>
          <button onClick={onClose}>閉じる</button>
        </div>

        <div className="row">
          <input
            type="text"
            placeholder="新しいタグの名前"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && newName.trim() && create()}
            aria-label="新しいタグの名前"
          />
          <button onClick={create} disabled={busy || !newName.trim()}>
            作成
          </button>
        </div>

        <table className="tag-table">
          <thead>
            <tr>
              <th>名前</th>
              <th className="num">ファイル数</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.id} data-testid="manage-tag" data-tag-name={t.name}>
                <td>
                  {editingId === t.id ? (
                    <input
                      type="text"
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit(t);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      aria-label="タグの新しい名前"
                    />
                  ) : (
                    t.name
                  )}
                </td>
                <td className="num">{t.fileCount}</td>
                <td className="actions">
                  {editingId === t.id ? (
                    <>
                      <button onClick={() => commitEdit(t)} disabled={busy || !editName.trim()}>
                        決定
                      </button>
                      <button onClick={() => setEditingId(null)}>やめる</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startEdit(t)} disabled={busy}>
                        名前変更
                      </button>
                      <button onClick={() => onDelete(t)} disabled={busy}>
                        削除
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tags.length === 0 && <div className="sub">タグはまだありません</div>}

        <div className="row" style={{ marginTop: 8 }}>
          <span className="sub" style={{ flex: 1 }}>
            どのファイルにも付いていないタグ：{unused}件
          </span>
          <button onClick={onDeleteUnused} disabled={busy || unused === 0}>
            使われていないタグを削除
          </button>
        </div>
      </div>
    </div>
  );
}
