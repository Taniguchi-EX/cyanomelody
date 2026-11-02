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
  /** 付いているタグ（タグの一覧の順） */
  tags: { id: number; name: string }[];
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

/** 木（タグ・プレイリスト）の並べ替えで、移す先 */
export type MoveTarget =
  | { kind: "before"; id: number }
  | { kind: "after"; id: number }
  | { kind: "child"; id: number }
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

/** 抽象的な項目の再生方法 */
export type PlayMode = "order" | "shuffle" | "random";

export const PLAY_MODES: { mode: PlayMode; label: string }[] = [
  { mode: "order", label: "順に再生" },
  { mode: "shuffle", label: "シャッフル再生" },
  { mode: "random", label: "ランダムセレクト再生" },
];

/** 左の欄に出すプレイリスト（階層の順） */
export type PlaylistNode = {
  id: number;
  name: string;
  /** 親（このプレイリストを子として持つプレイリスト）。最上位なら null */
  parentId: number | null;
  depth: number;
  itemCount: number;
  /** 項目として直接入れているプレイリスト（子と参照） */
  refs: number[];
};

export type PlaylistItem = {
  id: number;
  kind: "file" | "tags" | "playlist";
  mode: PlayMode;
  /** 子のプレイリストの項目か（参照なら false） */
  owned: boolean;
  file: { id: number; relPath: string; missing: boolean } | null;
  tags: { id: number; name: string }[];
  playlist: { id: number; name: string } | null;
  /** 再生したときのファイル数 */
  fileCount: number;
  /** 別名（このプレイリストの中でだけ使う名前） */
  alias: string | null;
  /** 結び付けたエフェクトのまとまり */
  effectChain: { id: number; name: string } | null;
};

export type PlaylistDetail = {
  id: number;
  name: string;
  items: PlaylistItem[];
};

/** 再生順の1曲 */
export type PlayEntry = {
  fileId: number;
  relPath: string;
  path: string;
  /** ファイルの項目の別名 */
  alias: string | null;
  /** かけるエフェクトのまとまり（内側から外側の順）。空ならエフェクトなし */
  effects: number[];
};

export const playlistApi = {
  list: () => invoke<PlaylistNode[]>("list_playlists"),
  get: (id: number) => invoke<PlaylistDetail>("get_playlist", { id }),
  create: (name: string, parent: number | null) => invoke<number>("create_playlist", { name, parent }),
  rename: (id: number, name: string) => invoke<void>("rename_playlist", { id, name }),
  remove: (id: number) => invoke<void>("delete_playlist", { id }),
  move: (id: number, target: MoveTarget) => invoke<void>("move_playlist", { id, target }),
  addFiles: (id: number, fileIds: number[]) => invoke<void>("add_playlist_files", { id, fileIds }),
  addTags: (id: number, tagIds: number[]) => invoke<number>("add_playlist_tags", { id, tagIds }),
  addRef: (id: number, refId: number) => invoke<number>("add_playlist_ref", { id, refId }),
  removeItem: (itemId: number) => invoke<void>("remove_playlist_item", { itemId }),
  moveItem: (itemId: number, index: number) => invoke<void>("move_playlist_item", { itemId, index }),
  setItemMode: (itemId: number, mode: PlayMode) => invoke<void>("set_playlist_item_mode", { itemId, mode }),
  /** 空なら外す */
  setItemAlias: (itemId: number, alias: string) => invoke<void>("set_playlist_item_alias", { itemId, alias }),
  expand: (id: number, mode: PlayMode) => invoke<PlayEntry[]>("expand_playlist", { id, mode }),
};
