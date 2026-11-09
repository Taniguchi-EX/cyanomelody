import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AudioFile } from "../api";

/**
 * ファイルのチェック（ドラッグでまとめて操作する対象）。チェックは絞り込みを変えても外れない。
 * files は表示中のファイル。データが変わると読み直されるので、そのたびにライブラリから消えたファイルをチェックから外す。
 */
export function useChecks(files: AudioFile[], onError: (e: unknown) => void) {
  const [checked, setChecked] = useState<Set<number>>(new Set());
  /** Shift+クリックでの範囲のチェックの起点（ファイルのid。絞り込みを変えても同じファイルを指す） */
  const [anchor, setAnchor] = useState<number | null>(null);
  // onError は描画のたびに作られる関数なので、確かめ直すきっかけにしないよう ref で持つ
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  // 表示中のうちチェックしたファイルの数（プレイリストを選んでいるときは同じファイルが2行出ることがあるので、ファイルで数える）
  const shownFiles = useMemo(() => new Set(files.map((f) => f.id)), [files]);
  const shownChecked = useMemo(() => [...shownFiles].reduce((n, id) => n + (checked.has(id) ? 1 : 0), 0), [shownFiles, checked]);

  // ライブラリから消えたファイル（登録解除など）は、チェックから外す
  useEffect(() => {
    if (checked.size === 0) return;
    let cancelled = false;
    api
      .existingFileIds([...checked])
      .then((ids) => {
        if (!cancelled && ids.length !== checked.size) setChecked(new Set(ids));
      })
      .catch((e) => onErrorRef.current(e));
    return () => {
      cancelled = true;
    };
  }, [checked, files]);

  /** ids のチェックをまとめて on にする（false なら外す） */
  const setMany = (ids: number[], on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  /** 行のチェックボックス。range なら起点との間をまとめて、押した行の新しい状態にそろえる */
  const checkRow = (index: number, range: boolean) => {
    const on = !checked.has(files[index].id);
    // 起点のファイルが今の一覧にないときは、押した行だけ
    const anchorIndex = range && anchor !== null ? files.findIndex((f) => f.id === anchor) : -1;
    const [from, to] = anchorIndex >= 0 ? [Math.min(anchorIndex, index), Math.max(anchorIndex, index)] : [index, index];
    setMany(
      files.slice(from, to + 1).map((f) => f.id),
      on,
    );
    setAnchor(files[index].id);
  };

  /** 表示中のファイルをすべてチェックする（false なら外す） */
  const checkShown = (on: boolean) =>
    setMany(
      files.map((f) => f.id),
      on,
    );

  const clear = () => {
    setChecked(new Set());
    setAnchor(null);
  };

  return { checked, ids: () => [...checked], shownChecked, shownFileCount: shownFiles.size, checkRow, checkShown, clear };
}
