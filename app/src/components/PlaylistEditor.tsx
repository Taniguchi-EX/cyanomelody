import { useEffect, useRef, useState } from "react";
import { type PlayMode, type PlaylistDetail, type PlaylistItem, type PlaylistNode, type Tag } from "../api";
import type { EffectChain } from "../effects";
import { useStoredString } from "../storage";
import { useEscape } from "../hooks/useEscape";
import { useFileDrag, type LocalDrop } from "../hooks/useFileDrag";
import { PlaylistAddPanel } from "./PlaylistAddPanel";
import { PlaylistItemRow } from "./PlaylistItemRow";

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
  /** dest の中に書き出し始める（items の項目の曲。空ならすべて）。始められたら true */
  onExport: (dest: string, items: number[]) => Promise<boolean>;
  /** 書き出しの「メタデータ」：items の項目（空ならすべて）の曲のメタデータを JSON に書き出す（保存先を選ぶ） */
  onExportMetadata: (items: number[]) => void;
  /** フォルダを選ぶダイアログを出し、選んだパスを返す（キャンセルなら null）。defaultPath は最初に開くフォルダ */
  onBrowseFolder: (defaultPath?: string) => Promise<string | null>;
  onError: (e: unknown) => void;
};

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
  /** チェックした項目（プレイリストから外す・fx・再生方法・書き出しの対象）。開いているプレイリストの中だけ */
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

  // 前に書き出したフォルダ（フォルダを選ぶダイアログを、そこから開く）
  const [lastDest, setLastDest] = useStoredString("cyanomelody.exportDest");

  /** 書き出す項目：チェックした項目（チェックがなければすべて。空で渡す） */
  const exportItems = checkedItems.map((i) => i.id);
  /** 書き出しの「ファイル」：書き出し先のフォルダを選ぶダイアログをすぐ出し、選んだら書き出し始める（一括操作と同じ） */
  const startExport = async () => {
    const dest = await onBrowseFolder(lastDest || undefined);
    if (dest && (await onExport(dest, exportItems))) setLastDest(dest);
  };
  // 項目の並べ替え（行のドラッグ。前・後ろだけ）
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{
    index: number;
    pos: "before" | "after";
  } | null>(null);

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
                  プレイリストから外す
                </button>
              </div>
            )}
            <div className="playlist-items" ref={itemsRef}>
              {detail.items.length === 0 && <div className="empty">項目はまだありません</div>}
              {detail.items.map((item, index) => (
                <PlaylistItemRow
                  key={item.id}
                  item={item}
                  index={index}
                  busy={busy}
                  chains={chains}
                  focused={focusedItemId === item.id}
                  checked={checked.has(item.id)}
                  playing={playingItemId === item.id}
                  dragSource={dragIndex === index}
                  dropPos={dropAt?.index === index ? dropAt.pos : null}
                  editingAlias={aliasItemId === item.id}
                  onFocus={() => setFocusedItemId(item.id)}
                  onPlay={() => onPlayItem(item)}
                  onPointerDown={(e) => beginItemDrag(e, [], busy || aliasItemId !== null ? undefined : reorder(index))}
                  onStartAlias={() => setAliasItemId(item.id)}
                  onCommitAlias={async (alias) => {
                    if (await onSetAlias(item, alias)) setAliasItemId(null);
                  }}
                  onCancelAlias={() => setAliasItemId(null)}
                  onSetMode={(mode) => onSetMode(targetsOf(item).filter((t) => t.kind !== "file"), mode)}
                  onSetChain={(chainId) => onSetChain(targetsOf(item), chainId)}
                  onNewChain={() => onOpenEffects(item, null, targetsOf(item).map((t) => t.id))}
                  onEditChain={() => onOpenEffects(item, item.effectChain?.id ?? null, [])}
                  onRemove={() => onRemoveItem(item)}
                  onToggleCheck={() => toggleCheck(item.id)}
                />
              ))}
            </div>

            <PlaylistAddPanel
              playlistId={detail.id}
              playlists={playlists}
              tags={tags}
              busy={busy}
              onAddTags={onAddTags}
              onAddRef={onAddRef}
              onError={onError}
            />
          </div>

          <div className="toolbar editor-foot">
            <span className="foot-label">書き出し：</span>
            <button onClick={startExport} disabled={busy} title="エフェクトをかけた音を、階層をフォルダにして書き出す（書き出し先のフォルダを選ぶ）">
              ファイル
            </button>
            <button onClick={() => onExportMetadata(exportItems)} disabled={busy} title="曲のタグ・出典・ライセンス・曲名などを JSON に書き出す">
              メタデータ
            </button>
            <span className="sub">
              どちらも、{checkedItems.length > 0 ? `チェックした${checkedItems.length}件の項目` : "すべての項目"}
              が対象です。🎲・🔀の項目は書き出すときに抽選し直します
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
