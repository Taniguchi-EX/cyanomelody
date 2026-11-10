import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/**
 * Android の試作の画面（技術的に怪しい所の確認用。本実装では作り直す）。
 * SAF でフォルダを選ぶ → 権限が残るか → 中の音声ファイルの列挙 → ハッシュ値・長さ・曲名・ジャケットの読み取り → 再生
 */
type SavedDir = { uri: string | null; persisted: boolean };
type ScanEntry = { relPath: string; uri: string; size: number };
type ScanReport = { files: ScanEntry[]; dirs: number; elapsedMs: number };
type AnalyzeReport = {
  relPath: string;
  hash: { Ok: string } | { Err: string };
  duration: number | null;
  title: string | null;
  coverBytes: number | null;
  elapsedMs: number;
};

export function AndroidProto({ onOpenApp }: { onOpenApp: () => void }) {
  const [log, setLog] = useState<string[]>([]);
  const [saved, setSaved] = useState<SavedDir | null>(null);
  const [scan, setScan] = useState<ScanReport | null>(null);
  const [playing, setPlaying] = useState<ScanEntry | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const write = (line: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()} ${line}`]);
  const call = async <T,>(name: string, args?: Record<string, unknown>): Promise<T | null> => {
    try {
      return await invoke<T>(name, args);
    } catch (e) {
      write(`エラー（${name}）: ${String(e)}`);
      return null;
    }
  };

  // 起動したとき：前に選んだフォルダと、権限が残っているか
  useEffect(() => {
    invoke<SavedDir>("proto_saved_dir")
      .then((s) => {
        setSaved(s);
        setLog((l) => [...l, `起動時の保存済みフォルダ: ${s.uri ?? "なし"} / 権限が残っている: ${s.persisted}`]);
      })
      .catch((e) => setLog((l) => [...l, `エラー（proto_saved_dir）: ${String(e)}`]));
  }, []);

  const pick = async () => {
    const s = await call<SavedDir>("proto_pick_dir");
    if (s) {
      setSaved(s);
      write(`選んだフォルダ: ${s.uri ?? "（キャンセル）"} / 権限を残した: ${s.persisted}`);
    }
  };

  const doScan = async () => {
    if (!saved?.uri) return;
    const r = await call<ScanReport>("proto_scan", { dir: saved.uri });
    if (r) {
      setScan(r);
      write(`列挙: 音声ファイル ${r.files.length}件、フォルダ ${r.dirs}個、${r.elapsedMs}ms`);
    }
  };

  const analyze = async (count: number) => {
    if (!scan) return;
    const targets = scan.files.slice(0, count);
    const started = performance.now();
    let ok = 0;
    for (const f of targets) {
      const r = await call<AnalyzeReport>("proto_analyze", { uri: f.uri, relPath: f.relPath });
      if (!r) continue;
      const hash = "Ok" in r.hash ? r.hash.Ok.slice(0, 12) : `失敗: ${r.hash.Err}`;
      if ("Ok" in r.hash) ok += 1;
      if (count <= 5)
        write(`${r.relPath}: ハッシュ ${hash} / 長さ ${r.duration?.toFixed(1) ?? "なし"}秒 / 曲名 ${r.title ?? "なし"} / ジャケット ${r.coverBytes ?? 0}バイト / ${r.elapsedMs}ms`);
    }
    write(`読み取り: ${targets.length}件中 ${ok}件のハッシュ値を計算、合計 ${Math.round(performance.now() - started)}ms`);
  };

  const play = (f: ScanEntry) => {
    setPlaying(f);
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = convertFileSrc(f.uri, "android-fs-content");
    audio.play().then(
      () => write(`再生を始めました: ${f.relPath}`),
      (e) => write(`再生できません: ${String(e)}`),
    );
  };

  return (
    <div style={{ padding: 12, fontSize: 14, overflow: "auto", height: "100vh", boxSizing: "border-box" }} data-testid="android-proto">
      <h2 style={{ margin: "4px 0" }}>Android 試作</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button onClick={pick} data-testid="proto-pick">フォルダを選ぶ</button>
        <button onClick={doScan} disabled={!saved?.uri} data-testid="proto-scan">列挙</button>
        <button onClick={() => analyze(5)} disabled={!scan} data-testid="proto-analyze5">5件読む</button>
        <button onClick={() => analyze(50)} disabled={!scan} data-testid="proto-analyze50">50件読む</button>
        <button onClick={() => scan?.files[0] && play(scan.files[0])} disabled={!scan?.files.length} data-testid="proto-play">
          最初の曲を再生
        </button>
        <button onClick={() => audioRef.current?.pause()}>止める</button>
        <button onClick={onOpenApp} data-testid="proto-open-app">本体の画面</button>
      </div>
      <div style={{ margin: "6px 0" }}>
        フォルダ: {saved?.uri ?? "なし"}（権限: {saved?.persisted ? "残っている" : "なし"}）
      </div>
      <audio
        ref={audioRef}
        controls
        style={{ width: "100%" }}
        onError={() => write(`audio のエラー: ${audioRef.current?.error?.code} ${audioRef.current?.error?.message ?? ""}`)}
        onLoadedMetadata={() => write(`長さ（audio）: ${audioRef.current?.duration.toFixed(1)}秒 ${playing?.relPath ?? ""}`)}
      />
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }} data-testid="proto-log">
        {log.join("\n")}
      </pre>
    </div>
  );
}
