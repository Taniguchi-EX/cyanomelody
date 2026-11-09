import { useId, useState } from "react";
import type { Tag } from "../api";

type Props = {
  /** 候補に出すタグ（まだ付いていないもの） */
  candidates: Tag[];
  /** 付いているタグの名前とシノニム（同じ名前を入れたときは何もしない） */
  attachedNames: string[];
  busy: boolean;
  /** 付ける。付けられたら true（入力欄を空にする） */
  onAdd: (name: string) => Promise<boolean>;
};

/** タグの名前を入れて付ける欄。候補から選ぶとすぐ付け、Enter で入れた名前を付ける（まだない名前なら作る）。
 *  候補はシノニムでも引っかかり（候補の横にシノニムを出す）、シノニムを入れて Enter ならそのタグを付ける */
export function TagInput({ candidates, attachedNames, busy, onAdd }: Props) {
  const [name, setName] = useState("");
  const listId = useId();
  /** 付ける。既にあるタグ名かシノニム（大文字・小文字は区別しない）ならそのタグを、なければ新しいタグを作って付ける */
  const add = async (input: string) => {
    const key = input.trim().toLowerCase();
    if (!key || busy) return;
    if (attachedNames.some((n) => n.toLowerCase() === key)) {
      setName("");
      return;
    }
    const existing = candidates.find(
      (t) => t.name.toLowerCase() === key || t.synonyms.some((s) => s.toLowerCase() === key),
    );
    if (await onAdd(existing?.name ?? input)) setName("");
  };
  return (
    <div className="row">
      <input
        type="text"
        list={listId}
        placeholder="名前（Enterで付ける）"
        value={name}
        onChange={(e) => {
          // 候補の一覧から選んだとき（打ち込みではなく置き換え）は、すぐに付ける
          const picked = (e.nativeEvent as InputEvent).inputType === "insertReplacementText";
          const tag = picked ? candidates.find((t) => t.name === e.target.value) : undefined;
          if (tag) add(tag.name);
          else setName(e.target.value);
        }}
        onKeyDown={(e) => e.key === "Enter" && add(name)}
        aria-label="付けるタグ名"
      />
      <datalist id={listId}>
        {candidates.map((t) => (
          // label にシノニムを入れると、候補の横に出て、シノニムでも引っかかる
          <option key={t.id} value={t.name} label={t.synonyms.length > 0 ? t.synonyms.join(" / ") : undefined} />
        ))}
      </datalist>
    </div>
  );
}
