import { useState } from "react";

// 画面の状態（欄のたたみ具合など）を localStorage に覚えておく。
// 読み書きできない環境（保存領域が使えないなど）でも動くように、失敗は無視する

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 覚えておけなくても動作には困らない
  }
}

/** 覚えておく真偽値（欄をたたんでいるか） */
export function useStoredFlag(key: string): [boolean, () => void] {
  const [value, setValue] = useState(() => load(key, false));
  const toggle = () =>
    setValue((v) => {
      save(key, !v);
      return !v;
    });
  return [value, toggle];
}

/** 覚えておくidの集合（木でたたんでいる節） */
export function useStoredIdSet(key: string): [Set<number>, (id: number) => void] {
  const [ids, setIds] = useState(() => new Set(load<number[]>(key, [])));
  const toggle = (id: number) =>
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      save(key, [...next]);
      return next;
    });
  return [ids, toggle];
}

/** 覚えておく文字列（前に入力した書き出し先など） */
export function useStoredString(key: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => load(key, ""));
  const set = (v: string) => {
    save(key, v);
    setValue(v);
  };
  return [value, set];
}
