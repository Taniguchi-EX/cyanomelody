import { useEffect, useState } from "react";
import { useDisplay } from "../displaySettings";
import { api } from "../api";
import type { EffectChain } from "../effects";
import { stem } from "../paths";
import { GearIcon, SpeakerIcon } from "./Icons";
import { PLAYER_MODES, type Player, type PlayerMode, type PreviewTarget } from "../hooks/useAudioPlayer";

type Props = {
  /** プレイリストの再生。何も再生していなければ null */
  player: Player | null;
  /** 再生中の位置と長さ（秒） */
  time: { current: number; duration: number };
  /** 何も再生していないときに「▶」で再生するものがあるか（表示中の中央の一覧に鳴らせる曲があるか） */
  canPlayOpen: boolean;
  /** 表示中の中央の一覧を、選んでいる再生方法で再生する（プレイリストを選んでいればプレイリストとして） */
  onPlayOpen: () => void;
  /** 再生方法（再生方法のボタンで、押すたびに変わる） */
  playMode: PlayerMode;
  onPlayMode: (mode: PlayerMode) => void;
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
  /** スピーカーのボタン：ミュートとミュートの解除を切り替える */
  onToggleMute: () => void;
  chains: EffectChain[];
  /** 再生の欄で選んだエフェクトセット（null は「fx なし」） */
  baseChain: number | null;
  onBaseChain: (chainId: number | null) => void;
  /** エフェクトセットの管理画面を開く。chainId を選んで開き、null なら新しいエフェクトセットを作る */
  onOpenEffects: (chainId: number | null) => void;
  /** 曲名を押したとき：鳴らしている曲を中央の欄に出す */
  onJump: () => void;
  /** 右端の歯車：設定画面を開く */
  onOpenSettings: () => void;
};

/** fx のプルダウンの、管理画面を開く選び肢 */
const NEW_FX = "new-fx";
const EDIT_FX = "edit-fx";
/** 項目のエフェクトがかかる曲を鳴らしている間だけ足す、表示用の選び肢（選べない） */
const ITEM_FX = "item-fx";

const clock = (s: number) =>
  Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00";
const SEEK_STEPS = 1000;

/** ウィンドウの下の、プレイリストの再生の欄。何も再生していないときも出しておく */
// 中央の丸の中の記号。文字（▶⏸）は書体によって中心がずれるので、図形で描く
const PLAY_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    {/* 三角は見た目の重心が左に寄るので、少し右へずらす */}
    <path d="M5 2.5 L13.5 8 L5 13.5 Z" fill="currentColor" />
  </svg>
);
const PAUSE_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="3.5" y="2.5" width="3" height="11" rx="0.5" fill="currentColor" />
    <rect x="9.5" y="2.5" width="3" height="11" rx="0.5" fill="currentColor" />
  </svg>
);

