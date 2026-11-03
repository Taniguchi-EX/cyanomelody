import { useRef, useState } from "react";
import { PLAY_MODES, type PlayMode, type PlaylistDetail, type PlaylistItem, type PlaylistNode, type Tag } from "../api";
import { makesLoop } from "../playlistGraph";
import type { EffectChain } from "../effects";
import { useStoredString } from "../storage";
import { NameInput } from "./TreeParts";
import { itemContent } from "../playlistItem";

type Props = {
  detail: PlaylistDetail;
  playlists: PlaylistNode[];
  tags: Tag[];
  /** いまの左の欄のタグの絞り込みの条件 */
  filterTagIds: number[];
  busy: boolean;
  onClose: () => void;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  /** 項目1つだけを再生する */
  onPlayItem: (item: PlaylistItem) => void;
  onRemoveItem: (item: PlaylistItem) => void;
  onMoveItem: (item: PlaylistItem, index: number) => void;
  onSetMode: (item: PlaylistItem, mode: PlayMode) => void;
  /** 右の欄に出している項目 */
  focusedItemId: number | null;
  /** 項目の行を押したとき（右の欄にその項目を出す） */
  onFocusItem: (item: PlaylistItem) => void;
  chains: EffectChain[];
  onSetChain: (item: PlaylistItem, chainId: number | null) => void;
  onAddTags: (tagIds: number[]) => Promise<boolean>;
  onAddRef: (refId: number) => void;
  onCreateChild: (name: string) => Promise<boolean>;
  /** dest の中に書き出し始める。始められたら true */
  onExport: (dest: string) => Promise<boolean>;
  /** フォルダを選ぶダイアログを出し、選んだパスを返す */
  onBrowseFolder: () => Promise<string | null>;
};

const DRAG_THRESHOLD = 4;

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
  onRename,
  onDelete,
  onPlayItem,
  onRemoveItem,
  onMoveItem,
  onSetMode,
  focusedItemId,
  onFocusItem,
  chains,
  onSetChain,
  onAddTags,
  onAddRef,
  onCreateChild,
  onExport,
  onBrowseFolder,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [pickedTags, setPickedTags] = useState<Tag[]>([]);
  const [refId, setRefId] = useState("");
  const [childName, setChildName] = useState("");
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

  const createChild = async () => {
    if (await onCreateChild(childName)) setChildName("");
  };

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

  const pickTag = () => {
    const tag = tags.find((t) => t.name.toLowerCase() === tagInput.trim().toLowerCase());
    if (tag && !pickedTags.some((p) => p.id === tag.id)) setPickedTags([...pickedTags, tag]);
    if (tag) setTagInput("");
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
        {renaming ? (
          <NameInput
            label="プレイリストの名前"
            initial={detail.name}
            onCommit={async (name) => {
              if (name.trim() === detail.name || (await onRename(name))) setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <h2 className="editor-title" data-testid="playlist-title" title={detail.name}>
            {detail.name}
          </h2>
        )}
        <button
          className="icon"
          onClick={() => setRenaming(true)}
          disabled={busy || renaming}
          title="名前を変える"
          aria-label="プレイリストの名前を変える"
        >
          ✎
        </button>
      </div>

      <div className="editor-body">
        <div className="playlist-items">
          {detail.items.length === 0 && <div className="empty">項目はまだありません</div>}
          {detail.items.map((item, index) => (
            <div
              key={item.id}
              className={
                "playlist-item" +
                (focusedItemId === item.id ? " selected" : "") +
                (dragIndex === index ? " drag-source" : "") +
                (dropAt?.index === index ? ` drop-${dropAt.pos}` : "") +
                (item.file?.missing ? " missing" : "")
              }
              data-testid="playlist-item"
              data-item-index={index}
              data-item-kind={item.kind}
              // 行の中のボタン・プルダウン・取っ手を押したときは、その操作だけにする
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest("button, select, input, .drag-handle")) onFocusItem(item);
              }}
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
              <select
                className="item-chain"
                value={item.effectChain?.id ?? ""}
                onChange={(e) => onSetChain(item, e.target.value === "" ? null : Number(e.target.value))}
                disabled={busy}
                aria-label={`${itemContent(item)}のエフェクト`}
                title="この項目にかけるエフェクトのまとまり"
              >
                <option value="">fx なし</option>
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
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
            </div>
          ))}
        </div>

        <div className="playlist-add">
          <h2>タグの組み合わせを加える</h2>
          <div className="row">
            <input
              type="text"
              list="playlist-tag-names"
              placeholder="タグ名を入れて「選ぶ」"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && pickTag()}
              aria-label="組み合わせに選ぶタグ"
            />
            <datalist id="playlist-tag-names">
              {tags.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
            <button
              className="icon"
              onClick={pickTag}
              disabled={!tagInput.trim()}
              title="組み合わせに入れる"
              aria-label="選ぶ"
            >
              ＋
            </button>
          </div>
          <div className="row picked-tags" data-testid="picked-tags">
            {pickedTags.map((t) => (
              <span className="chip" key={t.id}>
                {t.name}
                <button
                  className="chip-remove"
                  onClick={() => setPickedTags(pickedTags.filter((p) => p.id !== t.id))}
                  aria-label={`${t.name}を選ぶのをやめる`}
                >
                  ×
                </button>
              </span>
            ))}
            <button
              onClick={async () => {
                if (await onAddTags(pickedTags.map((t) => t.id))) setPickedTags([]);
              }}
              disabled={busy || pickedTags.length === 0}
            >
              この組み合わせを加える
            </button>
          </div>
          <div className="row">
            <button onClick={() => onAddTags(filterTagIds)} disabled={busy || filterTagIds.length === 0}>
              いまの絞り込みのタグを加える
            </button>
            {filterTags.length > 0 && <span className="sub">{filterTags.map((t) => t.name).join(" ＋ ")}</span>}
          </div>

          <h2>プレイリストを加える</h2>
          <div className="row">
            <select value={refId} onChange={(e) => setRefId(e.target.value)} aria-label="加えるプレイリスト">
              <option value="">（選んでください）</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id} disabled={loops.has(p.id)}>
                  {"　".repeat(p.depth)}
                  {p.name}
                  {loops.has(p.id) ? "（ループになるため選べません）" : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                onAddRef(Number(refId));
                setRefId("");
              }}
              disabled={busy || refId === ""}
            >
              加える
            </button>
          </div>

          <h2>子のプレイリストを作る</h2>
          <div className="row">
            <input
              type="text"
              placeholder="子のプレイリストの名前"
              value={childName}
              onChange={(e) => setChildName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && childName.trim() && createChild()}
              aria-label="子のプレイリストの名前"
            />
            <button onClick={createChild} disabled={busy || !childName.trim()}>
              作る
            </button>
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
          書き出す
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="icon"
          onClick={onDelete}
          disabled={busy}
          title="このプレイリストを削除"
          aria-label="このプレイリストを削除"
        >
          🗑
        </button>
      </div>
    </div>
  );
}
