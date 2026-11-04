import { useRef, useState } from "react";
import { PLAY_MODES, type PlayMode, type PlaylistDetail, type PlaylistItem, type PlaylistNode, type Tag } from "../api";
import { makesLoop } from "../playlistGraph";
import type { EffectChain } from "../effects";
import { useStoredString } from "../storage";
import { itemContent } from "../playlistItem";
import { useFileDrag, type FileDropTarget } from "../hooks/useFileDrag";

type Props = {
  detail: PlaylistDetail;
  playlists: PlaylistNode[];
  tags: Tag[];
  /** いまの左の欄のタグの絞り込みの条件 */
  filterTagIds: number[];
  busy: boolean;
  onClose: () => void;
  /** 項目1つだけを再生する */
  onPlayItem: (item: PlaylistItem) => void;
  onRemoveItem: (item: PlaylistItem) => void;
  onMoveItem: (item: PlaylistItem, index: number) => void;
  onSetMode: (item: PlaylistItem, mode: PlayMode) => void;
  /** 右の欄に出している項目 */
  focusedItemId: number | null;
  /** 再生中の曲を出している項目（このプレイリストを再生しているときだけ） */
  playingItemId: number | null;
  /** 項目の行を押したとき（右の欄にその項目を出す） */
  onFocusItem: (item: PlaylistItem) => void;
  chains: EffectChain[];
  /** 項目にエフェクトセットを付ける（null なら外す）。チェックした項目の fx を変えたときは、チェックした項目すべて */
  onSetChain: (items: PlaylistItem[], chainId: number | null) => void;
  /** エフェクトセットの管理画面を開く。試聴はその項目の曲で。chainId を選んで開き、作ったら itemIds の項目に付ける */
  onOpenEffects: (item: PlaylistItem, chainId: number | null, itemIds: number[]) => void;
  /** チェックした項目をまとめて外す（確認する）。外したら true */
  onRemoveItems: (items: PlaylistItem[]) => Promise<boolean>;
  /** 項目を左の欄のタグ・プレイリスト・出典・ライセンスに落としたとき（中の曲すべてが対象） */
  onDropItems: (itemIds: number[], target: FileDropTarget) => void;
  onAddTags: (tagIds: number[]) => Promise<boolean>;
  onAddRef: (refId: number) => void;
  /** dest の中に書き出し始める。始められたら true */
  onExport: (dest: string) => Promise<boolean>;
  /** フォルダを選ぶダイアログを出し、選んだパスを返す */
  onBrowseFolder: () => Promise<string | null>;
};

const DRAG_THRESHOLD = 4;
/** fx のプルダウンの、管理画面を開く選び肢 */
const NEW_FX = "new-fx";
const EDIT_FX = "edit-fx";

function kindLabel(item: PlaylistItem): string {
  if (item.kind === "file") return "ファイル";
  if (item.kind === "tags") return "タグ";
  return item.owned ? "子のプレイリスト" : "プレイリスト";
}

/** 種類を表す記号（名前は title で出す） */
function kindIcon(item: PlaylistItem): string {
  if (item.kind === "file") return "♪";
  if (item.kind === "tags") return "🏷";
  return item.owned ? "📁" : "↪";
}


