import type { Player } from "../hooks/useAudioPlayer";

type Props = {
  player: Player;
  onPrev: () => void;
  onNext: () => void;
  onTogglePause: () => void;
  onStop: () => void;
};

/** 画面の下の、プレイリストの再生の欄 */
export function PlayerBar({ player, onPrev, onNext, onTogglePause, onStop }: Props) {
  const entry = player.queue[player.index];
  return (
    <div className="player-bar" data-testid="player-bar">
      <span className="player-name">{player.name}</span>
      <span className="sub" data-testid="player-position">
        {player.index + 1}/{player.queue.length}
      </span>
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
      <button onClick={onPrev} disabled={player.index === 0} aria-label="前へ">
        ⏮
      </button>
      <button onClick={onTogglePause} aria-label={player.paused ? "再開" : "一時停止"}>
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
