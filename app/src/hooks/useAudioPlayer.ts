import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AudioFile, PlayEntry } from "../api";

/** 試聴するファイル（エフェクトの管理画面の試聴）。ファイルの一覧のファイルでも、プレイリストの項目の曲でもよい */
export type PreviewTarget = Pick<AudioFile, "id" | "relPath" | "path">;
import { chainApi } from "../effects";
import { useStoredNumber, useStoredString } from "../storage";

/** 再生の欄で選ぶ再生方法。プレイリスト（またはファイルの一覧、項目）全体に当てはめる */
export type PlayerMode = "one" | "order" | "shuffle" | "random";

/** 再生方法のボタンで、押すたびに変わる順 */
export const PLAYER_MODES: { mode: PlayerMode; icon: string; label: string }[] = [
  { mode: "one", icon: "①", label: "一曲だけ再生" },
  { mode: "order", icon: "⇒", label: "順に連続再生" },
  { mode: "shuffle", icon: "🔀", label: "ランダム再生" },
  { mode: "random", icon: "🎲", label: "ランダムセレクト" },
];

/** プレイリストの再生の状態 */
export type Player = {
  name: string;
  /** 再生しているプレイリストの id。ファイルの一覧を再生しているときは null */
  sourceId: number | null;
  /** 元の並び（再生方法を当てはめる前） */
  source: PlayEntry[];
  /** 再生順の各曲が、元の並びの何番目か（queue と同じ長さ） */
  positions: number[];
  /** 再生順（positions の順に source から取ったもの） */
  queue: PlayEntry[];
  /** 再生を始めた曲が再生順の何番目か（それより前は、まだ鳴らしていない） */
  startIndex: number;
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
  /** 今あるエフェクトセットのid（削除されたエフェクトセットを、再生の欄で選んだままにしない） */
  chainIds: number[];
};

function shuffled<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const range = (from: number, to: number) => Array.from({ length: Math.max(to - from, 0) }, (_, i) => from + i);

/**
 * 再生を始めるときの再生順（元の並びの位置）と、最初に鳴らすのが何番目か。start は最初に鳴らす曲（null なら再生方法で決める）。
 * 順に連続で途中の曲から始めるときは、それより前の曲も再生順に入れておく（「⏮」で戻れる）
 */
function arrange(mode: PlayerMode, n: number, start: number | null): { positions: number[]; index: number } {
  switch (mode) {
    case "one":
      return { positions: [start ?? 0], index: 0 };
    case "order":
      return { positions: range(0, n), index: start ?? 0 };
    case "shuffle":
      return {
        positions: start === null ? shuffled(range(0, n)) : [start, ...shuffled(range(0, n).filter((i) => i !== start))],
        index: 0,
      };
    case "random":
      return { positions: [start ?? Math.floor(Math.random() * n)], index: 0 };
  }
}

/** 再生中に再生方法を変えたときの、今の曲（元の並びの current 番目）より後の再生順。played は鳴らした曲 */
function arrangeRest(mode: PlayerMode, n: number, current: number, played: Set<number>): number[] {
  switch (mode) {
    case "one":
    case "random":
      return [];
    case "order":
      return range(current + 1, n);
    case "shuffle":
      return shuffled(range(0, n).filter((i) => !played.has(i)));
  }
}

/**
 * 1つの audio 要素で、試聴（1件）とプレイリストの連続再生を行う。
 * どちらかを始めると、もう一方は止まる。
 */
