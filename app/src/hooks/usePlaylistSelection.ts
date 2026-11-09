import { useCallback, useEffect, useRef, useState } from "react";
import { playlistApi } from "../api";

/**
 * 左の欄で選んでいるプレイリスト（絞り込みの条件の1つ）。選ぶと Rust 側で抽選し、中央の一覧はその並びになる。
 * drawSeq は抽選するたびに増える（一覧を読み直すきっかけにする）。
 * onDrawn は抽選したとき（選んだとき・抽選し直したとき）に、そのプレイリストの id で呼ぶ
 */
export function usePlaylistSelection(onDrawn: (id: number) => void) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawSeq, setDrawSeq] = useState(0);
  // 描画のたびに作られる関数なので ref で持つ
  const onDrawnRef = useRef(onDrawn);
  useEffect(() => {
    onDrawnRef.current = onDrawn;
  });
  const selectedRef = useRef<number | null>(null);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const drawn = (id: number) => {
    setDrawSeq((n) => n + 1);
    onDrawnRef.current(id);
  };

  /** プレイリストを選んで抽選する（選んでいたものは外れる） */
  const select = useCallback(async (id: number) => {
    await playlistApi.select(id);
    setSelectedId(id);
    selectedRef.current = id;
    drawn(id);
  }, []);

  /** 選択を外す */
  const clear = useCallback(async () => {
    await playlistApi.clearSelection();
    setSelectedId(null);
    selectedRef.current = null;
  }, []);

  /** 押したとき：選んでいなければ選び（抽選し）、選んでいれば外す */
  const toggle = useCallback(async (id: number) => (selectedRef.current === id ? clear() : select(id)), [clear, select]);

  /** 選んでいるプレイリストを抽選し直す */
  const redraw = useCallback(async () => {
    const id = selectedRef.current;
    if (id === null) return;
    await playlistApi.redraw();
    drawn(id);
  }, []);

  /**
   * データを読み直すときに呼ぶ。中身が変わっていれば抽選し直し（"redrawn"）、消えていれば選択を外す（"cleared"）
   */
  const refresh = useCallback(async () => {
    const id = selectedRef.current;
    const r = await playlistApi.refreshDraw();
    if (r === "cleared") {
      setSelectedId(null);
      selectedRef.current = null;
    }
    if (r === "redrawn" && id !== null) drawn(id);
    return r;
  }, []);

  return { selectedId, drawSeq, select, clear, toggle, redraw, refresh };
}
