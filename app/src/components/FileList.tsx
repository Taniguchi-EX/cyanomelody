import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AudioFile } from "../api";
import { originText } from "../playlistItem";
import { displayFileName } from "../paths";
import { useDisplay } from "../displaySettings";
import { useCover } from "../covers";
import { useFileDrag, type FileDropTarget } from "../hooks/useFileDrag";
import { RowTags } from "./RowTags";

/** 一覧の行の高さ（文字の大きさが標準のとき。大きくすると合わせて高くする） */
const ROW_HEIGHT = 30;
/** グリッドのカードの幅の下限（欄が狭くて、設定した数が入らないときは、横に並べる数を減らす） */
const TILE_MIN_WIDTH = 130;

/** グリッドの並べ方：欄の幅と、設定した横の数から、カードの幅・高さ・間を決める（欄の端に大きな余白が残らないように） */
function gridLayout(width: number, wanted: number, textScale: number) {
  const gap = Math.round(Math.min(16, Math.max(6, width * 0.012)));
  const columns = Math.max(1, Math.min(wanted, Math.floor((width - gap) / (TILE_MIN_WIDTH + gap))));
  const tileWidth = Math.max(1, Math.floor((width - gap * (columns + 1)) / columns));
  // 上の曲名（2行）・真ん中のジャケット・下の再生ボタンの段
  const tileHeight = Math.round(tileWidth * 0.6 + 64 * textScale);
  return { gap, columns, tileWidth, tileHeight };
}

/** カードのジャケット（ファイルの中の画像）。ないときはタグを出す */
function TileMedia({ file, tagStyles }: { file: AudioFile; tagStyles: Map<number, CSSProperties> }) {
  const cover = useCover(file.id, !file.missing);
  return cover ? (
    <div className="tile-cover" data-testid="tile-cover">
      <img src={cover} alt="" draggable={false} />
    </div>
  ) : (
    <div className="tile-tags">
      <RowTags tags={file.tags} tagStyles={tagStyles} />
    </div>
  );
}

/** 中央の一覧の見せ方：行の並び（一覧）か、格子（グリッド） */
export type ListView = "list" | "grid";

/** ハッシュ値から決まる色（同じ音声のファイルは同じ色になる） */
const hashColor = (hash: string) => `hsl(${parseInt(hash.slice(0, 6), 16) % 360} 65% 50%)`;

type Props = {
  files: AudioFile[];
  /** クリックして右の欄に出している行（AudioFile.key） */
  focusedKey: number | null;
  /** チェックしたファイル（表示していないものも含む） */
  checked: Set<number>;
  /** 鳴らしている行（AudioFile.key） */
  playingKey: number | null;
  /** 鳴らしている行の進み具合（0〜1） */
  progress: number;
  onFocus: (file: AudioFile) => void;
  /** 行のチェックボックス。range が true なら前に押した行との間をまとめて同じ状態にする */
  onCheck: (index: number, range: boolean) => void;
  /** 表示中のファイルをすべてチェックする（false なら外す）。Ctrl+A で使う */
  onCheckShown: (check: boolean) => void;
  onPlay: (file: AudioFile) => void;
  /** 行のダブルクリック：そのファイルから再生する（鳴らしている行なら最初から鳴らし直す） */
  onPlayFrom: (file: AudioFile) => void;
  /** 行にハッシュ値の色の印を出す（重複を見るとき） */
  showHash: boolean;
  /** 行を左の欄のプレイリストへドラッグしたとき。チェックした行をつかんだら、チェックしたファイルすべて */
  /** 行を左の欄のプレイリスト・タグに落としたとき */
  onDrop: (fileIds: number[], target: FileDropTarget) => void;
  /** タグのidから、チップの色を引く表（色のないタグは入らない） */
  tagStyles: Map<number, CSSProperties>;
  /** この行（AudioFile.key）までスクロールする（seq が変わるたびに）。スクロールしたら onRevealed を呼ぶ */
  reveal: { key: number; seq: number } | null;
  onRevealed: () => void;
  /** 行の来た項目のアイコンを押したとき（プレイリストを選んでいるときだけ出す） */
  onOpenOrigin: (file: AudioFile) => void;
  /** 見せ方（一覧・グリッド）。操作はどちらも同じ */
  view: ListView;
};

