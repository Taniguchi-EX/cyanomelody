import { useId, useRef, useState } from "react";
import type { Tag } from "../api";
import { isAndroid } from "../platform";

type Props = {
  /** 候補に出すタグ（まだ付いていないもの） */
  candidates: Tag[];
  /** 付いているタグの名前とシノニム（同じ名前を入れたときは何もしない） */
  attachedNames: string[];
  busy: boolean;
  /** 付ける。付けられたら true（入力欄を空にする） */
  onAdd: (name: string) => Promise<boolean>;
  /** 入力欄の名前と、空のときに出す文字（ほかの画面で使うとき） */
  label?: string;
  placeholder?: string;
};

/** Android で、入力欄の下に並べる候補の数の上限 */
const SUGGEST_MAX = 30;

/** 名前かシノニムに input を含むタグ（大文字・小文字は区別しない）。名前が input で始まるものを先に並べる */
function suggestTags(candidates: Tag[], input: string): Tag[] {
  const key = input.trim().toLowerCase();
  if (!key) return [];
  const hits = candidates.filter(
    (t) => t.name.toLowerCase().includes(key) || t.synonyms.some((s) => s.toLowerCase().includes(key)),
  );
  const head = (t: Tag) => (t.name.toLowerCase().startsWith(key) ? 0 : 1);
  // sort は元の並び（タグの並び順）を保つ
  return hits.sort((a, b) => head(a) - head(b)).slice(0, SUGGEST_MAX);
}

/**
 * el を、スクロールする欄（一番近いもの）の上の方へ寄せる。scrollIntoView は画面全体（見出しの行も）までずらすので使わない
 */
function scrollToTop(el: HTMLElement) {
  let box = el.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box) return;
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
  box.scrollBy({ top, behavior: "smooth" });
}

/** タグの名前を入れて付ける欄。候補から選ぶとすぐ付け、Enter で入れた名前を付ける（まだない名前なら作る）。
 *  候補はシノニムでも引っかかり（候補の横にシノニムを出す）、シノニムを入れて Enter ならそのタグを付ける。
 *  Android では、端末の候補の一覧（datalist）は入力欄に重なって出るので使わず、入力欄の下に候補を並べる */
export function TagInput({ candidates, attachedNames, busy, onAdd, label = "付けるタグ名", placeholder = "名前（Enterで付ける）" }: Props) {
  const [name, setName] = useState("");
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
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
  const input = (
    <input
      type="text"
      list={isAndroid ? undefined : listId}
      placeholder={placeholder}
      value={name}
      onChange={(e) => {
        // 候補の一覧から選んだとき（打ち込みではなく置き換え）は、すぐに付ける
        const picked = (e.nativeEvent as InputEvent).inputType === "insertReplacementText";
        const tag = picked ? candidates.find((t) => t.name === e.target.value) : undefined;
        if (tag) add(tag.name);
        else setName(e.target.value);
      }}
      onKeyDown={(e) => e.key === "Enter" && add(name)}
      onFocus={
        isAndroid
          ? () =>
              // キーボードが出て画面が縮んでから、入力欄を画面の上の方へ寄せる（下に候補を出す場所を空ける）
              window.setTimeout(() => wrapRef.current && scrollToTop(wrapRef.current), 300)
          : undefined
      }
      aria-label={label}
    />
  );
  if (!isAndroid) {
    return (
      <div className="row">
        {input}
        <datalist id={listId}>
          {candidates.map((t) => (
            // label にシノニムを入れると、候補の横に出て、シノニムでも引っかかる
            <option key={t.id} value={t.name} label={t.synonyms.length > 0 ? t.synonyms.join(" / ") : undefined} />
          ))}
        </datalist>
      </div>
    );
  }
  const suggestions = suggestTags(candidates, name);
  return (
    <div className="tag-input" ref={wrapRef}>
      <div className="row">{input}</div>
      {suggestions.length > 0 && (
        <ul className="tag-suggest" data-testid="tag-suggest" aria-label="候補">
          {suggestions.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                // 押しても入力欄から離れない（キーボードを閉じない）ようにする
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(t.name)}
                disabled={busy}
              >
                <span className="tag-suggest-name">{t.name}</span>
                {t.synonyms.length > 0 && <span className="sub">{t.synonyms.join(" / ")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
