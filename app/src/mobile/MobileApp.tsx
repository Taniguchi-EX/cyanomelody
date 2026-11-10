import { useEffect, useRef, useState } from "react";
import { useAppController } from "../hooks/useAppController";
import { PlayerBar } from "../components/PlayerBar";
import { FilterSections } from "../views/FilterSections";
import { DetailArea } from "../views/DetailArea";
import { Overlays } from "../views/Overlays";
import { MobileHeader } from "./MobileHeader";
import { ListIcon } from "../components/Icons";
import { MiniPlayer } from "./MiniPlayer";
import { MobileList } from "./MobileList";
import { useScreenStack } from "./useScreenStack";
import "./mobile.css";

/** 一番下の行の結果・エラーを出しておく時間（ミリ秒） */
const STATUS_MS = 4000;

/**
 * Android の画面：動的エリア（ファイルの一覧・絞り込み・ファイルの詳細・一括操作・プレイリストの編集を切り替える）と、
 * 再生エリア（小。押すと全画面の再生）。状態と操作は Windows と同じ useAppController、欄の中身は views/ の部品
 */
export function MobileApp() {
  const c = useAppController();
  const nav = useScreenStack();
  const { top } = nav;
  const {
    files,
    selectedPlaylistId,
    bulkOpen,
    setBulkOpen,
    playlistEditor,
    audio,
    status,
    setSettingsOpen,
    chains,
    checked,
    checks,
    playback,
    effectActions,
  } = c;

  // 絞り込みでプレイリストを選んだら（抽選したら）、一覧へ移る
  const prevPlaylist = useRef(selectedPlaylistId);
  useEffect(() => {
    if (selectedPlaylistId !== null && selectedPlaylistId !== prevPlaylist.current && top.kind === "filter") nav.back();
    prevPlaylist.current = selectedPlaylistId;
  }, [selectedPlaylistId, top.kind, nav]);

  // チェック：長押しで始め（画面を積む）、戻ったらチェックをすべて外す。チェックがなくなったら戻る
  const inCheck = nav.stack.some((s) => s.kind === "check");
  useEffect(() => {
    if (!inCheck && checked.size > 0) checks.clear();
  }, [inCheck, checked.size, checks]);
  useEffect(() => {
    if (top.kind === "check" && checked.size === 0) nav.back();
  }, [top.kind, checked.size, nav]);

  // 一括操作：チェックの行の「一括操作」で開き、戻ったら閉じる
  useEffect(() => {
    if (bulkOpen && top.kind === "check") nav.push({ kind: "bulk" });
  }, [bulkOpen, top.kind, nav]);
  const inBulk = nav.stack.some((s) => s.kind === "bulk");
  useEffect(() => {
    if (!inBulk && bulkOpen) setBulkOpen(false);
  }, [inBulk, bulkOpen, setBulkOpen]);

  // プレイリストの編集：開いたら画面を積み、戻ったら閉じる。削除などで閉じたら画面も戻す
  const editorOpen = playlistEditor.editor !== null;
  const inEditor = nav.stack.some((s) => s.kind === "editor");
  const editorSeq = playlistEditor.editor?.seq ?? null;
  useEffect(() => {
    if (editorSeq !== null && !nav.stack.some((s) => s.kind === "editor")) nav.push({ kind: "editor" });
  }, [editorSeq, nav]);
  const wasInEditor = useRef(false);
  useEffect(() => {
    if (wasInEditor.current && !inEditor && editorOpen) playlistEditor.close();
    if (!editorOpen && inEditor) nav.close("editor");
    wasInEditor.current = inEditor;
  }, [inEditor, editorOpen, playlistEditor, nav]);

  // 一番下の行の結果・エラーは、しばらく出して消す
  const [shownStatus, setShownStatus] = useState(status);
  useEffect(() => {
    setShownStatus(status);
    if (!status.text) return;
    const t = window.setTimeout(() => setShownStatus({ text: "", error: false }), STATUS_MS);
    return () => window.clearTimeout(t);
  }, [status]);

  const toList = (
    <>
      <button className="icon" onClick={() => setSettingsOpen(true)} aria-label="設定" title="設定">
        ⚙
      </button>
      <button className="icon m-switch" onClick={nav.back} aria-label="一覧" title="一覧" data-testid="m-to-list">
        <ListIcon />
        <span className="m-badge">{files.length}</span>
      </button>
    </>
  );

  return (
    <div className="m-app" data-testid="m-app">
      <div className="m-dynamic">
        {(top.kind === "list" || top.kind === "check") && (
          <MobileList
            c={c}
            checking={top.kind === "check"}
            onStartChecking={() => nav.push({ kind: "check" })}
            onStopChecking={nav.back}
            onOpenFile={() => nav.push({ kind: "detail" })}
            onOpenFilter={() => nav.push({ kind: "filter" })}
          />
        )}
        {top.kind === "filter" && (
          <section className="m-screen">
            <MobileHeader title="絞り込み" right={toList} />
            <div className="m-body m-filter">
              <FilterSections c={c} />
            </div>
          </section>
        )}
        {(top.kind === "detail" || top.kind === "bulk") && (
          <section className="m-screen">
            <MobileHeader title={top.kind === "bulk" ? `一括操作（${checked.size}件）` : "ファイルの詳細"} onBack={nav.back} />
            <div className="m-body m-detail">
              <DetailArea c={c} />
            </div>
          </section>
        )}
        {top.kind === "editor" && <section className="m-screen" />}
        {/* 重ねて出す画面（プレイリストの編集・タグの詳細・設定など）は、動的エリアの中に重ねる（再生エリアは隠さない） */}
        <Overlays c={c} />
      </div>
      {shownStatus.text && (
        <div className={"m-status" + (shownStatus.error ? " error" : "")} data-testid="m-status">
          {shownStatus.text}
        </div>
      )}
      <MiniPlayer c={c} onOpen={() => nav.push({ kind: "player" })} />
      {top.kind === "player" && (
        <div className="m-full" data-testid="m-full">
          <button className="icon m-full-close" onClick={nav.back} aria-label="閉じる" title="閉じる">
            ↓
          </button>
          <PlayerBar
            player={audio.player}
            time={audio.time}
            canPlayOpen={files.some((f) => !f.missing)}
            onPlayOpen={playback.playOpen}
            playMode={audio.playMode}
            onPlayMode={audio.setPlayMode}
            onSeek={audio.seek}
            onSeekBy={audio.seekBy}
            onPrev={audio.prev}
            onNext={audio.next}
            onTogglePause={audio.togglePause}
            onStop={audio.stop}
            previewFile={audio.previewFile}
            volume={audio.volume}
            onVolume={audio.setVolume}
            onVolumeCommit={audio.commitVolume}
            onToggleMute={audio.toggleMute}
            chains={chains}
            baseChain={audio.baseChain}
            onBaseChain={audio.setBaseChain}
            onOpenEffects={effectActions.openForPlayer}
            onJump={() => {
              nav.back();
              playback.jumpToPlaying();
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
      )}
      <audio {...audio.audioProps} />
    </div>
  );
}
