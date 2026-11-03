import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AudioFile, PlayEntry } from "../api";

/** 試聴するファイル（エフェクトの管理画面の試聴）。ファイルの一覧のファイルでも、プレイリストの項目の曲でもよい */
export type PreviewTarget = Pick<AudioFile, "id" | "relPath" | "path">;
import { chainApi } from "../effects";
import { useStoredNumber } from "../storage";

/** プレイリストの再生の状態 */
export type Player = {
  name: string;
  /** 再生しているプレイリストの id。ファイルの一覧を再生しているときは null */
  sourceId: number | null;
  queue: PlayEntry[];
  index: number;
  paused: boolean;
  /** エフェクトをかけた音を用意している */
  preparing: boolean;
};

type Options = {
  onInfo: (text: string) => void;
  onError: (text: string) => void;
  /** ファイルを鳴らし始めたとき（試聴とプレイリストの1曲ごと。「直近で再生したもの」に記録する） */
  onPlayed: (fileId: number) => void;
};

/**
 * 1つの audio 要素で、試聴（1件）とプレイリストの連続再生を行う。
 * どちらかを始めると、もう一方は止まる。
 */
export function useAudioPlayer({ onInfo, onError, onPlayed }: Options) {
  const audioRef = useRef<HTMLAudioElement>(null);
  /** 試聴中のファイル */
  const [previewFile, setPreviewFile] = useState<PreviewTarget | null>(null);
  const previewId = previewFile?.id ?? null;
  /** 音量（0〜1）。試聴とプレイリストの再生で同じものを使い、アプリを閉じても覚えておく */
  // 動かしている間は音量だけを変え、動かし終えたとき（commitVolume）に保存する
  const [volume, setVolume, commitVolume] = useStoredNumber("cyanomelody.volume", 1);
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);
  const [player, setPlayerState] = useState<Player | null>(null);
  // audio のイベントから今の再生の状態を見るため、状態と同じものを ref にも持つ
  const playerRef = useRef<Player | null>(null);
  /** 再生中の位置と長さ（秒） */
  const [time, setTime] = useState({ current: 0, duration: 0 });

  const setPlayer = (p: Player | null) => {
    playerRef.current = p;
    setPlayerState(p);
  };

  /** 試聴を止める */
  const stopPreview = () => {
    audioRef.current?.pause();
    setPreviewFile(null);
  };

  /** ファイルの試聴として、path の音（エフェクトをかけた音など）を鳴らす */
  const previewPath = (file: PreviewTarget, path: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    setPlayer(null);
    audio.src = convertFileSrc(path);
    setPreviewFile(file);
    onPlayed(file.id);
    audio.play().catch((e) => {
      setPreviewFile(null);
      onError(`再生できませんでした: ${file.relPath}（${e}）`);
    });
  };

  /** 再生順の index 番目を再生する。範囲の外なら終わる */
  const playAt = (p: Player, index: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (index < 0 || index >= p.queue.length) {
      audio.pause();
      setPlayer(null);
      onInfo(`「${p.name}」の再生が終わりました`);
      return;
    }
    const entry = p.queue[index];
    onPlayed(entry.fileId);
    const next = { ...p, index, paused: false, preparing: entry.chains.length > 0 };
    setPlayer(next);
    setPreviewFile(null);
    if (!next.preparing) {
      audio.src = convertFileSrc(entry.path);
      audio.play().catch((e) => skip(next, String(e)));
      return;
    }
    // エフェクトをかけた音を用意してから鳴らす。用意している間に別の曲へ移ったら鳴らさない
    audio.pause();
    chainApi
      .render(entry.fileId, entry.chains)
      .then((path) => {
        if (playerRef.current !== next) return;
        const ready = { ...next, preparing: false };
        setPlayer(ready);
        audio.src = convertFileSrc(path);
        audio.play().catch((e) => skip(ready, String(e)));
      })
      .catch((e) => skip(next, String(e)));
  };

  /** 再生できなかった曲を飛ばす。失敗は play() の失敗と audio の error の両方で届くので、
   *  すでに別の曲に移っていれば何もしない */
  const skip = (p: Player, reason: string) => {
    if (playerRef.current !== p) return;
    onError(`再生できなかったので飛ばしました: ${p.queue[p.index].relPath}（${reason}）`);
    playAt(p, p.index + 1);
  };

  /** プレイリストの再生を始める */
  /** 再生の順番 queue を、start 番目から再生する。sourceId は再生するプレイリスト（ファイルの一覧なら null） */
  const playQueue = (name: string, queue: PlayEntry[], start = 0, sourceId: number | null = null) =>
    playAt({ name, sourceId, queue, index: start, paused: false, preparing: false }, start);

  const move = (delta: number) => {
    const p = playerRef.current;
    if (p) playAt(p, p.index + delta);
  };

  const stop = () => {
    audioRef.current?.pause();
    setPlayer(null);
  };

  /** 0〜1 の位置へ移る */
  const seek = (ratio: number) => {
    const audio = audioRef.current;
    if (audio && Number.isFinite(audio.duration)) audio.currentTime = audio.duration * Math.min(Math.max(ratio, 0), 1);
  };

  const togglePause = () => {
    const audio = audioRef.current;
    const p = playerRef.current;
    if (!audio || !p || p.preparing) return;
    if (p.paused) audio.play().catch((e) => onError(String(e)));
    else audio.pause();
    setPlayer({ ...p, paused: !p.paused });
  };

  /** audio 要素に渡す属性 */
  const audioProps = {
    ref: audioRef,
    onTimeUpdate: (e: React.SyntheticEvent<HTMLAudioElement>) =>
      setTime({ current: e.currentTarget.currentTime, duration: e.currentTarget.duration || 0 }),
    onError: () => {
      const p = playerRef.current;
      if (p) skip(p, "ファイルを読めません");
    },
    // プレイリストの再生中なら次へ。試聴なら止まる
    onEnded: () => {
      const p = playerRef.current;
      if (p) playAt(p, p.index + 1);
      else setPreviewFile(null);
    },
  };

  return {
    previewId,
    previewFile,
    player,
    stopPreview,
    previewPath,
    playQueue,
    next: () => move(1),
    prev: () => move(-1),
    stop,
    togglePause,
    time,
    seek,
    volume,
    setVolume,
    commitVolume,
    audioProps,
  };
}
