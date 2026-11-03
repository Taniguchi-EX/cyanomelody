import { useEffect, useState } from "react";
import { api, PLAY_MODES, type PlayMode } from "../api";
import { stem } from "../paths";
import type { Player, PreviewTarget } from "../hooks/useAudioPlayer";

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
  /** 試聴中のファイル（一覧の行の再生ボタン）。なければ null */
  previewFile: PreviewTarget | null;
  /** 音量（0〜1） */
  volume: number;
  onVolume: (volume: number) => void;
  /** 音量のバーを動かし終えたとき（保存する） */
  onVolumeCommit: () => void;
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
  previewFile,
  volume,
  onVolume,
  onVolumeCommit,
}: Props) {
  const entry = player?.queue[player.index];
  // 鳴らしているファイル。曲名（タグ情報のタイトル）はデータベースにないので、ファイルから読む
  const playing = entry ?? previewFile;
  const playingPath = playing?.path ?? null;
  const [title, setTitle] = useState<{ path: string; title: string | null } | null>(null);
  useEffect(() => {
    if (playingPath === null) return;
    let alive = true;
    api
      .trackTitle(playingPath)
      .then((t) => alive && setTitle({ path: playingPath, title: t }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [playingPath]);
  const trackTitle = title && title.path === playingPath ? title.title : null;
  /** 曲の名前：プレイリスト上での名前 → 曲名 → 拡張子を除いたファイル名 */
  const name = playing ? (entry?.alias ?? trackTitle ?? stem(playing.relPath)) : "";
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
      {/* 1行目に曲の名前、2行目にファイル名（1行目と同じなら出さない）・プレイリスト名・何曲目。試聴中はファイル名と「試聴」 */}
      <div className="play-now">
        <div className="player-file" title={playingPath ?? undefined} data-testid="player-file">
          {name}
        </div>
        {/* 2行目：ファイル名（相対パス）と、プレイリスト名・何曲目（試聴なら「試聴」） */}
        {player && (
          <div className="sub play-where">
            {entry && <span data-testid="player-file-name">{entry.relPath}</span>}
            <span className="player-name">{player.name}</span>
            <span data-testid="player-position">
              {player.index + 1}/{player.queue.length}
            </span>
            {player.preparing && (
              <span className="warn" data-testid="player-preparing">
                準備中…
              </span>
            )}
          </div>
        )}
        {!player && previewFile && (
          <div className="sub play-where">
            <span data-testid="player-file-name">{previewFile.relPath}</span>
            <span data-testid="player-preview">試聴</span>
          </div>
        )}
      </div>

      <div className="play-center">
        {/* 「▶／⏸」が中央に来るよう、左右の欄を同じ幅にする（左に ⏮、右に ⏭ 🔀 🎲 ■） */}
        <div className="play-buttons">
          <div className="play-side-left">
            <button
              className="icon"
              onClick={onPrev}
              disabled={!player || player.index === 0}
              title="前へ"
              aria-label="前へ"
            >
              ⏮
            </button>
          </div>
          <button
            className="play-main"
            onClick={main.onClick}
            disabled={main.disabled}
            title={main.label}
            aria-label={main.label}
          >
            {main.icon}
          </button>
          <div className="play-side-right">
            <button className="icon" onClick={onNext} disabled={!player} title="次へ" aria-label="次へ">
              ⏭
            </button>
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

      <div className="play-side">
        <span className="sub" aria-hidden="true">
          🔈
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(volume * 100)}
          onChange={(e) => onVolume(Number(e.target.value) / 100)}
          onPointerUp={onVolumeCommit}
          onKeyUp={onVolumeCommit}
          title={`音量 ${Math.round(volume * 100)}%`}
          aria-label="音量"
          data-testid="player-volume"
        />
      </div>
    </div>
  );
}
