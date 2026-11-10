import { useEffect, useState } from "react";
import type { Credit, CreditKind, FileFilter, LibraryFolder, Tag } from "../api";
import { CREDIT_LABEL } from "../credits";
import { baseName } from "../paths";
import {
  DURATION_LIMITS,
  formatDuration,
  OTHER_ITEMS,
  YEAR_LIMITS,
  type DurationKey,
  type OtherKey,
  type YearKey,
} from "../otherFilters";
import type { FilterChip } from "../components/FilterChips";

export const EMPTY_FILTER: FileFilter = {
  text: "",
  tagIds: [],
  untaggedOnly: false,
  missingOnly: false,
  duplicatesOnly: false,
  hash: null,
  sourceIds: [],
  noSource: false,
  licenseIds: [],
  noLicense: false,
  fileIds: null,
  folderId: null,
  recentOnly: false,
  minDuration: null,
  maxDuration: null,
  minYear: null,
  maxYear: null,
  draw: false,
};

/** 出典・ライセンスの絞り込みの条件を持つ FileFilter の項目 */
export const FILTER_KEYS = {
  source: { ids: "sourceIds", none: "noSource" },
  license: { ids: "licenseIds", none: "noLicense" },
} as const;

/** 検索の文字を打ってから、絞り込むまでの待ち（ms） */
const TEXT_DELAY = 200;

const toggled = (ids: number[], id: number) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

/** 条件のチップに出す名前を引くもの */
type ChipNames = {
  folders: LibraryFolder[];
  tags: Tag[];
  credits: (kind: CreditKind) => Credit[];
};

/**
 * ファイルの一覧の絞り込みの条件（左の欄で選ぶもの）と、その操作。
 * 検索の文字は、打ち終わるまで少し待ってから条件に入れる
 */
