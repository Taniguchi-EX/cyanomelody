import { useEffect, useState } from "react";
import { playlistApi, type PlayEntry, type PlaylistItem } from "../api";
import { baseName } from "../paths";
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

type ItemProps = AliasProps & {
  /** データを読み直すたびに変わる値（曲のリストを読み直すのに使う） */
  dataVersion: number;
};

/**
 * 右の欄。ファイルでない項目（タグの組み合わせ・プレイリスト）を押したときの詳細。
 * 「プレイリスト上での名前」の欄と、項目に入る曲のリスト（再生方法にかかわらず、順に再生したときの並び）を出す
 */
export function ItemDetail({ item, busy, onSave, dataVersion }: ItemProps) {
  const kind = item.kind === "file" ? null : KIND_LABEL[item.kind];
  const [tracks, setTracks] = useState<{ itemId: number; list: PlayEntry[] } | null>(null);
  useEffect(() => {
    let alive = true;
    playlistApi
      .itemFiles(item.id)
      .then((list) => alive && setTracks({ itemId: item.id, list }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [item.id, dataVersion]);
  const list = tracks && tracks.itemId === item.id ? tracks.list : null;
  return (
    <section data-testid="item-detail">
      <AliasField key={`${item.id}:${item.alias ?? ""}`} item={item} busy={busy} onSave={onSave} />
      {kind && <h2>{kind}</h2>}
      <div data-testid="item-detail-content">{itemContent(item)}</div>
      {list && (
        <>
          <h2>
            曲 <span className="sub" data-testid="item-track-count">{list.length}</span>
          </h2>
          {item.mode !== "order" && <div className="sub">再生するときは、この中から並べ替える・選ぶ</div>}
          <ul className="item-tracks" data-testid="item-tracks">
            {list.map((t, i) => (
              <li key={`${i}:${t.fileId}`} title={t.relPath}>
                {baseName(t.relPath)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