export function PlayerBar({
  player,
  time,
  canPlayOpen,
  onPlayOpen,
  playMode,
  onPlayMode,
  onSeek,
  onPrev,
  onNext,
  onTogglePause,
  onStop,
  previewFile,
  volume,
  onVolume,
  onVolumeCommit,
  onToggleMute,
  chains,
  baseChain,
  onBaseChain,
  onOpenEffects,
  onJump,
  onOpenSettings,
}: Props) {
  // ファイル名（相対パス）は、設定画面の「表示」で拡張子を省くことにしていれば省く
  const { hideExtension } = useDisplay();
  const shownPath = (rel: string) => (hideExtension ? rel.replace(/\.[^./]+$/, "") : rel);
  const entry = player?.queue[player.index];
  // 鳴らしているファイル。曲名（タグ情報のタイトル）はデータベースにないので、ファイルから読む
  const playing = entry ?? previewFile;
  const playingPath = playing?.path ?? null;
  const [title, setTitle] = useState<{ path: string; title: string | null } | null>(null);
  useEffect(() => {
    if (playingPath === null) return;
    let alive = true;
    // 曲名を読めないときは、ファイル名を出す（エラーにしない）
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
  // 鳴らしている曲にプレイリストの項目のエフェクトがかかるときは、再生の欄のエフェクトセットはかけない
  const itemFx = (entry?.chains.length ?? 0) > 0;
  // 項目のエフェクトセットの名前（内側から外側の順。消えたエフェクトセットは飛ばす）。グレーアウトしたプルダウンに出す
  const itemFxName = itemFx
    ? entry!.chains
        .map((id) => chains.find((c) => c.id === id)?.name)
        .filter((n): n is string => n !== undefined)
        .join(" → ") || "項目の fx"
    : "";
  // 再生方法のボタン：今の再生方法と、押したときに変わる先
  const modeIndex = PLAYER_MODES.findIndex((m) => m.mode === playMode);
  const mode = PLAYER_MODES[modeIndex];
  const nextMode = PLAYER_MODES[(modeIndex + 1) % PLAYER_MODES.length];

  // 中央の「▶」：再生中は一時停止・再開。何も再生していなければ、表示中の中央の一覧を再生する
  const main = player
    ? {
        label: player.paused ? "再開" : "一時停止",
        icon: player.paused ? PLAY_ICON : PAUSE_ICON,
        onClick: onTogglePause,
        disabled: player.preparing,
      }
    : {
        label: "再生を始める",
        icon: PLAY_ICON,
        onClick: onPlayOpen,
        disabled: !canPlayOpen,
      };

  return (
    <div className="play-area" data-testid="player-bar" data-playing={player !== null}>
      {/* 1行目に曲の名前、2行目にファイル名（1行目と同じなら出さない）・プレイリスト名・何曲目。試聴中はファイル名と「試聴」 */}
      <div className="play-now">
        {/* 押すと、鳴らしている曲（プレイリストの項目の行か、ライブラリの行）へ飛ぶ */}
        {playing ? (
          <div
            className="player-file jump"
            role="button"
            tabIndex={0}
            onClick={onJump}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onJump())}
            title={playingPath ?? undefined}
            data-testid="player-file"
          >
            {name}
          </div>
        ) : (
          <div className="player-file" data-testid="player-file" />
        )}
        {/* 2行目：ファイル名（相対パス）と、プレイリスト名・何曲目（試聴なら「試聴」） */}
        {player && (
          <div className="sub play-where">
            {entry && <span data-testid="player-file-name">{shownPath(entry.relPath)}</span>}
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
            <span data-testid="player-file-name">{shownPath(previewFile.relPath)}</span>
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
            <div className="play-modes">
            {/* 再生方法：押すたびに 一曲だけ → 順に連続 → ランダム → ランダムセレクト と変わる。再生中なら今の曲の後に効く */}
            <button
              className="icon play-mode"
              onClick={() => onPlayMode(nextMode.mode)}
              title={`再生方法：${mode.label}`}
              aria-label="再生方法"
              data-testid="play-mode"
              data-mode={mode.mode}
            >
              {mode.icon}
            </button>
            <button className="icon" onClick={onStop} disabled={!player} title="停止" aria-label="停止">
              ■
            </button>
            </div>
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
          <span className="sub play-duration" data-testid="player-duration">
            {clock(player ? time.duration : 0)}
          </span>
        </div>
      </div>

      <div className="play-side">
        {/*
          再生する曲にかけるエフェクトセット。項目のエフェクトがかかる曲ではグレーアウトし、かけている項目のエフェクトセットの名前を出す
          （先頭の表示用の選び肢を選んだ状態に見せる。選び直すことはできる）
        */}
        <select
          className={`player-fx${itemFx ? " overridden" : ""}`}
          value={itemFx ? ITEM_FX : (baseChain ?? "")}
          onChange={(e) => {
            const v = e.target.value;
            if (v === ITEM_FX) return;
            if (v === NEW_FX) onOpenEffects(null);
            else if (v === EDIT_FX) onOpenEffects(baseChain);
            else onBaseChain(v ? Number(v) : null);
          }}
          aria-label="再生する曲にかけるエフェクト"
          title={
            itemFx
              ? `この曲には、プレイリストの項目のエフェクト（${itemFxName}）をかけています。再生の欄で選んだエフェクトセットはかけません`
              : "再生する曲にかけるエフェクトセット（プレイリストの項目のエフェクトがあれば、そちらをかけます）"
          }
          data-testid="player-fx"
          data-overridden={itemFx}
        >
          {itemFx && (
            <option value={ITEM_FX} disabled hidden>
              {itemFxName}
            </option>
          )}
          <option value="">fx なし</option>
          {chains.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value={NEW_FX}>新しいfxを作る</option>
          {baseChain !== null && <option value={EDIT_FX}>このfxを編集</option>}
        </select>
        <button
          className="icon speaker-button"
          onClick={onToggleMute}
          title={volume > 0 ? "ミュート" : "ミュートを解除"}
          aria-label={volume > 0 ? "ミュート" : "ミュートを解除"}
          data-testid="player-mute"
          data-muted={volume === 0}
        >
          <SpeakerIcon volume={volume} />
        </button>
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
        <button className="icon settings-button" onClick={onOpenSettings} title="設定" aria-label="設定">
          <GearIcon />
        </button>
      </div>
    </div>
  );
}