export function useFileFilter() {
  const [filter, setFilter] = useState<FileFilter>(EMPTY_FILTER);
  const [text, setText] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setFilter((f) => (f.text === text ? f : { ...f, text })), TEXT_DELAY);
    return () => clearTimeout(timer);
  }, [text]);

  /** 条件をすべて外して、next だけにする（検索の文字も消す） */
  const reset = (next: Partial<FileFilter> = {}) => {
    setText("");
    setFilter({ ...EMPTY_FILTER, ...next });
  };

  const toggleFolder = (id: number) => setFilter((f) => ({ ...f, folderId: f.folderId === id ? null : id }));

  /** 登録を解除したフォルダを、条件から外す */
  const dropFolder = (id: number) => setFilter((f) => (f.folderId === id ? { ...f, folderId: null } : f));

  /** タグどうしはAND。「（タグなし）」とは同時に選べない */
  const toggleTag = (tagId: number) => setFilter((f) => ({ ...f, untaggedOnly: false, tagIds: toggled(f.tagIds, tagId) }));

  const toggleUntagged = () => setFilter((f) => ({ ...f, tagIds: [], untaggedOnly: !f.untaggedOnly }));

  /** 削除・統合したタグを、条件から外す・置き換える */
  const replaceTag = (from: number, to: number | null) =>
    setFilter((f) => {
      if (!f.tagIds.includes(from)) return f;
      const ids = f.tagIds.filter((id) => id !== from);
      if (to !== null && !ids.includes(to)) ids.push(to);
      return { ...f, tagIds: ids };
    });

  /** 出典どうし・ライセンスどうしはOR。「なし」とは同時に選べない */
  const toggleCredit = (kind: CreditKind, id: number) => {
    const k = FILTER_KEYS[kind];
    setFilter((f) => ({ ...f, [k.none]: false, [k.ids]: toggled(f[k.ids], id) }));
  };

  const toggleCreditNone = (kind: CreditKind) => {
    const k = FILTER_KEYS[kind];
    setFilter((f) => ({ ...f, [k.ids]: [], [k.none]: !f[k.none] }));
  };

  /** 削除した出典・ライセンスを、条件から外す */
  const dropCredit = (kind: CreditKind, id: number) => {
    const k = FILTER_KEYS[kind];
    setFilter((f) => (f[k.ids].includes(id) ? { ...f, [k.ids]: f[k.ids].filter((x) => x !== id) } : f));
  };

  /** 「その他」の条件（重複・直近で再生・リンク切れ）を選ぶ・外す */
  const toggleOther = (key: OtherKey) => setFilter((f) => ({ ...f, [key]: !f[key] }));

  /** 長さの条件（以上・以下）を決める。null で外す */
  const setDuration = (key: DurationKey, seconds: number | null) => setFilter((f) => ({ ...f, [key]: seconds }));

  /** リリース年の条件（以上・以下）を決める。null で外す */
  const setYear = (key: YearKey, year: number | null) => setFilter((f) => ({ ...f, [key]: year }));

  /** 選んでいる条件のチップ（検索の欄の下に出す。押すとその条件だけ外す） */
  const chips = ({ folders, tags, credits }: ChipNames): FilterChip[] => {
    const nameOf = (list: { id: number; name: string }[], id: number) => list.find((x) => x.id === id)?.name ?? "?";
    const out: FilterChip[] = [];
    if (filter.folderId !== null) {
      const folder = folders.find((f) => f.id === filter.folderId);
      out.push({
        key: "folder",
        icon: "📁",
        label: folder ? baseName(folder.label) : "?",
        title: folder?.label,
        onRemove: () => setFilter((f) => ({ ...f, folderId: null })),
      });
    }
    if (filter.untaggedOnly) out.push({ key: "untagged", icon: "🏷", label: "タグなし", onRemove: toggleUntagged });
    for (const id of filter.tagIds) {
      out.push({ key: `tag-${id}`, icon: "🏷", label: nameOf(tags, id), onRemove: () => toggleTag(id) });
    }
    for (const kind of ["source", "license"] as const) {
      const k = FILTER_KEYS[kind];
      const icon = kind === "source" ? "🔗" : "⚖";
      if (filter[k.none]) {
        out.push({ key: `${kind}-none`, icon, label: `${CREDIT_LABEL[kind]}なし`, onRemove: () => toggleCreditNone(kind) });
      }
      for (const id of filter[k.ids]) {
        out.push({
          key: `${kind}-${id}`,
          icon,
          label: nameOf(credits(kind), id),
          title: CREDIT_LABEL[kind],
          onRemove: () => toggleCredit(kind, id),
        });
      }
    }
    for (const item of OTHER_ITEMS) {
      if (filter[item.key]) {
        out.push({ key: item.key, icon: item.icon, label: item.chip, title: item.label, onRemove: () => toggleOther(item.key) });
      }
    }
    for (const limit of DURATION_LIMITS) {
      const seconds = filter[limit.key];
      if (seconds !== null) {
        out.push({
          key: limit.key,
          icon: "⏱",
          label: `${formatDuration(seconds)}${limit.label}`,
          title: `長さが${formatDuration(seconds)}${limit.label}`,
          onRemove: () => setDuration(limit.key, null),
          testId: "duration-filter",
        });
      }
    }
    for (const limit of YEAR_LIMITS) {
      const year = filter[limit.key];
      if (year !== null) {
        out.push({
          key: limit.key,
          icon: "📅",
          label: `${year}年${limit.label}`,
          title: `リリース年が${year}年${limit.label}（${year}年を含む）`,
          onRemove: () => setYear(limit.key, null),
          testId: "year-filter",
        });
      }
    }
    if (filter.hash) {
      out.push({
        key: "hash",
        icon: "🔊",
        label: "同じ音声",
        title: filter.hash,
        onRemove: () => setFilter((f) => ({ ...f, hash: null })),
        testId: "hash-filter",
      });
    }
    return out;
  };

  return {
    filter,
    text,
    setText,
    reset,
    toggleFolder,
    dropFolder,
    toggleTag,
    toggleUntagged,
    replaceTag,
    toggleCredit,
    toggleCreditNone,
    dropCredit,
    toggleOther,
    setDuration,
    setYear,
    chips,
  };
}
