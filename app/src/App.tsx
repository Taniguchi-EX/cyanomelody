import { PlayerBar } from "./components/PlayerBar";
import { StatusBar } from "./components/StatusBar";
import { Splitter } from "./components/Splitter";
import { useStoredNumber } from "./storage";
import { useAppController } from "./hooks/useAppController";
import { FilterSections } from "./views/FilterSections";
import { ListArea } from "./views/ListArea";
import { DetailArea } from "./views/DetailArea";
import { Overlays } from "./views/Overlays";

/** 左・右の欄の最小の幅と、中央の欄に残す最小の幅 */
const SIDE_MIN = 180;
const MAIN_MIN = 320;

/**
 * Windows の画面：左・中央・右の3列と、下の再生の欄・一番下の行。
 * 状態と操作は useAppController（Android の画面と共有）、欄の中身は views/ の部品
 */
export default function App() {
  const [sideWidth, setSideWidth, commitSideWidth] = useStoredNumber("cyanomelody.width.side", 280);
  const [detailWidth, setDetailWidth, commitDetailWidth] = useStoredNumber("cyanomelody.width.detail", 300);
  const c = useAppController();
  const {
    files,
    selectedPlaylistId,
    listVersion,
    busy,
    runCount,
    status,
    chains,
    showError,
    checks,
    checked,
    audio,
    setSettingsOpen,
    jobs,
    playback,
    effectActions,
  } = c;

  return (
    // ウィンドウを狭くしたときは、左・右の欄が最小の幅まで縮んでから中央の欄が縮む
    <div
      className="app"
      style={{
        gridTemplateColumns: `minmax(${SIDE_MIN}px, ${sideWidth}px) auto minmax(${MAIN_MIN}px, 1fr) auto minmax(${SIDE_MIN}px, ${detailWidth}px)`,
      }}
    >
      <aside className="side">
        <FilterSections c={c} />
      </aside>
      <Splitter
        label="左の欄の幅"
        width={sideWidth}
        direction={1}
        min={SIDE_MIN}
        max={() => window.innerWidth - detailWidth - MAIN_MIN}
        onChange={setSideWidth}
        onCommit={commitSideWidth}
      />

      <main className="main">
        <ListArea c={c} />
      </main>
      <Splitter
        label="右の欄の幅"
        width={detailWidth}
        direction={-1}
        min={SIDE_MIN}
        max={() => window.innerWidth - sideWidth - MAIN_MIN}
        onChange={setDetailWidth}
        onCommit={commitDetailWidth}
      />

      <aside className="detail">
        <DetailArea c={c} />
      </aside>

      <PlayerBar
        player={audio.player}
        time={audio.time}
        // 表示中の一覧を再生する（プレイリストを選んでいれば、プレイリストとして）
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
        onJump={playback.jumpToPlaying}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <StatusBar
        status={status}
        busy={busy}
        runCount={runCount}
        listVersion={listVersion}
        fileCount={files.length}
        checkedCount={checked.size}
        shownChecked={checks.shownChecked}
        songs={selectedPlaylistId !== null}
        exportProgress={jobs.exportProgress}
        hashProgress={jobs.hashProgress}
        autotagProgress={jobs.autotagProgress}
        onError={showError}
      />
      <audio {...audio.audioProps} />
      <Overlays c={c} />
    </div>
  );
}
