import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type AutotagProgress, type ExportProgress, type HashProgress } from "../api";

/**
 * 裏で行う処理（ハッシュ値の計算・ファイルの情報からのタグ付け・書き出し）の進み具合。
 * ハッシュ値の計算とタグ付けが終わったら（中止したときも）、reloadAll でデータを読み直す
 * （重複や、右の欄のファイルのハッシュ値・タグが変わるため）
 */
export function useJobProgress(reloadAll: () => Promise<void>, showError: (e: unknown) => void) {
  const [hashProgress, setHashProgress] = useState<HashProgress | null>(null);
  const [autotagProgress, setAutotagProgress] = useState<AutotagProgress | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  // 知らせを受ける処理は1回だけ登録するので、読み直し・エラーの表示は ref で呼ぶ
  const reloadAllRef = useRef(reloadAll);
  const showErrorRef = useRef(showError);
  useEffect(() => {
    reloadAllRef.current = reloadAll;
    showErrorRef.current = showError;
  });

  useEffect(() => {
    // 起動したときに計算中なら、その進み具合から出す
    api
      .hashingProgress()
      .then((p) => p.running && setHashProgress(p))
      .catch((e) => showErrorRef.current(e));
    const unlisteners = [
      listen<HashProgress>("hash-progress", (e) => {
        setHashProgress(e.payload);
        if (!e.payload.running) reloadAllRef.current().catch((err) => showErrorRef.current(err));
      }),
      listen<AutotagProgress>("autotag-progress", (e) => {
        setAutotagProgress(e.payload);
        if (!e.payload.running) reloadAllRef.current().catch((err) => showErrorRef.current(err));
      }),
      listen<ExportProgress>("export-progress", (e) => setExportProgress(e.payload)),
    ];
    return () => {
      for (const u of unlisteners) u.then((f) => f());
    };
  }, []);

  /** ハッシュ値の計算を始める（まだ計算していないファイルの分。フォルダを登録・スキャンした後など） */
  const startHashing = () => api.startHashing().catch(showError);

  return { hashProgress, autotagProgress, exportProgress, startHashing };
}
