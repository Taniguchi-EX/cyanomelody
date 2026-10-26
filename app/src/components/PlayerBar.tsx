// 画面の下に常に出す再生バー。再生、一時停止、前、次、シークバー、音量、シャッフル、リピート。

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, formatTime, type AppInfo, type PlayerEvent, type Status } from "../api";

export default function PlayerBar({ onOpenPlaylist }: { onOpenPlaylist: (id: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const failed = useRef(0);

  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => {});
    const refresh = () => api.status().then(setStatus).catch(() => {});
    refresh();
    // 再生位置は 0.5 秒ごとに、曲や状態の変化はイベントですぐに反映する
    const timer = window.setInterval(refresh, 500);
    const unlisten = listen<PlayerEvent>("player", (e) => {
      if (e.payload.kind === "failed") failed.current += 1;
      refresh();
    });
    return () => {
      window.clearInterval(timer);
      unlisten.then((f) => f());
    };
  }, []);

  if (!status) return null;
  const playing = status.state === "playing";
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
          onPointerUp={() => {
            if (dragging !== null) api.seek(dragging);
            setDragging(null);
          }}
          onKeyUp={() => {
            if (dragging !== null) api.seek(dragging);
            setDragging(null);
          }}
        />
        <span className="time">{formatTime(status.duration)}</span>
      </div>
      <div className="controls">
        <button className={status.shuffle ? "toggle on" : "toggle"} title="シャッフル" onClick={() => api.shuffle(!status.shuffle)}>
          ⇄
        </button>
        <button title="前の曲" onClick={() => api.command("prev")}>
          ⏮
        </button>
        <button className="primary big" title={playing ? "一時停止" : "再生"} onClick={() => api.command(playing ? "pause" : "play")}>
          {playing ? "⏸" : "▶"}
        </button>
        <button title="次の曲" onClick={() => api.command("next")}>
          ⏭
        </button>
        <button className={status.repeat ? "toggle on" : "toggle"} title="リピート" onClick={() => api.repeat(!status.repeat)}>
          ⟳
        </button>
        {/* Android では OS の音量を使うため、アプリ内の音量は出さない */}
        {info?.platform === "desktop" && (
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
