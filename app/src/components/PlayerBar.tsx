// 画面の下に常に出す再生バー。再生、一時停止、前、次、シークバー、音量、シャッフル、リピート。

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, formatTime, type Status } from "../api";
import Icon from "./Icon";

interface Props {
  /** Android では OS の音量を使うため、アプリ内の音量は出さない */
  showVolume: boolean;
  onOpenPlaylist: (id: string) => void;
}

export default function PlayerBar({ showVolume, onOpenPlaylist }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const refresh = useCallback(() => {
    api.status().then(setStatus).catch(() => {});
  }, []);

  // 曲や状態の変化は、イベントですぐに反映する
  useEffect(() => {
    refresh();
    const unlisten = listen("player", refresh);
    return () => {
      unlisten.then((f) => f());
    };
  }, [refresh]);

  // 再生位置は、再生中だけ 0.5 秒ごとに問い合わせる
  const playing = status?.state === "playing";
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(refresh, 500);
    return () => window.clearInterval(timer);
  }, [playing, refresh]);

  // シークバーを動かし終えたら、その位置へ移る
  const commitSeek = () => {
    if (dragging !== null) api.seek(dragging);
    setDragging(null);
  };

  if (!status) return null;
  const duration = status.duration ?? 0;
  const position = dragging ?? status.position;

  return (
    <footer className="player">
      <div className="now">
        <span
          className={status.playlist_id ? "title clickable" : "title"}
          onClick={() => status.playlist_id && onOpenPlaylist(status.playlist_id)}
        >
          {status.title ?? "停止中"}
        </span>
        {status.artist && <span className="dim"> / {status.artist}</span>}
      </div>
      <div className="seek">
        <span className="time">{formatTime(position)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={0.5}
          value={Math.min(position, Math.max(duration, 1))}
          disabled={status.state === "stopped" || duration === 0}
          onChange={(e) => setDragging(Number(e.target.value))}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
        />
        <span className="time">{formatTime(status.duration)}</span>
      </div>
      <div className="controls">
        <button className={status.shuffle ? "toggle on" : "toggle"} title="シャッフル" onClick={() => api.shuffle(!status.shuffle)}>
          <Icon name="shuffle" />
        </button>
        <button title="前の曲" onClick={() => api.command("prev")}>
          <Icon name="prev" />
        </button>
        <button className="primary big" title={playing ? "一時停止" : "再生"} onClick={() => api.command(playing ? "pause" : "play")}>
          <Icon name={playing ? "pause" : "play"} size={26} />
        </button>
        <button title="次の曲" onClick={() => api.command("next")}>
          <Icon name="next" />
        </button>
        <button className={status.repeat ? "toggle on" : "toggle"} title="リピート" onClick={() => api.repeat(!status.repeat)}>
          <Icon name="repeat" />
        </button>
        {showVolume && (
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={status.volume}
            title="音量"
            onChange={(e) => api.volume(Number(e.target.value))}
          />
        )}
      </div>
    </footer>
  );
}
