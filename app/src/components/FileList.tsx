import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AudioFile } from "../api";
import { useFileDrag, type FileDropTarget } from "../hooks/useFileDrag";

const ROW_HEIGHT = 30;

/** ハッシュ値から決まる色（同じ音声のファイルは同じ色になる） */
const hashColor = (hash: string) => `hsl(${parseInt(hash.slice(0, 6), 16) % 360} 65% 50%)`;

type Props = {
  files: AudioFile[];
  /** クリックして右の欄に出しているファイル */
  focusedId: number | null;
  /** チェックしたファイル（表示していないものも含む） */
  checked: Set<number>;
  playingId: number | null;
  /** 試聴中のファイルの進み具合（0〜1） */
  progress: number;
  onFocus: (file: AudioFile) => void;
  /** 行のチェックボックス。range が true なら前に押した行との間をまとめて同じ状態にする */
  onCheck: (index: number, range: boolean) => void;
  /** 表示中のファイルをすべてチェックする（false なら外す） */
  onCheckShown: (check: boolean) => void;
  onPlay: (file: AudioFile) => void;
  /** 行にハッシュ値の色の印を出す（重複を見るとき） */
  showHash: boolean;
  /** 行を左の欄のプレイリストへドラッグしたとき。チェックした行をつかんだら、チェックしたファイルすべて */
  /** 行を左の欄のプレイリスト・タグに落としたとき */
  onDrop: (fileIds: number[], target: FileDropTarget) => void;
};

export function FileList({
  files,
  focusedId,
  checked,
  playingId,
  progress,
  onFocus,
  onCheck,
  onCheckShown,
  onPlay,
  showHash,
  onDrop,
}: Props) {
  const beginDrag = useFileDrag(onDrop);
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
            // ↑↓：右の欄に出すファイルを移す。試聴中なら、移った先を続けて試聴する（聞き比べ）
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const cur = files.findIndex((f) => f.id === focusedId);
              const next =
                cur < 0 ? 0 : Math.min(Math.max(cur + (e.key === "ArrowDown" ? 1 : -1), 0), files.length - 1);
              const f = files[next];
              onFocus(f);
              virtualizer.scrollToIndex(next);
              if (playingId !== null && playingId !== f.id && !f.missing) onPlay(f);
            }
            // スペース：右の欄に出しているファイルの試聴を始める・止める（ボタンなどの上では、そちらの操作にする）
            if (e.key === " " && !(e.target as HTMLElement).closest("button, input")) {
              e.preventDefault();
              const f = files.find((x) => x.id === focusedId);
              if (f && !f.missing) onPlay(f);
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
                    <span
                      className="hash"
                      style={f.hash ? { background: hashColor(f.hash) } : undefined}
                      title={f.hash ?? "ハッシュ値なし"}
                      data-hash={f.hash ?? ""}
                    />
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
                  {playingId === f.id && (
                    <div className="row-progress" data-testid="row-progress" style={{ width: `${progress * 100}%` }} />
                  )}
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
