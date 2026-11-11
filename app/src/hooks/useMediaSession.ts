import { useEffect, useRef } from "react";
import type { useAudioPlayer } from "./useAudioPlayer";
import { playingName, useTrackTitle } from "./useTrackTitle";

/**
 * Android の側（MainActivity が足す window.CyanoMedia）。再生の通知・ロック画面の操作を出すサービスに、今の曲と状態を知らせる。
 * Windows（と Android の外の画面テスト）にはないので、何もしない
 */
type MediaBridge = {
  /** 再生の通知を出す・書き換える。位置と長さは秒 */
  update: (title: string, subtitle: string, playing: boolean, position: number, duration: number) => void;
  /** 再生の通知を消す */
  stop: () => void;
};

/** Android の側から届く命令（通知・ロック画面・イヤホンのボタン、イヤホンを抜いたとき）。seek の値は秒 */
export type MediaCommand = "play" | "pause" | "next" | "prev" | "stop" | "seek";

declare global {
  interface Window {
    CyanoMedia?: MediaBridge;
    __cyanoMediaCommand?: (command: MediaCommand, value: number) => void;
  }
}

/**
 * 鳴らしているプレイリスト・一覧の再生（試聴は入れない）を、Android の再生の通知とロック画面に出し、そこからの操作を受け取る。
 * 通知を出している間は、画面がロックされても Android の側が WebView を止めないので、鳴り続ける
 */
export function useMediaSession(audio: ReturnType<typeof useAudioPlayer>) {
  const { player } = audio;
  const entry = player?.queue[player.index];
  const trackTitle = useTrackTitle(entry?.path ?? null);
  const title = entry ? playingName(entry.alias, trackTitle, entry.relPath) : "";
  const subtitle = player ? `${player.name} ${player.index + 1}/${player.queue.length}` : "";
  const playing = player !== null && !player.paused && !player.preparing;
  const duration = audio.time.duration;

  const bridge = window.CyanoMedia;
  /** 最後に知らせた中身（曲・状態・長さ）。位置が動くたびには知らせない（鳴らしている間は、Android の側が位置を進めて出す） */
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    const audioElement = audio.audioProps.ref.current;
    const send = () => {
      if (player === null) bridge.stop();
      else bridge.update(title, subtitle, playing, audioElement?.currentTime ?? 0, duration);
    };
    const now = player === null ? "" : JSON.stringify([title, subtitle, playing, duration]);
    if (now !== sent.current) {
      sent.current = now;
      send();
    }
    // 位置を動かしたとき（再生の欄・ロック画面のバー・戻す／進める）も知らせる
    if (player === null || !audioElement) return;
    audioElement.addEventListener("seeked", send);
    return () => audioElement.removeEventListener("seeked", send);
  });

  // Android の側からの命令を、再生の欄の操作につなぐ（毎回、今の操作に付け替える）
  useEffect(() => {
    if (!bridge) return;
    window.__cyanoMediaCommand = (command, value) => {
      const p = audio.player;
      switch (command) {
        case "play":
          if (p?.paused) audio.togglePause();
          break;
        case "pause":
          if (p && !p.paused) audio.togglePause();
          break;
        case "next":
          audio.next();
          break;
        case "prev":
          audio.prev();
          break;
        case "stop":
          audio.stop();
          break;
        case "seek":
          if (duration > 0) audio.seek(value / duration);
          break;
      }
    };
  });
}
