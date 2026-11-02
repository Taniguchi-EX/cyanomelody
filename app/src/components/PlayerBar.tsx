import type { Player } from "../hooks/useAudioPlayer";

type Props = {
  player: Player;
  /** 再生中の位置と長さ（秒） */
  time: { current: number; duration: number };
  onSeek: (ratio: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onTogglePause: () => void;
  onStop: () => void;
};

/** 画面の下の、プレイリストの再生の欄 */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function PlayerBar({ player, time, onSeek, onPrev, onNext, onTogglePause, onStop }: Props) {
  const entry = player.queue[player.index];
  const ratio = time.duration > 0 ? time.current / time.duration : 0;
  return (
    <div className="player-bar" data-testid="player-bar">
      <span className="player-name">{player.name}</span>
      <span className="sub" data-testid="player-position">
        {player.index + 1}/{player.queue.length}
      </span>
      {player.preparing && (
        <span className="warn" data-testid="player-preparing">
          準備中…
        </span>
      )}
      <span className="player-file" title={entry?.path} data-testid="player-file">
        {entry?.alias ? (
          <>
            {entry.alias}
            <span className="sub">（{entry.relPath}）</span>
          </>
        ) : (
          entry?.relPath
        )}
      </span>
      <div
        className="player-progress"
        title={`${clock(time.current)} / ${clock(time.duration)}`}
        data-testid="player-progress"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek((e.clientX - r.left) / r.width);
        }}
      >
        <div style={{ width: `${ratio * 100}%` }} />
      </div>
      <button onClick={onPrev} disabled={player.index === 0} aria-label="前へ">
        ⏮
      </button>
      <button onClick={onTogglePause} disabled={player.preparing} aria-label={player.paused ? "再開" : "一時停止"}>
        {player.paused ? "▶" : "⏸"}
      </button>
      <button onClick={onNext} aria-label="次へ">
        ⏭
      </button>
      <button onClick={onStop} aria-label="停止">
        ■
      </button>
    </div>
  );
}
