import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AudioFile } from "../api";
import { useFileDrag } from "../hooks/useFileDrag";

const ROW_HEIGHT = 30;

type Props = {
  files: AudioFile[];
  /** クリックして右の欄に出しているファイル */
  focusedId: number | null;
  /** チェックしたファイル（表示していないものも含む） */
  checked: Set<number>;
  playingId: number | null;
  onFocus: (file: AudioFile) => void;
  /** 行のチェックボックス。range が true なら前に押した行との間をまとめて同じ状態にする */
  onCheck: (index: number, range: boolean) => void;
  /** 表示中のファイルをすべてチェックする（false なら外す） */
  onCheckShown: (check: boolean) => void;
  onPlay: (file: AudioFile) => void;
  /** 行にハッシュ値の先頭を出す（重複を見るとき） */
  showHash: boolean;
  /** 行を左の欄のプレイリストへドラッグしたとき。チェックした行をつかんだら、チェックしたファイルすべて */
  onDropToPlaylist: (fileIds: number[], playlistId: number) => void;
};

export function FileList({
  files,
  focusedId,
  checked,
  playingId,
  onFocus,
  onCheck,
  onCheckShown,
  onPlay,
  showHash,
  onDropToPlaylist,
}: Props) {
  const beginDrag = useFileDrag(onDropToPlaylist);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const shownChecked = files.reduce((n, f) => n + (checked.has(f.id) ? 1 : 0), 0);
  const allChecked = files.length > 0 && shownChecked === files.length;

  return (
    <>
      <div className="list-head">
        <span className="sub">ファイル</span>
        <label className="check-cell" title="表示中のファイルをすべてチェック">
          <input
            type="checkbox"
            checked={allChecked}
            ref={(el) => {
              if (el) el.indeterminate = shownChecked > 0 && !allChecked;
            }}
            disabled={files.length === 0}
            onChange={() => onCheckShown(!allChecked)}
            aria-label="表示中のファイルをすべてチェック"
          />
        </label>
      </div>
      {files.length === 0 ? (
        <div className="empty">該当するファイルはありません</div>
      ) : (
        <div
          className="list"
          ref={parentRef}
          tabIndex={0}
          data-testid="file-list"
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "a") {
              e.preventDefault();
              onCheckShown(true);
            }
          }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const f = files[item.index];
              const classes = ["file-row"];
              if (focusedId === f.id) classes.push("selected");
              if (checked.has(f.id)) classes.push("checked");
              if (f.missing) classes.push("missing");
              return (
                <div
                  key={f.id}
                  className={classes.join(" ")}
                  style={{ top: item.start, height: ROW_HEIGHT }}
                  data-testid="file-row"
                  data-rel-path={f.relPath}
                  onClick={() => onFocus(f)}
                  onPointerDown={(e) => beginDrag(e, checked.has(f.id) ? [...checked] : [f.id])}
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
                      ⚠
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
                      <span className="chip" key={t.id}>
                        {t.name}
                      </span>
                    ))}
                  </span>
                  <label className="check-cell" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={checked.has(f.id)}
                      onChange={() => {}}
                      onClick={(e) => onCheck(item.index, e.shiftKey)}
                      aria-label={`${f.relPath}をチェック`}
                      data-testid="file-check"
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
