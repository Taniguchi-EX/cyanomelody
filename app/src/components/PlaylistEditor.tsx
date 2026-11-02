import { useRef, useState } from "react";
import {
  PLAY_MODES,
  type PlayMode,
  type PlaylistDetail,
  type PlaylistItem,
  type PlaylistNode,
  type Tag,
} from "../api";
import { makesLoop } from "../playlistGraph";
import type { EffectChain } from "../effects";

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
  onPlay: (mode: PlayMode) => void;
  onRemoveItem: (item: PlaylistItem) => void;
  onMoveItem: (item: PlaylistItem, index: number) => void;
  onSetMode: (item: PlaylistItem, mode: PlayMode) => void;
  /** 別名を変える（空なら外す）。終わったら true */
  onSetAlias: (item: PlaylistItem, alias: string) => Promise<boolean>;
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

function itemContent(item: PlaylistItem): string {
  if (item.kind === "file") return item.file?.relPath ?? "（ファイルなし）";
  if (item.kind === "tags") return item.tags.map((t) => t.name).join(" ＋ ");
  return item.playlist?.name ?? "（プレイリストなし）";
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
  onPlay,
  onRemoveItem,
  onMoveItem,
  onSetMode,
  onSetAlias,
  chains,
  onSetChain,
  onAddTags,
  onAddRef,
  onCreateChild,
  onExport,
  onBrowseFolder,
}: Props) {
  const [name, setName] = useState(detail.name);
  const [tagInput, setTagInput] = useState("");
  const [pickedTags, setPickedTags] = useState<Tag[]>([]);
  const [refId, setRefId] = useState("");
  const [childName, setChildName] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportDest, setExportDest] = useState("");

  const startExport = async () => {
    if (await onExport(exportDest)) setExporting(false);
  };
  // 別名を入力している項目
  const [aliasItemId, setAliasItemId] = useState<number | null>(null);
  const [aliasText, setAliasText] = useState("");

  const startAlias = (item: PlaylistItem) => {
    setAliasItemId(item.id);
    setAliasText(item.alias ?? "");
  };

  const commitAlias = async (item: PlaylistItem) => {
    if (await onSetAlias(item, aliasText)) setAliasItemId(null);
  };

  // 項目の並べ替え（取っ手のドラッグ。前・後ろだけ）
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ index: number; pos: "before" | "after" } | null>(null);
  const start = useRef<{ index: number; x: number; y: number; moving: boolean } | null>(null);

  // ループになるプレイリスト（自分自身と、自分を含むもの）は、候補に出すが選べないようにする
  const loops = new Set(playlists.filter((p) => makesLoop(playlists, detail.id, p.id)).map((p) => p.id));
  const filterTags = tags.filter((t) => filterTagIds.includes(t.id));
  const canRename = !busy && name.trim() !== "" && name.trim() !== detail.name;

  const createChild = async () => {
    if (await onCreateChild(childName)) setChildName("");
  };

  const targetAt = (x: number, y: number) => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-item-index]");
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { index: Number(row.dataset.itemIndex), pos: y - rect.top < rect.height / 2 ? "before" : "after" } as const;
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
      <div className="toolbar">
        <button onClick={onClose}>ファイルの一覧に戻る</button>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && canRename && onRename(name)}
          aria-label="プレイリストの名前"
        />
        <button onClick={() => onRename(name)} disabled={!canRename}>
          名前を変える
        </button>
        <span className="play-modes">
          {PLAY_MODES.map((m) => (
            <button key={m.mode} className="icon" onClick={() => onPlay(m.mode)} title={m.label} aria-label={m.label}>
              {m.icon}
            </button>
          ))}
        </span>
        <button onClick={() => setExporting((x) => !x)} aria-pressed={exporting}>
          書き出す
        </button>
        <button onClick={onDelete} disabled={busy}>
          このプレイリストを削除
        </button>
      </div>
      {exporting && (
        <div className="toolbar">
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

      <div className="playlist-items">
        {detail.items.length === 0 && <div className="empty">項目はまだありません</div>}
        {detail.items.map((item, index) => (
          <div
            key={item.id}
            className={
              "playlist-item" +
              (dragIndex === index ? " drag-source" : "") +
              (dropAt?.index === index ? ` drop-${dropAt.pos}` : "") +
              (item.file?.missing ? " missing" : "")
            }
            data-testid="playlist-item"
            data-item-index={index}
            data-item-kind={item.kind}
          >
            <span className="item-kind" title={kindLabel(item)}>
              {kindIcon(item)}
            </span>
            {aliasItemId === item.id ? (
              <input
                type="text"
                className="item-content"
                autoFocus
                placeholder={`別名（空にすると外す）：${itemContent(item)}`}
                value={aliasText}
                onChange={(e) => setAliasText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) commitAlias(item);
                  if (e.key === "Escape") setAliasItemId(null);
                }}
                onBlur={() => setAliasItemId(null)}
                aria-label={`${itemContent(item)}の別名`}
              />
            ) : (
              <span
                className="item-content editable"
                title={`${itemContent(item)}（押すと別名を付けられます）`}
                data-testid="item-content"
                role="button"
                tabIndex={0}
                aria-label={`${itemContent(item)}の別名を付ける`}
                onClick={() => !busy && startAlias(item)}
                onKeyDown={(e) => e.key === "Enter" && !busy && startAlias(item)}
              >
                {item.alias ? (
                  <>
                    <span className="item-alias">{item.alias}</span>
                    <span className="sub">（{itemContent(item)}）</span>
                  </>
                ) : (
                  itemContent(item)
                )}
                {item.file?.missing && (
                  <span className="warn" title="ファイルが見つかりません">
                    {" "}
                    ⚠
                  </span>
                )}
              </span>
            )}
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
                start.current = { index, x: e.clientX, y: e.clientY, moving: false };
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
          <button className="icon" onClick={pickTag} disabled={!tagInput.trim()} title="組み合わせに入れる" aria-label="選ぶ">
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
          <button
            onClick={createChild}
            disabled={busy || !childName.trim()}
          >
            作る
          </button>
        </div>
      </div>
    </div>
  );
}