/** 中央のプレイリストの編集画面 */
export function PlaylistEditor({
  detail,
  playlists,
  tags,
  filterTagIds,
  busy,
  onClose,
  onPlayItem,
  onRemoveItem,
  onMoveItem,
  onSetMode,
  focusedItemId,
  playingItemId,
  onFocusItem,
  chains,
  onSetChain,
  onOpenEffects,
  onRemoveItems,
  onDropItems,
  onAddTags,
  onAddRef,
  onExport,
  onBrowseFolder,
}: Props) {
  /** チェックした項目（ファイルの一覧と同じく、まとめて操作する対象）。開いているプレイリストの中だけ */
  const [checked, setChecked] = useState<Set<number>>(new Set());
  // 外した項目は、チェックからも外す
  const checkedItems = detail.items.filter((i) => checked.has(i.id));
  const toggleCheck = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** 操作の対象：チェックした項目を操作したならチェックした項目すべて、そうでなければその項目だけ */
  const targetsOf = (item: PlaylistItem) => (checked.has(item.id) ? checkedItems : [item]);
  // 項目の行をつかんで、左の欄に落とす（チェックした行ならチェックした項目すべて）
  const beginItemDrag = useFileDrag(onDropItems);

  /** fx のプルダウン：エフェクトセットを付ける・外す、または管理画面を開く */
  const changeChain = (item: PlaylistItem, value: string) => {
    const targets = targetsOf(item);
    if (value === NEW_FX) onOpenEffects(item, null, targets.map((t) => t.id));
    else if (value === EDIT_FX) onOpenEffects(item, item.effectChain?.id ?? null, []);
    else onSetChain(targets, value === "" ? null : Number(value));
  };
  const [exporting, setExporting] = useState(false);
  // 前に書き出したフォルダを入れておく（調整して何度も書き出すとき、選び直さなくてよい）
  const [lastDest, setLastDest] = useStoredString("cyanomelody.exportDest");
  const [exportDest, setExportDest] = useState(lastDest);

  const startExport = async () => {
    if (await onExport(exportDest)) {
      setLastDest(exportDest.trim());
      setExporting(false);
    }
  };
  // 項目の並べ替え（取っ手のドラッグ。前・後ろだけ）
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{
    index: number;
    pos: "before" | "after";
  } | null>(null);
  const start = useRef<{
    index: number;
    x: number;
    y: number;
    moving: boolean;
  } | null>(null);

  // ループになるプレイリスト（自分自身と、自分を含むもの）は、候補に出すが選べないようにする
  const loops = new Set(playlists.filter((p) => makesLoop(playlists, detail.id, p.id)).map((p) => p.id));
  const filterTags = tags.filter((t) => filterTagIds.includes(t.id));

  const targetAt = (x: number, y: number) => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-item-index]");
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return {
      index: Number(row.dataset.itemIndex),
      pos: y - rect.top < rect.height / 2 ? "before" : "after",
    } as const;
  };

  const finishDrag = (e: React.PointerEvent, commit: boolean) => {
    const s = start.current;
    start.current = null;
    setDragIndex(null);
    setDropAt(null);
    if (!s?.moving || !commit) return;
    const t = targetAt(e.clientX, e.clientY);
    if (!t) return;
    // 移す項目を抜いた後の並びでの位置
    let dest = t.pos === "before" ? t.index : t.index + 1;
    if (s.index < dest) dest -= 1;
    if (dest !== s.index) onMoveItem(detail.items[s.index], dest);
  };

  return (
    <div className="playlist-editor" data-testid="playlist-editor">
      <div className="toolbar editor-head">
        <button
          className="back-button"
          onClick={onClose}
          title="ファイルの一覧に戻る"
          aria-label="ファイルの一覧に戻る"
        >
          ＜
        </button>
        <h2 className="editor-title" data-testid="playlist-title" title={detail.name}>
          {detail.name}
        </h2>
      </div>

      <div className="editor-body">
        {/* チェックしているときだけ、チェックの操作を出す */}
        {checkedItems.length > 0 && (
          <div className="toolbar item-checks" data-testid="item-checks">
            <span className="checked-count">チェック {checkedItems.length}件</span>
            <button
              onClick={() => setChecked(new Set(detail.items.map((i) => i.id)))}
              disabled={checkedItems.length === detail.items.length}
            >
              全てチェック
            </button>
            <button onClick={() => setChecked(new Set())}>チェックをすべて外す</button>
            <button
              onClick={async () => {
                if (await onRemoveItems(checkedItems)) setChecked(new Set());
              }}
              disabled={busy}
            >
              まとめて外す
            </button>
          </div>
        )}
        <div className="playlist-items">
          {detail.items.length === 0 && <div className="empty">項目はまだありません</div>}
          {detail.items.map((item, index) => (
            <div
              key={item.id}
              className={
                "playlist-item" +
                (focusedItemId === item.id ? " selected" : "") +
                (checked.has(item.id) ? " checked" : "") +
                (playingItemId === item.id ? " playing" : "") +
                (dragIndex === index ? " drag-source" : "") +
                (dropAt?.index === index ? ` drop-${dropAt.pos}` : "") +
                (item.file?.missing ? " missing" : "")
              }
              data-testid="playlist-item"
              data-item-index={index}
              data-item-kind={item.kind}
              // 行の中のボタン・プルダウン・チェックボックス・取っ手を押したときは、その操作だけにする
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest("button, select, input, label, .drag-handle")) onFocusItem(item);
              }}
              onPointerDown={(e) => beginItemDrag(e, targetsOf(item).map((t) => t.id))}
            >
              <button
                className="item-kind"
                title={kindLabel(item)}
                aria-label={`${itemContent(item)}を再生`}
                disabled={item.kind === "file" ? !item.file || item.file.missing : item.fileCount === 0}
                onClick={() => onPlayItem(item)}
              >
                <span className="kind-icon">{kindIcon(item)}</span>
                <span className="kind-play">▶</span>
              </button>
              {/* プレイリスト上での名前があればそれだけを出す。元の名前はマウスを乗せると出る */}
              <span className="item-content" title={itemContent(item)} data-testid="item-content">
                {item.alias ?? itemContent(item)}
                {item.file?.missing && (
                  <span className="warn" title="ファイルが見つかりません">
                    {" "}
                    ⚠
                  </span>
                )}
              </span>
              {item.kind !== "file" && (
                <>
                  <select
                    value={item.mode}
                    onChange={(e) => onSetMode(item, e.target.value as PlayMode)}
                    disabled={busy}
                    aria-label={`${itemContent(item)}の再生方法`}
                  >
                    {PLAY_MODES.map((m) => (
                      <option key={m.mode} value={m.mode}>
                        {m.icon} {m.short}
                      </option>
                    ))}
                  </select>
                  <span className="sub item-count" title="再生したときのファイル数">
                    {item.fileCount}件
                  </span>
                </>
              )}
              {/* エフェクトセットが付いている行は色を付ける。最後の選び肢で管理画面を開く */}
              <select
                className="item-chain"
                value={item.effectChain?.id ?? ""}
                onChange={(e) => changeChain(item, e.target.value)}
                disabled={busy}
                aria-label={`${itemContent(item)}のエフェクト`}
                title="この項目にかけるエフェクトセット"
              >
                <option value="">fx なし</option>
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value={NEW_FX}>新しいfxを作る</option>
                {item.effectChain && <option value={EDIT_FX}>このfxを編集</option>}
              </select>
              <button
                className="icon"
                onClick={() => onRemoveItem(item)}
                disabled={busy}
                title="外す"
                aria-label={`${itemContent(item)}を外す`}
              >
                ✕
              </button>
              <span
                className="drag-handle"
                title="ドラッグして並べ替え"
                data-testid="item-handle"
                onPointerDown={(e) => {
                  if (busy || e.button !== 0) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  start.current = {
                    index,
                    x: e.clientX,
                    y: e.clientY,
                    moving: false,
                  };
                }}
                onPointerMove={(e) => {
                  const s = start.current;
                  if (!s) return;
                  if (!s.moving) {
                    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_THRESHOLD) return;
                    s.moving = true;
                    setDragIndex(s.index);
                  }
                  setDropAt(targetAt(e.clientX, e.clientY));
                }}
                onPointerUp={(e) => finishDrag(e, true)}
                onPointerCancel={(e) => finishDrag(e, false)}
              >
                ≡
              </span>
              <label className="check-cell" title="チェックすると、まとめて操作できる">
                <input
                  type="checkbox"
                  checked={checked.has(item.id)}
                  onChange={() => toggleCheck(item.id)}
                  aria-label={`${itemContent(item)}をチェック`}
                  data-testid="item-check"
                />
              </label>
            </div>
          ))}
        </div>

        {/* 項目を加える：左の欄で選んでいるタグの組み合わせと、プレイリスト（選んだらすぐ加える） */}
        <div className="playlist-add">
          <div className="row">
            <button onClick={() => onAddTags(filterTagIds)} disabled={busy || filterTagIds.length === 0}>
              選択タグをリストに追加
            </button>
            {filterTags.length > 0 && <span className="sub">{filterTags.map((t) => t.name).join(" ＋ ")}</span>}
          </div>
          <div className="row">
            <select
              value=""
              onChange={(e) => e.target.value !== "" && onAddRef(Number(e.target.value))}
              disabled={busy}
              aria-label="加えるプレイリスト"
            >
              <option value="">プレイリストを追加</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id} disabled={loops.has(p.id)}>
                  {"　".repeat(p.depth)}
                  {p.name}
                  {loops.has(p.id) ? "（ループになるため選べません）" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {exporting && (
        <div className="toolbar export-row">
          <input
            type="text"
            placeholder="書き出し先のフォルダ"
            value={exportDest}
            onChange={(e) => setExportDest(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && exportDest.trim() && startExport()}
            aria-label="書き出し先のフォルダ"
          />
          <button
            onClick={async () => {
              const dir = await onBrowseFolder();
              if (dir) setExportDest(dir);
            }}
          >
            参照
          </button>
          <button onClick={startExport} disabled={busy || !exportDest.trim()}>
            書き出しを始める
          </button>
        </div>
      )}
      <div className="toolbar editor-foot">
        <button onClick={() => setExporting((x) => !x)} aria-pressed={exporting}>
          書出
        </button>
      </div>
    </div>
  );
}
