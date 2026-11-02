import { invoke } from "@tauri-apps/api/core";

export type LibraryFolder = {
  id: number;
  path: string;
  fileCount: number;
  missingCount: number;
};

export type ScanResult = {
  folderId: number;
  found: number;
  added: number;
  missing: number;
  restored: number;
};

export type AudioFile = {
  id: number;
  folderId: number;
  relPath: string;
  path: string;
  size: number;
  modifiedAt: number;
  missing: boolean;
  tags: string[];
  hash: string | null;
  hashError: string | null;
  sourceId: number | null;
  licenseId: number | null;
};

export type FileFilter = {
  text: string;
  tagIds: number[];
  untaggedOnly: boolean;
  missingOnly: boolean;
  duplicatesOnly: boolean;
  hash: string | null;
  /** どれかの出典が設定されたファイル（OR） */
  sourceIds: number[];
  noSource: boolean;
  /** どれかのライセンスが設定されたファイル（OR） */
  licenseIds: number[];
  noLicense: boolean;
  /** 指定したidのファイルだけ（チェックしたファイルだけの表示）。null なら絞り込まない */
  fileIds: number[] | null;
};

/** 絞り込みの各項目を選んだときの件数。0件の項目は入らない */
export type Facets = {
  tags: CountItem[];
  untagged: number;
  /** id が null は「（出典なし）」 */
  sources: CountItem[];
  licenses: CountItem[];
};

/** 件数の内訳の1項目。id が null は「なし」 */
export type CountItem = { id: number | null; count: number };

/** まとめて操作するファイル（チェックしたファイル）の内訳 */
export type FileSummary = {
  /** 指定したidのうち、ライブラリにあるもの */
  ids: number[];
  missing: number;
  /** 付いているタグ（タグの一覧の順）と、そのタグが付いたファイルの数 */
  tags: CountItem[];
  sources: CountItem[];
  licenses: CountItem[];
};

export type Tag = {
  id: number;
  name: string;
  /** 親のタグのid。最上位なら null */
  parentId: number | null;
  /** 階層の深さ。最上位は0 */
  depth: number;
  /** そのタグか子孫のタグが付いたファイルの数 */
  fileCount: number;
};

/** タグを移す先 */
export type MoveTarget =
  | { kind: "before"; tagId: number }
  | { kind: "after"; tagId: number }
  | { kind: "child"; tagId: number }
  | { kind: "root" };

export const api = {
  listFolders: () => invoke<LibraryFolder[]>("list_folders"),
  addFolder: (path: string) => invoke<ScanResult>("add_folder", { path }),
  removeFolder: (folderId: number) => invoke<void>("remove_folder", { folderId }),
  scanFolder: (folderId: number) => invoke<ScanResult>("scan_folder", { folderId }),
  listFiles: (filter: FileFilter) => invoke<AudioFile[]>("list_files", { filter }),
  facetCounts: (filter: FileFilter) => invoke<Facets>("facet_counts", { filter }),
  summarizeFiles: (fileIds: number[]) => invoke<FileSummary>("summarize_files", { fileIds }),
  listTags: () => invoke<Tag[]>("list_tags"),
  addTag: (fileIds: number[], name: string) => invoke<number>("add_tag", { fileIds, name }),
  removeTag: (fileIds: number[], tagId: number) => invoke<void>("remove_tag", { fileIds, tagId }),
  removeMissingFiles: (fileIds: number[]) => invoke<number>("remove_missing_files", { fileIds }),
  createTag: (name: string) => invoke<number>("create_tag", { name }),
  renameTag: (tagId: number, name: string, merge: boolean) =>
    invoke<RenameResult>("rename_tag", { tagId, name, merge }),
  deleteTag: (tagId: number) => invoke<void>("delete_tag", { tagId }),
  deleteUnusedTags: () => invoke<number>("delete_unused_tags"),
  moveTag: (tagId: number, target: MoveTarget) => invoke<void>("move_tag", { tagId, target }),
  startHashing: () => invoke<void>("start_hashing"),
  cancelHashing: () => invoke<void>("cancel_hashing"),
  hashingProgress: () => invoke<HashProgress>("hashing_progress"),
  hashFile: (path: string) => invoke<string>("hash_file", { path }),
  relinkFiles: (fileIds: number[]) => invoke<RelinkResult>("relink_files", { fileIds }),
  licenseTypes: () => invoke<LicenseType[]>("license_types"),
  listCredits: (kind: CreditKind) => invoke<Credit[]>("list_credits", { kind }),
  createCredit: (kind: CreditKind, input: CreditInput) => invoke<number>("create_credit", { kind, input }),
  updateCredit: (kind: CreditKind, id: number, input: CreditInput) =>
    invoke<void>("update_credit", { kind, id, input }),
  deleteCredit: (kind: CreditKind, id: number) => invoke<void>("delete_credit", { kind, id }),
  /** name が null なら外す */
  setFileCredit: (kind: CreditKind, fileIds: number[], name: string | null) =>
    invoke<number | null>("set_file_credit", { kind, fileIds, name }),
};

/** 出典かライセンスか */
export type CreditKind = "source" | "license";

/** ライセンスの条項。null は「不明」 */
export type Terms = {
  commercial: boolean | null;
  credit: boolean | null;
  modify: boolean | null;
  redistribute: boolean | null;
  shareAlike: boolean | null;
};

export type LicenseType = {
  key: string;
  name: string;
  terms: Terms;
};

/** 出典またはライセンス。出典では licenseType は null、terms はすべて不明 */
export type Credit = {
  id: number;
  name: string;
  url: string;
  note: string;
  /** 一般的なライセンスの種類。「独自」のときは null */
  licenseType: string | null;
  terms: Terms;
  fileCount: number;
};

export type CreditInput = {
  name: string;
  url: string;
  note: string;
  licenseType: string | null;
  terms: Terms;
};

export type RenameResult = {
  tagId: number;
  merged: boolean;
};

export function describeScan(path: string, r: ScanResult): string {
  const parts = [`${r.found}件`];
  if (r.added) parts.push(`追加 ${r.added}件`);
  if (r.missing) parts.push(`見つからない ${r.missing}件`);
  if (r.restored) parts.push(`戻った ${r.restored}件`);
  return `スキャンしました: ${path}（${parts.join("、")}）`;
}

export type HashProgress = {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  cancelled: boolean;
};

export type RelinkResult = {
  relinked: number;
  notFound: number;
  ambiguous: number;
  noHash: number;
};

export function describeHashing(p: HashProgress): string {
  if (p.running) return `ハッシュ値を計算中 ${p.done}/${p.total}`;
  const parts = [`${p.done}件`];
  if (p.failed) parts.push(`計算できなかったファイル ${p.failed}件`);
  return p.cancelled
    ? `ハッシュ値の計算を中止しました（${parts.join("、")}）`
    : `ハッシュ値を計算しました（${parts.join("、")}）`;
}
