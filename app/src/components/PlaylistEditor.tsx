import { useEffect, useRef, useState } from "react";
import { PLAY_MODES, type PlayMode, type PlaylistDetail, type PlaylistItem, type PlaylistNode, type Tag } from "../api";
import { makesLoop } from "../playlistGraph";
import type { EffectChain } from "../effects";
import { useStoredString } from "../storage";
import { itemContent } from "../playlistItem";
import { useEscape } from "../hooks/useEscape";
import { useFileDrag, type LocalDrop } from "../hooks/useFileDrag";
import { TagInput } from "./TagInput";

type Props = {
  detail: PlaylistDetail;
  playlists: PlaylistNode[];
  tags: Tag[];
  busy: boolean;
  onClose: () => void;
  /** 名前を変える。変えられたら true */
  onRename: (name: string) => Promise<boolean>;
  /** プレイリストを選んだ状態にして、中央の一覧を頭から再生する */
  onPlay: () => void;
  /** 項目1つだけを再生する */
  onPlayItem: (item: PlaylistItem) => void;
  onRemoveItem: (item: PlaylistItem) => void;
  onMoveItem: (item: PlaylistItem, index: number) => void;
  /** 再生方法を変える。チェックした項目の再生方法を変えたときは、チェックした項目すべて（タグの組み合わせ・プレイリストの項目だけ） */
  onSetMode: (items: PlaylistItem[], mode: PlayMode) => void;
  /** 開いたときに選んでおく（押した行と同じ色にして、見える所までスクロールする）項目 */
  initialItemId: number | null;
  /** 開いたときに、選んでおく項目の fx の選び肢を開く */
  initialOpenChain: boolean;
  /** 再生中の曲を出している項目（このプレイリストを再生しているときだけ） */
  playingItemId: number | null;
  chains: EffectChain[];
  /** 項目にエフェクトセットを付ける（null なら外す）。チェックした項目の fx を変えたときは、チェックした項目すべて */
  onSetChain: (items: PlaylistItem[], chainId: number | null) => void;
  /** エフェクトセットの管理画面を開く。試聴はその項目の曲で。chainId を選んで開き、作ったら itemIds の項目に付ける */
  onOpenEffects: (item: PlaylistItem, chainId: number | null, itemIds: number[]) => void;
  /** チェックした項目をまとめて外す（確認する）。外したら true */
  onRemoveItems: (items: PlaylistItem[]) => Promise<boolean>;
  /** プレイリスト上での名前を付ける（空なら外す）。付けられたら true */
  onSetAlias: (item: PlaylistItem, alias: string) => Promise<boolean>;
  /** タグの組み合わせの項目を加える。加えられたら true */
  onAddTags: (tagIds: number[]) => Promise<boolean>;
  onAddRef: (refId: number) => void;
  /** dest の中に書き出し始める（中央の一覧に出ている曲を書き出す）。始められたら true */
  onExport: (dest: string) => Promise<boolean>;
  /** 書き出しの「メタデータ」：中央の一覧に出ている曲のメタデータを JSON に書き出す（保存先を選ぶ） */
  onExportMetadata: () => void;
  /** フォルダを選ぶダイアログを出し、選んだパスを返す（キャンセルなら null）。defaultPath は最初に開くフォルダ */
  onBrowseFolder: (defaultPath?: string) => Promise<string | null>;
  onError: (e: unknown) => void;
};

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

