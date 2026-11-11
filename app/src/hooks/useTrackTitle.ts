import { useEffect, useState } from "react";
import { api } from "../api";
import { stem } from "../paths";

/** 鳴らしている曲の名前：プレイリスト上での名前 → 曲名（タグ情報のタイトル） → 拡張子を除いたファイル名 */
export const playingName = (alias: string | null, trackTitle: string | null, relPath: string) =>
  alias ?? trackTitle ?? stem(relPath);

/**
 * 音声ファイルの中の曲名（タグ情報のタイトル）。データベースにはないので、ファイルから読む。
 * 読めない・ないとき、読み終えるまでは null（エラーにしない）
 */
export function useTrackTitle(path: string | null): string | null {
  const [title, setTitle] = useState<{ path: string; title: string | null } | null>(null);
  useEffect(() => {
    if (path === null) return;
    let alive = true;
    api
      .trackTitle(path)
      .then((t) => alive && setTitle({ path, title: t }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  return title && title.path === path ? title.title : null;
}
