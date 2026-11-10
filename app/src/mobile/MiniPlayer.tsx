import { stem } from "../paths";
import { NextIcon, PauseIcon, PlayIcon } from "../components/Icons";
import type { AppController } from "../hooks/useAppController";

/**
 * 再生エリア（小）：進み具合の細い線、曲の名前と再生しているもの、「▶／⏸」「⏭」。
 * ボタンのない所を押すと、全画面の再生を開く
 */
export function MiniPlayer({ c, onOpen }: { c: AppController; onOpen: () => void }) {
  const { audio, files, playback } = c;
  const player = audio.player;
  const entry = player?.queue[player.index];
  const playing = entry ?? audio.previewFile;
  const name = entry?.alias ?? (playing ? stem(playing.relPath) : "");
  const ratio = audio.time.duration > 0 ? audio.time.current / audio.time.duration : 0;
  const canPlay = files.some((f) => !f.missing);
  const main = player
    ? {
        label: player.paused ? "再開" : "一時停止",
        icon: player.paused ? <PlayIcon size={20} /> : <PauseIcon size={20} />,
        onClick: audio.togglePause,
        disabled: player.preparing,
      }
    : { label: "再生を始める", icon: <PlayIcon size={20} />, onClick: playback.playOpen, disabled: !canPlay };
  return (
    <div className="m-mini" data-testid="m-mini" onClick={onOpen}>
      <div className="m-mini-progress" style={{ width: `${ratio * 100}%` }} />
      <div className="m-mini-text">
        <div className="m-mini-name">{name || "再生していません"}</div>
        {player && (
          <div className="sub m-mini-where">
            {player.name} {player.index + 1}/{player.queue.length}
          </div>
        )}
      </div>
      <button
        className="icon m-mini-button"
        onClick={(e) => {
          e.stopPropagation();
          main.onClick();
        }}
        disabled={main.disabled}
        aria-label={main.label}
        title={main.label}
      >
        {main.icon}
      </button>
      <button
        className="icon m-mini-button"
        onClick={(e) => {
          e.stopPropagation();
          audio.next();
        }}
        disabled={!player}
        aria-label="次へ"
        title="次へ"
      >
        <NextIcon size={18} />
      </button>
    </div>
  );
}
