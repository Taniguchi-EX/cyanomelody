import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AudioFile } from "../api";

const ROW_HEIGHT = 30;

export type SelectMode = "single" | "toggle" | "range";

type Props = {
  files: AudioFile[];
  selected: Set<number>;
  playingId: number | null;
  onSelect: (index: number, mode: SelectMode) => void;
  onSelectAll: () => void;
  onPlay: (file: AudioFile) => void;
  /** 行にハッシュ値の先頭を出す（重複を見るとき） */
  showHash: boolean;
};

export function FileList({ files, selected, playingId, onSelect, onSelectAll, onPlay, showHash }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  if (files.length === 0) {
    return <div className="empty">該当するファイルはありません</div>;
  }

  return (
    <div
      className="list"
      ref={parentRef}
      tabIndex={0}
      data-testid="file-list"
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === "a") {
          e.preventDefault();
          onSelectAll();
        }
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const f = files[item.index];
          const classes = ["file-row"];
          if (selected.has(f.id)) classes.push("selected");
          if (f.missing) classes.push("missing");
          return (
            <div
              key={f.id}
              className={classes.join(" ")}
              style={{ top: item.start, height: ROW_HEIGHT }}
              data-testid="file-row"
              data-rel-path={f.relPath}
              onClick={(e) =>
                onSelect(item.index, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "single")
              }
            >
              <button
                className="play"
                disabled={f.missing}
                title={playingId === f.id ? "停止" : "再生"}
                aria-label={playingId === f.id ? "停止" : "再生"}
                onClick={(e) => {
                  e.stopPropagation();
                  onPlay(f);
                }}
              >
                {playingId === f.id ? "■" : "▶"}
              </button>
              {f.missing && (
                <span className="warn" title="ファイルが見つかりません">
                  ⚠見つからない
                </span>
              )}
              {showHash && (
                <span className="hash" title={f.hash ?? ""}>
                  {f.hash?.slice(0, 8) ?? "--------"}
                </span>
              )}
              <span className="file-name" title={f.path}>
                {f.relPath}
              </span>
              <span>
                {f.tags.map((t) => (
                  <span className="chip" key={t}>
                    {t}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
