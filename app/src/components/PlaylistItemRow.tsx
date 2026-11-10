import { useState, type PointerEvent } from "react";
import type { PlayMode, PlaylistItem } from "../api";
import type { EffectChain } from "../effects";
import { PLAY_MODES } from "../listOptions";
import { itemContent } from "../playlistItem";

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

type Props = {
  item: PlaylistItem;
  /** 項目の並びの中の位置（ドラッグで並べ替える先を見分ける） */
  index: number;
  busy: boolean;
  chains: EffectChain[];
  /** 押した行（ファイルの一覧で選んだ行と同じ色） */
  focused: boolean;
  checked: boolean;
  /** 再生中の曲を出している項目 */
  playing: boolean;
  /** ドラッグでつかんでいる行 */
  dragSource: boolean;
  /** ドラッグで、この行の前・後ろに落とそうとしている */
  dropPos: "before" | "after" | null;
  /** プレイリスト上での名前を入れている */
  editingAlias: boolean;
  onFocus: () => void;
  /** この項目だけを再生する */
  onPlay: () => void;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onStartAlias: () => void;
  onCommitAlias: (alias: string) => void;
  onCancelAlias: () => void;
  onSetMode: (mode: PlayMode) => void;
  /** fx のプルダウンで、エフェクトセットを選んだ（null は「fx なし」） */
  onSetChain: (chainId: number | null) => void;
  /** fx のプルダウンの「新しいfxを作る」 */
  onNewChain: () => void;
  /** fx のプルダウンの「このfxを編集」 */
  onEditChain: () => void;
  onRemove: () => void;
  onToggleCheck: () => void;
};

/**
 * 編集画面の項目の1行：種類の記号（押すと再生）、内容（別名があれば別名と本来の名前）、別名の「✎」、
 * 再生方法とファイル数（ファイルの項目以外）、fx のプルダウン、「✕」（外す）、チェックボックス
 */
export function PlaylistItemRow(p: Props) {
  const { item } = p;
  const playable = item.kind === "file" ? !!item.file && !item.file.missing : item.fileCount > 0;
  // 行の中のボタン・プルダウン・チェックボックスを押したときは、その操作だけにする
  const onControl = (target: EventTarget) => !!(target as HTMLElement).closest("button, select, input, label");
  return (
    <div
      className={
        "playlist-item" +
        (p.focused ? " selected" : "") +
        (p.checked ? " checked" : "") +
        (p.playing ? " playing" : "") +
        (p.dragSource ? " drag-source" : "") +
        (p.dropPos ? ` drop-${p.dropPos}` : "") +
        (item.file?.missing ? " missing" : "")
      }
      data-testid="playlist-item"
      data-item-id={item.id}
      data-item-index={p.index}
      data-item-kind={item.kind}
      onClick={(e) => !onControl(e.target) && p.onFocus()}
      // ダブルクリックで、その項目を再生する（項目の▶と同じ）
      onDoubleClick={(e) => playable && !onControl(e.target) && p.onPlay()}
      onPointerDown={p.onPointerDown}
    >
      <button
        className="item-kind"
        title={kindLabel(item)}
        aria-label={`${itemContent(item)}を再生`}
        disabled={!playable}
        onClick={p.onPlay}
      >
        <span className="kind-icon">{kindIcon(item)}</span>
        <span className="kind-play">▶</span>
      </button>
      {p.editingAlias ? (
        <AliasInput item={item} onCommit={p.onCommitAlias} onCancel={p.onCancelAlias} />
      ) : (
        // プレイリスト上での名前があればそれを出し、横に本来の名前を薄く小さく出す（何のファイルだったか分かるように）
        <>
          <span className={item.alias ? "item-content has-alias" : "item-content"} title={itemContent(item)} data-testid="item-content">
            {item.alias ?? itemContent(item)}
            {item.file?.missing && (
              <span className="warn" title="ファイルが見つかりません">
                {" "}
                ⚠
              </span>
            )}
          </span>
          {item.alias && (
            <span className="item-original" title={itemContent(item)} data-testid="item-original">
              {itemContent(item)}
            </span>
          )}
        </>
      )}
      <button
        className="icon row-icon"
        onClick={p.onStartAlias}
        disabled={p.busy}
        title="プレイリスト上での名前を付ける"
        aria-label={`${itemContent(item)}のプレイリスト上での名前を付ける`}
      >
        ✎
      </button>
      {item.kind !== "file" && (
        <>
          <select
            value={item.mode}
            onChange={(e) => p.onSetMode(e.target.value as PlayMode)}
            disabled={p.busy}
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
        onChange={(e) => {
          const value = e.target.value;
          if (value === NEW_FX) p.onNewChain();
          else if (value === EDIT_FX) p.onEditChain();
          else p.onSetChain(value === "" ? null : Number(value));
        }}
        disabled={p.busy}
        aria-label={`${itemContent(item)}のエフェクト`}
        title="この項目にかけるエフェクトセット"
      >
        <option value="">fx なし</option>
        {p.chains.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        <option value={NEW_FX}>新しいfxを作る</option>
        {item.effectChain && <option value={EDIT_FX}>このfxを編集</option>}
      </select>
      <button className="icon" onClick={p.onRemove} disabled={p.busy} title="外す" aria-label={`${itemContent(item)}を外す`}>
        ✕
      </button>
      <label className="check-cell" title="チェックすると、まとめて操作できる">
        <input
          type="checkbox"
          checked={p.checked}
          onChange={p.onToggleCheck}
          aria-label={`${itemContent(item)}をチェック`}
          data-testid="item-check"
        />
      </label>
    </div>
  );
}
