import { PLAY_MODES, type PlayMode } from "../api";
import type { Player } from "../hooks/useAudioPlayer";

type Props = {
  /** プレイリストの再生。何も再生していなければ null */
  player: Player | null;
  /** 再生中の位置と長さ（秒） */
  time: { current: number; duration: number };
  /** 詳細画面で開いているプレイリストがあるか（「▶」「🔀」「🎲」で再生する） */
  canPlayOpen: boolean;
  /** 開いているプレイリストを、その方法で最初から再生する */
  onPlayOpen: (mode: PlayMode) => void;
  onSeek: (ratio: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onTogglePause: () => void;
  onStop: () => void;
};

const clock = (s: number) =>
  Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00";
const SEEK_STEPS = 1000;
const modeOf = (mode: PlayMode) => PLAY_MODES.find((m) => m.mode === mode)!;

/** ウィンドウの下の、プレイリストの再生の欄。何も再生していないときも出しておく */
export function PlayerBar({
  player,
  time,
  canPlayOpen,
  onPlayOpen,
  onSeek,
  onPrev,
  onNext,
  onTogglePause,
  onStop,
}: Props) {
  const entry = player?.queue[player.index];
  const ratio = player && time.duration > 0 ? time.current / time.duration : 0;
  const shuffle = modeOf("shuffle");
  const random = modeOf("random");

  // 中央の「▶」：再生中は一時停止・再開。何も再生していなければ、開いているプレイリストを順に再生する
  const main = player
    ? {
        label: player.paused ? "再開" : "一時停止",
        icon: player.paused ? "▶" : "⏸",
        onClick: onTogglePause,
        disabled: player.preparing,
      }
    : {
        label: modeOf("order").label,
        icon: "▶",
        onClick: () => onPlayOpen("order"),
        disabled: !canPlayOpen,
      };

  return (
    <div className="play-area" data-testid="player-bar" data-playing={player !== null}>
      <div className="play-now">
        <div
          className="player-file"
          title={entry ? `${entry.relPath}\n${entry.path}` : undefined}
          data-testid="player-file"
        >
          {entry ? (entry.alias ?? entry.relPath) : ""}
        </div>
        {player && (
          <div className="sub play-where">
            <span className="player-name">{player.name}</span>{" "}
            <span data-testid="player-position">
              {player.index + 1}/{player.queue.length}
            </span>
            {player.preparing && (
              <span className="warn" data-testid="player-preparing">
                {" "}
                準備中…
              </span>
            )}
          </div>
        )}
      </div>

      <div className="play-center">
        <div className="play-buttons">
          <button
            className="icon"
            onClick={() => onPlayOpen("shuffle")}
            disabled={!canPlayOpen}
            title={shuffle.label}
            aria-label={shuffle.label}
          >
            {shuffle.icon}
          </button>
          <button
            className="icon"
            onClick={onPrev}
            disabled={!player || player.index === 0}
            title="前へ"
            aria-label="前へ"
          >
            ⏮
          </button>
          <button
            className="play-main"
            onClick={main.onClick}
            disabled={main.disabled}
            title={main.label}
            aria-label={main.label}
          >
            {main.icon}
          </button>
          <button className="icon" onClick={onNext} disabled={!player} title="次へ" aria-label="次へ">
            ⏭
          </button>
          <button
            className="icon"
            onClick={() => onPlayOpen("random")}
            disabled={!canPlayOpen}
            title={random.label}
            aria-label={random.label}
          >
            {random.icon}
          </button>
          <button className="icon" onClick={onStop} disabled={!player} title="停止" aria-label="停止">
            ■
          </button>
        </div>
        <div className="play-seek">
          <span className="sub" data-testid="player-current">
            {clock(player ? time.current : 0)}
          </span>
          <input
            type="range"
            min={0}
            max={SEEK_STEPS}
            value={Math.round(ratio * SEEK_STEPS)}
            disabled={!player}
            onChange={(e) => onSeek(Number(e.target.value) / SEEK_STEPS)}
            aria-label="再生位置"
            data-testid="player-progress"
          />
          <span className="sub" data-testid="player-duration">
            {clock(player ? time.duration : 0)}
          </span>
        </div>
      </div>

      <div className="play-side" />
    </div>
  );
}
