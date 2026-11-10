import { useCallback, useEffect, useRef, useState } from "react";
import { playlistApi, type PlaylistDetail } from "../api";

/** 開いている編集画面（重ねて出す）のプレイリストと、開いたときの状態 */
export type EditorState = {
  id: number;
  /** 開いたときに選んでおく項目 */
  itemId: number | null;
  /** 開いたら、選んだ項目の fx の選び肢を開く（一覧の行の fx のアイコンから開いたとき） */
  openChain: boolean;
  /** 開くたびに変える（同じプレイリストを開き直しても、選ぶ項目を当て直す） */
  seq: number;
};

/** プレイリストの編集画面を開く・閉じる・読み直す */
export function usePlaylistEditor(showError: (e: unknown) => void) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  // データを読み直すとき（reload）に、開いているプレイリストを見る
  const editorRef = useRef<number | null>(null);
  useEffect(() => {
    editorRef.current = editor?.id ?? null;
  }, [editor]);

  /**
   * 編集画面を開く。itemId があれば、その項目の行を選んだ状態にする。
   * fileId があれば、そのファイルの項目（ファイルの項目として直接入れたもの）の最初の行を選ぶ。
   * openChain なら、選んだ項目の fx の選び肢を開いておく
   */
  const open = async (id: number, itemId: number | null = null, fileId: number | null = null, openChain = false) => {
    try {
      const d = await playlistApi.get(id);
      const initial = itemId ?? (fileId !== null ? (d.items.find((i) => i.file?.id === fileId)?.id ?? null) : null);
      setDetail(d);
      setEditor({ id, itemId: initial, openChain: openChain && initial !== null, seq: Date.now() });
    } catch (e) {
      showError(e);
    }
  };

  const close = () => {
    setEditor(null);
    setDetail(null);
  };

  /** 開いている編集画面の中身を読み直す。削除されていたら閉じる */
  const reload = useCallback(async () => {
    const id = editorRef.current;
    if (id === null) return;
    try {
      setDetail(await playlistApi.get(id));
    } catch {
      setEditor(null);
      setDetail(null);
    }
  }, []);

  return { editor, detail: editor && detail && detail.id === editor.id ? detail : null, open, close, reload };
}
