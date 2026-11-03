import { useState } from "react";
import type { PlaylistItem } from "../api";
import { itemContent } from "../playlistItem";

type AliasProps = {
  item: PlaylistItem;
  busy: boolean;
  /** 保存する（空なら外す） */
  onSave: (alias: string) => void;
};

/**
 * 「プレイリスト上での名前」（項目の別名）の欄。Enterか、欄の外に出たときに保存する。Escで元に戻す。
 * 保存すると項目が読み直されるので、呼ぶ側で key に別名を含めて入れ直す
 */
export function AliasField({ item, busy, onSave }: AliasProps) {
  const [value, setValue] = useState(item.alias ?? "");
  const save = () => {
    if (!busy && value.trim() !== (item.alias ?? "")) onSave(value);
  };
  return (
    <div className="alias-field">
      <h2>プレイリスト上での名前</h2>
      <input
        type="text"
        value={value}
        placeholder={itemContent(item)}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setValue(item.alias ?? "");
        }}
        onBlur={save}
        aria-label="プレイリスト上での名前"
      />
    </div>
  );
}

const KIND_LABEL = { tags: "タグの組み合わせ", playlist: "プレイリスト" } as const;

type ItemProps = AliasProps;

/** 右の欄。ファイルでない項目（タグの組み合わせ・プレイリスト）を押したときの詳細 */
export function ItemDetail({ item, busy, onSave }: ItemProps) {
  const kind = item.kind === "file" ? null : KIND_LABEL[item.kind];
  return (
    <section data-testid="item-detail">
      <AliasField key={`${item.id}:${item.alias ?? ""}`} item={item} busy={busy} onSave={onSave} />
      {kind && <h2>{kind}</h2>}
      <div data-testid="item-detail-content">{itemContent(item)}</div>
    </section>
  );
}
