import { useState } from "react";
import { api } from "../api";
import { useEscape } from "../hooks/useEscape";
import { EditableList } from "./EditableList";

type Props = {
  /** 対象のファイルの数（1件ならファイルの詳細から開いた） */
  count: number;
  single: boolean;
  /** 「タグを付ける」。ignore は「以下の値は無視する」、split は「以下の文字で区切る」 */
  onConfirm: (ignore: boolean, split: boolean) => void;
  onClose: () => void;
};

/**
 * 自動タグ付けの確認のダイアログ。「以下の値は無視する」と無視する値の一覧、「以下の文字で区切る」と区切り文字の一覧。
 * 一覧は ✎ で編集、− で消す、＋ で加え、変えるとすぐに保存する
 */
export function AutotagDialog({ count, single, onConfirm, onClose }: Props) {
  // チェックボックスは、開くたびに ON から始める
  const [ignore, setIgnore] = useState(true);
  const [split, setSplit] = useState(true);
  // どちらかの一覧を編集している間は「タグを付ける」を押せない
  const [editingIgnore, setEditingIgnore] = useState(false);
  const [editingSplit, setEditingSplit] = useState(false);
  useEscape(onClose);

  return (
    <div className="overlay">
      <div className="dialog autotag-dialog" role="dialog" aria-label="ファイルの情報からタグを付ける" data-testid="autotag-dialog">
        <div className="dialog-head">
          <h2>ファイルの情報からタグを付ける</h2>
        </div>
        <p>
          {single ? "このファイル" : `${count}件のファイル`}
          の情報を読み、アーティスト・アルバム・ジャンル・作曲者のタグを付けます。
        </p>
        <label className="data-check">
          <input type="checkbox" checked={ignore} onChange={(e) => setIgnore(e.target.checked)} />
          以下の値は無視する
        </label>
        <EditableList
          load={api.metaIgnoreValues}
          save={api.setMetaIgnoreValues}
          off={!ignore}
          what="無視する値"
          testId="ignore-values"
          onEditing={setEditingIgnore}
        />
        <label className="data-check">
          <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
          以下の文字で区切る（アーティスト・作曲者）
        </label>
        <EditableList
          load={api.metaSeparators}
          save={api.setMetaSeparators}
          off={!split}
          what="区切り文字"
          testId="separator-values"
          onEditing={setEditingSplit}
        />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
          <button onClick={onClose}>やめる</button>
          <button onClick={() => onConfirm(ignore, split)} disabled={editingIgnore || editingSplit}>
            タグを付ける
          </button>
        </div>
      </div>
    </div>
  );
}
