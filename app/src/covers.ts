import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/**
 * ファイルの中のジャケット（グリッドのタイルに出す）。Rust 側がデータ領域に書き出した画像を、画面から読める URL にする。
 * 一度調べたファイルは覚えておき、同じファイルを何度も問い合わせない（ないことも覚える）
 */
const known = new Map<number, string | null>();
const pending = new Map<number, Promise<string | null>>();

function loadCover(fileId: number): Promise<string | null> {
  const hit = known.get(fileId);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = pending.get(fileId);
  if (!p) {
    p = invoke<string | null>("track_cover", { fileId })
      .then((path) => (path ? convertFileSrc(path) : null))
      // 読めないときは、ジャケットなしとして出す
      .catch(() => null)
      .then((url) => {
        known.set(fileId, url);
        pending.delete(fileId);
        return url;
      });
    pending.set(fileId, p);
  }
  return p;
}

/** ファイルのジャケットの URL（ないとき・調べている間は null）。enabled が false なら調べない */
export function useCover(fileId: number, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(() => known.get(fileId) ?? null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadCover(fileId).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [fileId, enabled]);
  return enabled ? url : null;
}
