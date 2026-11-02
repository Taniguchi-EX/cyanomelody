import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AudioFile, type FileSummary } from "../api";

/**
 * ファイルのチェック（一括操作の対象）。チェックは絞り込みを変えても外れない。
 * files は表示中のファイル。データが変わると読み直されるので、そのたびにチェックしたファイルの内訳も求め直す。
 */
export function useChecks(files: AudioFile[], onError: (e: unknown) => void) {
  const [checked, setChecked] = useState<Set<number>>(new Set());
  /** Shift+クリックでの範囲のチェックの起点（ファイルのid。絞り込みを変えても同じファイルを指す） */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [summary, setSummary] = useState<FileSummary | null>(null);
  // onError は描画のたびに作られる関数なので、内訳を求め直すきっかけにしないよう ref で持つ
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  const shownChecked = useMemo(() => files.reduce((n, f) => n + (checked.has(f.id) ? 1 : 0), 0), [files, checked]);

  // ライブラリから消えたファイル（登録解除など）は、チェックから外す
  useEffect(() => {
    // チェックがないときは一括操作の欄を出さないので、内訳は求めない（前の内訳は使われない）
    if (checked.size === 0) return;
    let cancelled = false;
    api
      .summarizeFiles([...checked])
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
        if (s.ids.length !== checked.size) setChecked(new Set(s.ids));
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

  return { checked, ids: () => [...checked], shownChecked, summary, checkRow, checkShown, clear };
}