/** 項目の行の、プレイリスト上での名前の入力欄。Enter で決め（空なら外す）、Esc でやめる */
function AliasInput({ item, onCommit, onCancel }: { item: PlaylistItem; onCommit: (alias: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(item.alias ?? "");
  return (
    <input
      type="text"
      className="name-input alias-input"
      autoFocus
      value={value}
      placeholder={itemContent(item)}
      aria-label={`${itemContent(item)}のプレイリスト上での名前`}
      onChange={(e) => setValue(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") {
          // 入力をやめるだけにし、編集画面を閉じるEsc（useEscape）まで届かせない
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          onCancel();
        }
      }}
    />
  );
}

/** プレイリストの編集画面（メインの画面に重ねて出す）。項目の並び・再生方法・fx・別名、項目の追加、名前、書出 */
export function PlaylistEditor({
  detail,
  playlists,
  tags,
  busy,
  onClose,
  onRename,
  onPlay,
  onPlayItem,
  onRemoveItem,
  onMoveItem,
  onSetMode,
  initialItemId,
  initialOpenChain,
  playingItemId,
  chains,
  onSetChain,
  onOpenEffects,
  onRemoveItems,
  onSetAlias,
  onAddTags,
  onAddRef,
  onExport,
  onExportMetadata,
  onBrowseFolder,
  onError,
}: Props) {
  // 入力欄（名前・別名）を開いている間は、Esc は入力をやめるだけ（入力欄の側で止める）
  useEscape(onClose);
  /** チェックした項目（まとめて外す・fx・再生方法の対象）。開いているプレイリストの中だけ */
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const checkedItems = detail.items.filter((i) => checked.has(i.id));
  const toggleCheck = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** 押した項目（ファイルの一覧で選んだ行と同じ色にする） */
  const [focusedItemId, setFocusedItemId] = useState<number | null>(initialItemId);
  /** 別名を入れている項目 */
  const [aliasItemId, setAliasItemId] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(detail.name);

  // 開いたときに選んでおく項目の行まで、スクロールする
  const itemsRef = useRef<HTMLDivElement>(null);
  // initialOpenChain なら、その行の fx の選び肢を開く（開けないときは選び肢に入っておく）
  useEffect(() => {
    if (initialItemId === null) return;
    const row = itemsRef.current?.querySelector(`[data-item-id="${initialItemId}"]`);
    row?.scrollIntoView({ block: "center" });
    if (!initialOpenChain) return;
    const select = row?.querySelector<HTMLSelectElement>("select.item-chain");
    if (!select) return;
    select.focus();
    try {
      select.showPicker();
    } catch {
      // 押してから時間が経った・開けない状態なら、選び肢に入るだけにする
    }
  }, [initialItemId, initialOpenChain]);

  /** 操作の対象：チェックした項目を操作したならチェックした項目すべて、そうでなければその項目だけ */
  const targetsOf = (item: PlaylistItem) => (checked.has(item.id) ? checkedItems : [item]);
  // 行のドラッグは並べ替えだけ（左の欄へは落とさない）
  const beginItemDrag = useFileDrag(() => {});

  /** fx のプルダウン：エフェクトセットを付ける・外す、または管理画面を開く */
  const changeChain = (item: PlaylistItem, value: string) => {
    const targets = targetsOf(item);
    if (value === NEW_FX) onOpenEffects(item, null, targets.map((t) => t.id));
    else if (value === EDIT_FX) onOpenEffects(item, item.effectChain?.id ?? null, []);
    else onSetChain(targets, value === "" ? null : Number(value));
  };
  // 前に書き出したフォルダ（フォルダを選ぶダイアログを、そこから開く）
  const [lastDest, setLastDest] = useStoredString("cyanomelody.exportDest");

  /** 書き出しの「ファイル」：書き出し先のフォルダを選ぶダイアログをすぐ出し、選んだら書き出し始める（一括操作と同じ） */
  const startExport = async () => {
    const dest = await onBrowseFolder(lastDest || undefined);
    if (dest && (await onExport(dest))) setLastDest(dest);
  };
  // 項目の並べ替え（行のドラッグ。前・後ろだけ）
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{
    index: number;
    pos: "before" | "after";
  } | null>(null);

  // ループになるプレイリスト（自分自身と、自分を含むもの）は、候補に出すが選べないようにする
  const loops = new Set(playlists.filter((p) => makesLoop(playlists, detail.id, p.id)).map((p) => p.id));
  /** タグの組み合わせの項目として加えるため、並べたタグ */
  const [comboIds, setComboIds] = useState<number[]>([]);
  const combo = comboIds.map((id) => tags.find((t) => t.id === id)).filter((t): t is Tag => t !== undefined);

  const targetAt = (x: number, y: number) => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-item-index]");
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return {
      index: Number(row.dataset.itemIndex),
      pos: y - rect.top < rect.height / 2 ? "before" : "after",
    } as const;
  };

  /** index の項目をつかんだときの並べ替え：項目の行の上で離すと、その前・後ろへ移す（つかんだ項目だけ） */
  const reorder = (index: number): LocalDrop => ({
    over: (x, y) => {
      const t = targetAt(x, y);
      setDragIndex(index);
      setDropAt(t);
      return true;
    },
    drop: (x, y) => {
      const t = targetAt(x, y);
      if (!t) return;
      // 移す項目を抜いた後の並びでの位置
      let dest = t.pos === "before" ? t.index : t.index + 1;
      if (index < dest) dest -= 1;
      if (dest !== index) onMoveItem(detail.items[index], dest);
    },
    end: () => {
      setDragIndex(null);
      setDropAt(null);
    },
  });

  const commitName = async () => {
    const next = name.trim();
    if (!next) return;
    if (next === detail.name || (await onRename(next))) setRenaming(false);
  };

  return (
    <div className="overlay">
      <div className="dialog playlist-dialog" role="dialog" aria-label="プレイリストの編集">
        <div className="playlist-editor" data-testid="playlist-editor">
          <div className="toolbar editor-head">
            {renaming ? (
              <input
                type="text"
                className="name-input"
                autoFocus
                value={name}
                aria-label="プレイリストの新しい名前"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  setName(detail.name);
                  setRenaming(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                    setName(detail.name);
                    setRenaming(false);
                  }
                }}
              />
            ) : (
              <>
                <h2 className="editor-title" data-testid="playlist-title" title={detail.name}>
                  {detail.name}
                </h2>
                <button
                  className="icon"
                  onClick={() => {
                    setName(detail.name);
                    setRenaming(true);
                  }}
                  disabled={busy}
                  title="名前を変える"
                  aria-label="プレイリストの名前を変える"
                >
                  ✎
                </button>
              </>
            )}
            <button
              onClick={onPlay}
              disabled={busy}
              title="このプレイリストを選んで、中央の一覧を頭から再生する"
              aria-label="プレイリストを再生"
            >
              ▶ 再生
            </button>
            <button onClick={onClose}>閉じる</button>
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
            <div className="playlist-items" ref={itemsRef}>
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
                  data-item-id={item.id}
                  data-item-index={index}
                  data-item-kind={item.kind}
                  // 行の中のボタン・プルダウン・チェックボックスを押したときは、その操作だけにする
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest("button, select, input, label")) setFocusedItemId(item.id);
                  }}
                  // ダブルクリックで、その項目を再生する（項目の▶と同じ）
                  onDoubleClick={(e) => {
                    const playable = item.kind === "file" ? !!item.file && !item.file.missing : item.fileCount > 0;
                    if (playable && !(e.target as HTMLElement).closest("button, select, input, label")) onPlayItem(item);
                  }}
                  onPointerDown={(e) => beginItemDrag(e, [], busy || aliasItemId !== null ? undefined : reorder(index))}
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
                  {aliasItemId === item.id ? (
                    <AliasInput
                      item={item}
                      onCommit={async (alias) => {
                        if (await onSetAlias(item, alias)) setAliasItemId(null);
                      }}
                      onCancel={() => setAliasItemId(null)}
                    />
                  ) : (
                    // プレイリスト上での名前があればそれだけを出す。元の名前はマウスを乗せると出る
                    <span className="item-content" title={itemContent(item)} data-testid="item-content">
                      {item.alias ?? itemContent(item)}
                      {item.file?.missing && (
                        <span className="warn" title="ファイルが見つかりません">
                          {" "}
                          ⚠
                        </span>
                      )}
                    </span>
                  )}
                  <button
                    className="icon row-icon"
                    onClick={() => setAliasItemId(item.id)}
                    disabled={busy}
                    title="プレイリスト上での名前を付ける"
                    aria-label={`${itemContent(item)}のプレイリスト上での名前を付ける`}
                  >
                    ✎
                  </button>
                  {item.kind !== "file" && (
                    <>
                      <select
                        value={item.mode}
                        onChange={(e) => onSetMode(targetsOf(item).filter((t) => t.kind !== "file"), e.target.value as PlayMode)}
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

            {/* 項目を加える：タグの組み合わせ（タグを並べて「追加」）と、プレイリスト（選んだらすぐ加える） */}
            <div className="playlist-add">
              <div className="row combo-row">
                <TagInput
                  candidates={tags.filter((t) => !comboIds.includes(t.id))}
                  attachedNames={combo.flatMap((t) => [t.name, ...t.synonyms])}
                  busy={busy}
                  label="組み合わせに加えるタグ"
                  placeholder="タグ（Enterで並べる）"
                  onAdd={async (input) => {
                    const key = input.trim().toLowerCase();
                    const tag = tags.find(
                      (t) => t.name.toLowerCase() === key || t.synonyms.some((s) => s.toLowerCase() === key),
                    );
                    if (!tag) {
                      onError(`タグ「${input.trim()}」はありません`);
                      return false;
                    }
                    setComboIds((ids) => [...ids, tag.id]);
                    return true;
                  }}
                />
                <span className="chips" data-testid="combo-tags">
                  {combo.map((t) => (
                    <button
                      key={t.id}
                      className="chip"
                      onClick={() => setComboIds((ids) => ids.filter((id) => id !== t.id))}
                      title="押すと外す"
                    >
                      🏷 {t.name} ✕
                    </button>
                  ))}
                </span>
                <button
                  onClick={async () => {
                    if (await onAddTags(comboIds)) setComboIds([]);
                  }}
                  disabled={busy || comboIds.length === 0}
                >
                  タグの組み合わせを追加
                </button>
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
              <div className="sub">ファイルは、中央の一覧の行を左の欄のプレイリストへドラッグして加えます。</div>
            </div>
          </div>

          <div className="toolbar editor-foot">
            <span className="foot-label">書き出し：</span>
            <button onClick={startExport} disabled={busy} title="エフェクトをかけた音を、階層をフォルダにして書き出す（書き出し先のフォルダを選ぶ）">
              ファイル
            </button>
            <button onClick={onExportMetadata} disabled={busy} title="曲のタグ・出典・ライセンス・曲名などを JSON に書き出す">
              メタデータ
            </button>
            <span className="sub">どちらも、中央の一覧に出ている曲（絞り込みと並び順のとおり）が対象です</span>
          </div>
        </div>
      </div>
    </div>
  );
}
