import { useEffect, useRef, useState } from "react";
import { useAppController } from "../hooks/useAppController";
import { FilterSections } from "../views/FilterSections";
import { DetailArea } from "../views/DetailArea";
import { Overlays } from "../views/Overlays";
import { MobileHeader } from "./MobileHeader";
import { ListIcon } from "../components/Icons";
import { MiniPlayer } from "./MiniPlayer";
import { MobileFullPlayer } from "./MobileFullPlayer";
import { MobileList } from "./MobileList";
import { useScreenStack } from "./useScreenStack";
import { api } from "../api";
import { hasNewCopy } from "../dataTransferText";
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
    checked,
    checks,
    playback,
  } = c;

  // アプリを開いたとき、Windows から新しいデータ（cyanomelody 用のフォルダ）が写されていれば知らせる
  const [newCopy, setNewCopy] = useState(false);
  useEffect(() => {
    api
      .copyFolderStatus()
      .then((s) => setNewCopy(hasNewCopy(s)))
      .catch(() => {});
  }, []);
  const openCopy = () => {
    setNewCopy(false);
    // 設定画面を「データ」のタブで開く（開いたタブは設定画面が覚えている）
    localStorage.setItem("cyanomelody.settingsTab", JSON.stringify("data"));
    setSettingsOpen(true);
  };

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

  // 一括操作：チェックの行の「一括操作」で開き（開いた瞬間だけ画面を積む）、戻ったら閉じる。
  // 戻った直後はまだ開いているので、開いているかだけで積むと、積み直してしまう（履歴がずれる）
  const prevBulk = useRef(bulkOpen);
  useEffect(() => {
    if (bulkOpen && !prevBulk.current) nav.push({ kind: "bulk" });
    prevBulk.current = bulkOpen;
  }, [bulkOpen, nav]);
  // 戻る操作で一括操作の画面が外れた瞬間だけ閉じる（開いた直後は、まだ画面が積まれていないので、外れたことにしない）
  const inBulk = nav.stack.some((s) => s.kind === "bulk");
  const wasInBulk = useRef(false);
  useEffect(() => {
    if (wasInBulk.current && !inBulk && bulkOpen) setBulkOpen(false);
    wasInBulk.current = inBulk;
  }, [inBulk, bulkOpen, setBulkOpen]);

  // プレイリストの編集：開いたら画面を積み、戻ったら閉じる。削除などで閉じたら画面も戻す
  const editorOpen = playlistEditor.editor !== null;
  const inEditor = nav.stack.some((s) => s.kind === "editor");
  const editorSeq = playlistEditor.editor?.seq ?? null;
  // 開いた瞬間（開くたびに変わる seq が変わったとき）だけ積む。戻った直後はまだ開いているので、開いているかだけで積むと積み直してしまう
  const prevEditorSeq = useRef(editorSeq);
  useEffect(() => {
    if (editorSeq !== null && editorSeq !== prevEditorSeq.current && !inEditor) nav.push({ kind: "editor" });
    prevEditorSeq.current = editorSeq;
  }, [editorSeq, inEditor, nav]);
  const wasInEditor = useRef(false);
  useEffect(() => {
    if (wasInEditor.current && !inEditor && editorOpen) playlistEditor.close();
    if (!editorOpen && inEditor) nav.close("editor");
    wasInEditor.current = inEditor;
  }, [inEditor, editorOpen, playlistEditor, nav]);

  // 重ねて出す画面：開いたら履歴に積み、戻る操作で閉じる。閉じるボタンで閉じたら、積んだ分を戻す
  const overlays = [
    { open: c.settingsOpen, close: () => setSettingsOpen(false) },
    { open: c.tagDetail !== null, close: () => c.setTagDetailId(null) },
    { open: c.creditForm !== null, close: () => c.setCreditForm(null) },
    { open: c.effectActions.dialog !== null, close: c.effectActions.closeDialog },
    { open: c.fileOps.deleteDialog !== null, close: c.fileOps.cancelDelete },
    { open: c.fileOps.autotagDialog !== null, close: c.fileOps.closeAutotag },
  ];
  const overlayOpen = overlays.some((o) => o.open);
  const inOverlay = nav.stack.some((s) => s.kind === "overlay");
  const closeOverlays = useRef(() => {});
  useEffect(() => {
    closeOverlays.current = () => overlays.forEach((o) => o.open && o.close());
  });
  const wasInOverlay = useRef(false);
  useEffect(() => {
    if (overlayOpen && !inOverlay && !wasInOverlay.current) nav.push({ kind: "overlay" });
    else if (wasInOverlay.current && !inOverlay && overlayOpen) closeOverlays.current();
    else if (!overlayOpen && inOverlay) nav.close("overlay");
    wasInOverlay.current = inOverlay;
  }, [overlayOpen, inOverlay, nav]);
  // 画面に出すのは、重ねて出す画面の下の画面
  const base = [...nav.stack].reverse().find((s) => s.kind !== "overlay") ?? { kind: "list" as const };

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
        {(base.kind === "list" || base.kind === "check") && (
          <MobileList
            c={c}
            checking={base.kind === "check"}
            onStartChecking={() => nav.push({ kind: "check" })}
            onStopChecking={nav.back}
            onOpenFile={() => nav.push({ kind: "detail" })}
            onOpenFilter={() => nav.push({ kind: "filter" })}
          />
        )}
        {base.kind === "filter" && (
          <section className="m-screen">
            <MobileHeader title="絞り込み" right={toList} />
            <div className="m-body m-filter">
              <FilterSections c={c} />
            </div>
          </section>
        )}
        {(base.kind === "detail" || base.kind === "bulk") && (
          <section className="m-screen">
            <MobileHeader title={base.kind === "bulk" ? `一括操作（${checked.size}件）` : "ファイルの詳細"} onBack={nav.back} />
            <div className="m-body m-detail">
              <DetailArea c={c} />
            </div>
          </section>
        )}
        {base.kind === "editor" && <section className="m-screen" />}
        {/* 重ねて出す画面（プレイリストの編集・タグの詳細・設定など）は、動的エリアの中に重ねる（再生エリアは隠さない） */}
        <Overlays c={c} />
      </div>
      {newCopy && (
        <div className="m-notice" data-testid="m-copy-notice">
          <span>Windows から新しいデータが写されています</span>
          <button onClick={openCopy}>取り込む</button>
          <button className="icon" onClick={() => setNewCopy(false)} aria-label="閉じる" title="閉じる">
            ✕
          </button>
        </div>
      )}
      {shownStatus.text && (
        <div className={"m-status" + (shownStatus.error ? " error" : "")} data-testid="m-status">
          {shownStatus.text}
        </div>
      )}
      <MiniPlayer c={c} onOpen={() => nav.push({ kind: "player" })} />
      {base.kind === "player" && (
        <MobileFullPlayer
          c={c}
          onClose={nav.back}
          onJump={() => {
            nav.back();
            playback.jumpToPlaying();
          }}
        />
      )}
      <audio {...audio.audioProps} />
    </div>
  );
}