export function FileList({
  files,
  focusedKey,
  checked,
  playingKey,
  progress,
  onFocus,
  onCheck,
  onCheckShown,
  onPlay,
  onPlayFrom,
  showHash,
  onDrop,
  tagStyles,
  reveal,
  onRevealed,
  onOpenOrigin,
  view,
}: Props) {
  const beginDrag = useFileDrag(onDrop);
  const parentRef = useRef<HTMLDivElement>(null);
  const grid = view === "grid";
  const display = useDisplay();
  // 欄の幅（グリッドの並べ方を決める）
  const [width, setWidth] = useState(0);
  // 一覧の欄は、0件のときは出さないので、出したときに測り直す
  const empty = files.length === 0;
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [empty]);
  const layout = gridLayout(width, display.gridColumns, display.textScale);
  const rowHeight = Math.round(ROW_HEIGHT * Math.max(1, display.textScale));
  const perRow = grid ? layout.columns : 1;
  const bandHeight = grid ? layout.tileHeight + layout.gap : rowHeight;
  // 仮想化は段（グリッドではカードを横に並べた1段、一覧では1行）を単位にする
  const virtualizer = useVirtualizer({
    count: Math.ceil(files.length / perRow),
    getScrollElement: () => parentRef.current,
    estimateSize: () => bandHeight,
    overscan: grid ? 4 : 20,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [bandHeight, virtualizer]);
  /** index 番目のファイルが見える所までスクロールする */
  const scrollTo = (index: number, align: "auto" | "center" = "auto") => virtualizer.scrollToIndex(Math.floor(index / perRow), { align });

  useEffect(() => {
    if (!reveal) return;
    const index = files.findIndex((f) => f.key === reveal.key);
    if (index >= 0) virtualizer.scrollToIndex(Math.floor(index / perRow), { align: "center" });
    onRevealed();
  }, [reveal, files, virtualizer, onRevealed, perRow]);

  /** 右の欄に出すファイルを delta だけ移す。試聴中なら、移った先を続けて試聴する（聞き比べ） */
  const moveFocus = (delta: number) => {
    const cur = files.findIndex((f) => f.key === focusedKey);
    const next = cur < 0 ? 0 : Math.min(Math.max(cur + delta, 0), files.length - 1);
    const f = files[next];
    onFocus(f);
    scrollTo(next);
    if (playingKey !== null && playingKey !== f.key && !f.missing) onPlay(f);
  };

  return (
    <>
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
            // ↑↓：右の欄に出すファイルを移す（グリッドでは1段上・下）。←→：グリッドで前・後ろ
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              moveFocus((e.key === "ArrowDown" ? 1 : -1) * perRow);
            }
            if (grid && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
              e.preventDefault();
              moveFocus(e.key === "ArrowRight" ? 1 : -1);
            }
            // スペース：右の欄に出しているファイルの試聴を始める・止める（ボタンなどの上では、そちらの操作にする）
            if (e.key === " " && !(e.target as HTMLElement).closest("button, input")) {
              e.preventDefault();
              const f = files.find((x) => x.key === focusedKey);
              if (f && !f.missing) onPlay(f);
            }
          }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().flatMap((band) =>
              Array.from({ length: perRow }, (_, c) => band.index * perRow + c)
                .filter((index) => index < files.length)
                .map((index) => ({ index, start: band.start, column: index % perRow })),
            ).map((item) => {
              const f = files[item.index];
              const classes = ["file-row"];
              if (grid) classes.push("file-tile");
              const playing = playingKey === f.key;
              // 来た項目の説明（アイコンの title と読み上げの名前に使う）。1行に1回だけ作る
              const origin = f.origin ? originText(f) : "";
              if (focusedKey === f.key) classes.push("selected");
              if (checked.has(f.id)) classes.push("checked");
              if (f.missing) classes.push("missing");
              const name = f.alias ?? displayFileName(f.relPath, display.hideExtension);
              const playButton = (
                <button
                  className={playing ? "play playing" : "play"}
                  disabled={f.missing}
                  title={playing ? "停止" : "再生"}
                  aria-label={playing ? "停止" : "再生"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlay(f);
                  }}
                >
                  {playing ? "■" : "▶"}
                </button>
              );
              // プレイリストを選んでいるとき：タグの組み合わせ・プレイリストの項目から来た曲に、その項目のアイコン。押すと編集画面のその行
              const originButton = f.origin && (
                <button
                  className="icon row-origin"
                  title={origin}
                  aria-label={origin}
                  data-testid="row-origin"
                  data-origin-kind={f.origin.kind}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenOrigin(f);
                  }}
                >
                  {f.origin.kind === "tags" ? "🏷" : "📃"}
                </button>
              );
              const marks = (
                <>
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
                </>
              );
              // ファイル名だけ（プレイリスト上での名前があればそれ）を出す。マウスを乗せると相対パス（サブフォルダの同じ名前を見分ける）
              const nameLabel = (
                <span className="file-name" title={f.relPath} data-testid="file-name">
                  {name}
                </span>
              );
              const progressBar = playing && (
                <div className="row-progress" data-testid="row-progress" style={{ width: `${progress * 100}%` }} />
              );
              const checkCell = (
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
              );
              return (
                <div
                  key={f.key}
                  className={classes.join(" ")}
                  style={
                    grid
                      ? {
                          top: item.start + layout.gap,
                          left: layout.gap + item.column * (layout.tileWidth + layout.gap),
                          width: layout.tileWidth,
                          height: layout.tileHeight,
                        }
                      : { top: item.start, height: rowHeight }
                  }
                  data-testid="file-row"
                  data-rel-path={f.relPath}
                  onClick={() => onFocus(f)}
                  // ボタン・チェックボックスの上のダブルクリックは、そちらの操作だけにする
                  onDoubleClick={(e) => {
                    if (!f.missing && !(e.target as HTMLElement).closest("button, input, label")) onPlayFrom(f);
                  }}
                  onPointerDown={(e) => beginDrag(e, checked.has(f.id) ? [...checked] : [f.id])}
                >
                  {grid ? (
                    // カード：上に曲名、真ん中にジャケット（なければタグ）、左下に再生ボタン・来た項目・印、右下にチェック
                    <>
                      {nameLabel}
                      <TileMedia file={f} tagStyles={tagStyles} />
                      <div className="tile-foot">
                        {playButton}
                        {originButton}
                        {marks}
                        {checkCell}
                      </div>
                      {progressBar}
                    </>
                  ) : (
                    <>
                      {playButton}
                      {originButton}
                      {marks}
                      {nameLabel}
                      <RowTags tags={f.tags} tagStyles={tagStyles} />
                      {progressBar}
                      {checkCell}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
