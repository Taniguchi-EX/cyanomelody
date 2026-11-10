import { useRef } from "react";
import { PlayerBar } from "../components/PlayerBar";
import { useCover } from "../covers";
import type { AppController } from "../hooks/useAppController";

/** 下へこの距離（px）より動かして離したら閉じる */
const SWIPE_CLOSE = 120;

/**
 * 全画面の再生：上に「↓」（閉じる）、ジャケット（ないときは出さない）、Windows の再生の欄の中身を縦に並べたもの（設定の歯車は出さない）。
 * ボタン・つまみ・プルダウンのない所を下へスワイプしても閉じる
 */
export function MobileFullPlayer({ c, onClose, onJump }: { c: AppController; onClose: () => void; onJump: () => void }) {
  const { audio, files, chains, playback, effectActions } = c;
  const entry = audio.player?.queue[audio.player.index];
  const fileId = entry?.fileId ?? audio.previewFile?.id ?? null;
  const cover = useCover(fileId ?? -1, fileId !== null);
  const swipe = useRef<number | null>(null);
  return (
    <div
      className="m-full"
      data-testid="m-full"
      // 指の動きはスクロールとして扱われる（pointerup が届かない）ことがあるので、touch の知らせで見る。
      // 一番上までスクロールしているときに、ボタン・つまみ・プルダウンのない所から下へ動かしたら閉じる
      onTouchStart={(e) => {
        const onControl = (e.target as HTMLElement).closest("button, input, select, [role=button]");
        swipe.current = onControl || e.currentTarget.scrollTop > 0 ? null : e.touches[0].clientY;
      }}
      onTouchEnd={(e) => {
        const start = swipe.current;
        swipe.current = null;
        if (start !== null && e.changedTouches[0].clientY - start > SWIPE_CLOSE) onClose();
      }}
    >
      <button className="icon m-full-close" onClick={onClose} aria-label="閉じる" title="閉じる">
        ↓
      </button>
      <div className="m-full-cover">{cover && <img src={cover} alt="" draggable={false} data-testid="m-full-cover" />}</div>
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
        onJump={onJump}
        onOpenSettings={() => {}}
      />
    </div>
  );
}