export function useAudioPlayer({ onInfo, onError, onPlayed, chainIds }: Options) {
  const audioRef = useRef<HTMLAudioElement>(null);
  /** 試聴中のファイル */
  const [previewFile, setPreviewFile] = useState<PreviewTarget | null>(null);
  const previewId = previewFile?.id ?? null;
  /** 音量（0〜1）。試聴とプレイリストの再生で同じものを使い、アプリを閉じても覚えておく */
  // 動かしている間は音量だけを変え、動かし終えたとき（commitVolume）に保存する
  const [volume, setVolume, commitVolume, saveVolume] = useStoredNumber("cyanomelody.volume", 1);
  /** ミュートする前の音量（解除で戻す）。覚えていなければ 100% に戻す */
  const unmuteVolume = useRef(1);
  /** スピーカーのボタン：音量が0でなければ0にし（ミュート）、0なら前の音量に戻す */
  const toggleMute = () => {
    if (volume > 0) {
      unmuteVolume.current = volume;
      saveVolume(0);
    } else {
      saveVolume(unmuteVolume.current > 0 ? unmuteVolume.current : 1);
    }
  };
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);
  const [player, setPlayerState] = useState<Player | null>(null);
  // audio のイベントから今の再生の状態を見るため、状態と同じものを ref にも持つ
  const playerRef = useRef<Player | null>(null);
  /** 再生中の位置と長さ（秒） */
  const [time, setTime] = useState({ current: 0, duration: 0 });
  /** 再生の欄で選んだエフェクトセット。プレイリストの項目のエフェクトがかからない曲にかける。アプリを閉じても覚えておく */
  const [storedChain, storeChain] = useStoredString("cyanomelody.playerChain");
  // 削除されたエフェクトセットは、選んでいないことにする
  const baseChain = storedChain && chainIds.includes(Number(storedChain)) ? Number(storedChain) : null;
  // audio のイベントや、エフェクトをかけ終えたときに今の選択を見るため、ref にも持つ
  const baseChainRef = useRef(baseChain);
  useEffect(() => {
    baseChainRef.current = baseChain;
  }, [baseChain]);

  /** 再生の欄で選んだ再生方法。アプリを閉じても覚えておく */
  const [storedMode, storeMode] = useStoredString("cyanomelody.playerMode");
  const playMode: PlayerMode = PLAYER_MODES.find((m) => m.mode === storedMode)?.mode ?? "order";
  const playModeRef = useRef(playMode);
  useEffect(() => {
    playModeRef.current = playMode;
  }, [playMode]);
  /**
   * 鳴らし始めた回数。エフェクトの用意や再生の失敗が届いたとき、その後に別の曲へ移った・止めたなら何もしないために使う
   * （再生順を作り直すと Player は別のものになるので、Player では比べない）
   */
  const playSeqRef = useRef(0);

  /** 曲にかけるエフェクトセット。プレイリストの項目のものがあればそれだけ、なければ再生の欄で選んだもの */
  const chainsOf = (entry: PlayEntry, base: number | null) =>
    entry.chains.length > 0 ? entry.chains : base !== null ? [base] : [];

  const setPlayer = (p: Player | null) => {
    // 止めたら、用意中のエフェクトの音を鳴らさない
    if (p === null) playSeqRef.current++;
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

  /** 再生順の index 番目を再生する。範囲の外なら終わる。startAt（秒）があれば、同じ曲をその位置から鳴らし直す */
  const playAt = (p: Player, index: number, startAt: number | null = null, base = baseChainRef.current) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (index < 0 || index >= p.queue.length) {
      audio.pause();
      setPlayer(null);
      onInfo(`「${p.name}」の再生が終わりました`);
      return;
    }
    const entry = p.queue[index];
    const seq = ++playSeqRef.current;
    // 鳴らし直すときは、同じ曲を2回再生したことにしない
    if (startAt === null) onPlayed(entry.fileId);
    const chains = chainsOf(entry, base);
    const next = { ...p, index, paused: false, preparing: chains.length > 0 };
    setPlayer(next);
    setPreviewFile(null);
    /** 音の場所を決めて鳴らす */
    const start = (path: string) => {
      audio.src = convertFileSrc(path);
      if (startAt) audio.currentTime = startAt;
      audio.play().catch((e) => skip(seq, String(e)));
    };
    if (!next.preparing) {
      start(entry.path);
      return;
    }
    // エフェクトをかけた音を用意してから鳴らす。用意している間に別の曲へ移ったら鳴らさない
    // （用意している間に再生方法を変えたときは、作り直した再生順のまま鳴らす）
    audio.pause();
    chainApi
      .render(entry.fileId, chains)
      .then((path) => {
        const current = playerRef.current;
        if (playSeqRef.current !== seq || !current) return;
        setPlayer({ ...current, preparing: false });
        start(path);
      })
      .catch((e) => skip(seq, String(e)));
  };

  /** 再生できなかった曲を飛ばす。失敗は play() の失敗と audio の error の両方で届くので、
   *  すでに別の曲に移っていれば（seq が違えば）何もしない */
  const skip = (seq: number, reason: string) => {
    const p = playerRef.current;
    if (playSeqRef.current !== seq || !p) return;
    onError(`再生できなかったので飛ばしました: ${p.queue[p.index].relPath}（${reason}）`);
    playAt(p, p.index + 1);
  };

  /**
   * 元の並び source を、再生の欄で選んだ再生方法で再生する。start は最初に鳴らす曲の位置（行の「▶」。null なら再生方法で決める）。
   * sourceId は再生するプレイリスト（ファイルの一覧なら null）
   */
  const playSource = (name: string, source: PlayEntry[], start: number | null = null, sourceId: number | null = null) => {
    if (source.length === 0) return;
    const { positions, index } = arrange(playModeRef.current, source.length, start);
    const queue = positions.map((i) => source[i]);
    playAt({ name, sourceId, source, positions, queue, startIndex: index, index, paused: false, preparing: false }, index);
  };

  /**
   * 再生方法を変える。再生中なら、鳴らしている曲はそのままにして、その後の再生順を新しい再生方法で作り直す
   */
  const setPlayMode = (mode: PlayerMode) => {
    storeMode(mode);
    playModeRef.current = mode;
    const p = playerRef.current;
    if (!p) return;
    // 始めた曲から今の曲までは再生順に残す（「⏮」で戻れる）。始めた曲より前（まだ鳴らしていない曲）は外す
    const from = Math.min(p.startIndex, p.index);
    const kept = p.positions.slice(from, p.index + 1);
    const positions = [...kept, ...arrangeRest(mode, p.source.length, p.positions[p.index], new Set(kept))];
    const changed = { ...p, positions, queue: positions.map((i) => p.source[i]), startIndex: 0, index: p.index - from };
    playerRef.current = changed;
    setPlayerState(changed);
  };

  const move = (delta: number) => {
    const p = playerRef.current;
    if (p) playAt(p, p.index + delta);
  };

  const stop = () => {
    audioRef.current?.pause();
    setPlayer(null);
  };

  /**
   * 再生の欄のエフェクトセットを選ぶ（null は「fx なし」）。
   * 鳴らしている曲にプレイリストの項目のエフェクトがかからなければ、その曲を新しいエフェクトで同じ位置から鳴らし直す
   */
  const setBaseChain = (chainId: number | null) => {
    storeChain(chainId === null ? "" : String(chainId));
    baseChainRef.current = chainId;
    const p = playerRef.current;
    const audio = audioRef.current;
    if (!p || !audio || p.queue[p.index].chains.length > 0) return;
    playAt(p, p.index, p.preparing ? 0 : audio.currentTime, chainId);
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
      if (playerRef.current) skip(playSeqRef.current, "ファイルを読めません");
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
    playSource,
    playMode,
    setPlayMode,
    next: () => move(1),
    prev: () => move(-1),
    stop,
    togglePause,
    time,
    seek,
    volume,
    setVolume,
    commitVolume,
    toggleMute,
    baseChain,
    setBaseChain,
    audioProps,
  };
}
