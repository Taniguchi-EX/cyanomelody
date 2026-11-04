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
  relPath: string;
  /** 絶対パス（再生に使う） */
  path: string;
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
  /** このライブラリフォルダのファイルだけ。null なら絞り込まない */
  folderId: number | null;
  /** 直近で再生したファイルだけ（新しく再生した順に並ぶ） */
  recentOnly: boolean;
  /** 長さ（秒）がこれ以上・以下のファイルだけ（長さのないファイルは出ない）。null なら絞り込まない */
  minDuration: number | null;
  maxDuration: number | null;
  /** 一覧の並び順（絞り込みには使わない）。なければパス順 */
  sort?: FileSort;
  sortDesc?: boolean;
};

/** ファイルの一覧の並び順 */
export type FileSort = "path" | "name" | "added" | "modified" | "duration";

/** ライブラリの並び順のプルダウンの選び肢。同じ値どうしはパス順 */
export const FILE_SORTS: { value: string; sort: FileSort; desc: boolean; label: string }[] = [
  { value: "path", sort: "path", desc: false, label: "パス順" },
  { value: "name", sort: "name", desc: false, label: "ファイル名順" },
  { value: "added-desc", sort: "added", desc: true, label: "追加した順（新しい順）" },
  { value: "added", sort: "added", desc: false, label: "追加した順（古い順）" },
  { value: "modified-desc", sort: "modified", desc: true, label: "更新日時順（新しい順）" },
  { value: "duration", sort: "duration", desc: false, label: "長さ順（短い順）" },
  { value: "duration-desc", sort: "duration", desc: true, label: "長さ順（長い順）" },
];

/** ひも付けた結果。ライブラリに登録したフォルダがあれば、そのパス */
export type LinkOutcome = { path: string; addedFolder: string | null };

/** 絞り込みの各項目を選んだときの件数。0件の項目は入らない */
export type Facets = {
  tags: CountItem[];
  untagged: number;
  /** id が null は「（出典なし）」 */
  sources: CountItem[];
  licenses: CountItem[];
  /** 「その他」の各項目を選んだときの件数 */
  duplicates: number;
  recent: number;
  missing: number;
};

/** 件数の内訳の1項目。id が null は「なし」 */
export type CountItem = { id: number | null; count: number };

/** タグと、そのタグが付いているファイルの数（チェックしたファイルのうち） */
export type TagCount = { id: number; name: string; count: number };

export type Tag = {
  id: number;
  name: string;
  /** 親のタグのid。最上位なら null */
  parentId: number | null;
  /** 階層の深さ。最上位は0 */
  depth: number;
  /** そのタグか子孫のタグが付いたファイルの数 */
  fileCount: number;
  /** 表示に使う色。自分の色がなければ、親（その親…）の色を引き継いだもの */
  shownBgColor: string | null;
  shownFgColor: string | null;
  /** 子のタグを実際に並べる順。親の設定を引き継ぐなら、引き継いだもの */
  shownChildSort: ChildSort;
  shownChildSortDesc: boolean;
} & TagSettings;

/** 子のタグの並び順。manual はドラッグで決めた順 */
export type ChildSort = "manual" | "created" | "files" | "romaji";

/** タグの詳細画面で決めるもの（名前を除く） */
export type TagSettings = {
  /** null は親の設定を引き継ぐ（最上位までたどって決まっていなければ、ドラッグで決めた順） */
  childSort: ChildSort | null;
  childSortDesc: boolean;
  /** 背景色・文字色（#rrggbb）。null は親の色を引き継ぐ */
  bgColor: string | null;
  fgColor: string | null;
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
  /** 指定したidのうち、ライブラリにあるもの */
  existingFileIds: (fileIds: number[]) => invoke<number[]>("existing_file_ids", { fileIds }),
  /** チェックしたファイルに付いているタグと、そのタグが付いている件数 */
  checkedTagCounts: (fileIds: number[]) => invoke<TagCount[]>("checked_tag_counts", { fileIds }),
  listTags: () => invoke<Tag[]>("list_tags"),
  addTag: (fileIds: number[], name: string) => invoke<number>("add_tag", { fileIds, name }),
  removeTag: (fileIds: number[], tagId: number) => invoke<void>("remove_tag", { fileIds, tagId }),
  removeMissingFiles: (fileIds: number[]) => invoke<number>("remove_missing_files", { fileIds }),
  createTag: (name: string) => invoke<number>("create_tag", { name }),
  renameTag: (tagId: number, name: string, merge: boolean) =>
    invoke<RenameResult>("rename_tag", { tagId, name, merge }),
  setTagSettings: (tagId: number, settings: TagSettings) =>
    invoke<void>("set_tag_settings", { tagId, settings }),
  deleteTag: (tagId: number) => invoke<void>("delete_tag", { tagId }),
  moveTag: (tagId: number, target: MoveTarget) => invoke<void>("move_tag", { tagId, target }),
  startHashing: () => invoke<void>("start_hashing"),
  cancelHashing: () => invoke<void>("cancel_hashing"),
  hashingProgress: () => invoke<HashProgress>("hashing_progress"),
  /** 音声ファイルのトラック名（タグ情報のタイトル）。ないときは null */
  trackTitle: (path: string) => invoke<string | null>("track_title", { path }),
  /** 新しい版があれば、その版（開発用のビルドや、探せなかったときは null） */
  checkUpdate: () => invoke<string | null>("check_update"),
  /** 新しい版をダウンロードしてインストールし、アプリを再起動する */
  installUpdate: () => invoke<void>("install_update"),
  relinkFiles: (fileIds: number[]) => invoke<RelinkResult>("relink_files", { fileIds }),
  /** 見つからないファイルを、選んだファイルにひも付ける（ライブラリの外なら、そのファイルのフォルダを登録する） */
  linkMissingFile: (fileId: number, path: string) => invoke<LinkOutcome>("link_missing_file", { fileId, path }),
  /** 見つからないファイルと同じ音声のファイルをフォルダの中から探してひも付ける。見つからなければ null */
  findMissingInFolder: (fileId: number, folder: string) =>
    invoke<LinkOutcome | null>("find_missing_in_folder", { fileId, folder }),
  recordPlay: (fileId: number) => invoke<void>("record_play", { fileId }),
  licenseTypes: () => invoke<LicenseType[]>("license_types"),
  listCredits: (kind: CreditKind) => invoke<Credit[]>("list_credits", { kind }),
  createCredit: (kind: CreditKind, input: CreditInput) => invoke<number>("create_credit", { kind, input }),
  updateCredit: (kind: CreditKind, id: number, input: CreditInput) =>
    invoke<void>("update_credit", { kind, id, input }),
  deleteCredit: (kind: CreditKind, id: number) => invoke<void>("delete_credit", { kind, id }),
  /** 出典・ライセンスの並び順を変える（前・後ろ・最後だけ。階層はない） */
  moveCredit: (kind: CreditKind, id: number, target: MoveTarget) => invoke<void>("move_credit", { kind, id, target }),
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

export const PLAY_MODES: { mode: PlayMode; icon: string; label: string; short: string }[] = [
  { mode: "order", icon: "▶", label: "順に再生", short: "順に" },
  { mode: "shuffle", icon: "🔀", label: "シャッフル再生", short: "シャッフル" },
  { mode: "random", icon: "🎲", label: "ランダムセレクト再生", short: "1曲" },
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
  /** 結び付けたエフェクトセット */
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
  /** かけるエフェクトセットの id（内側から外側の順）。空ならエフェクトなし */
  chains: number[];
  /** この曲を出した、再生したプレイリストの（いちばん外側の）項目。ファイルの一覧の再生では null */
  itemId: number | null;
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
  /** 項目1つだけの再生順 */
  expandItem: (itemId: number) => invoke<PlayEntry[]>("expand_playlist_item", { itemId }),
  /** ファイルを項目として直接入れているプレイリストのid */
  withFile: (fileId: number) => invoke<number[]>("playlists_with_file", { fileId }),
  /** 項目に入る曲をすべて（再生方法にかかわらず、順に再生したときの並び） */
  itemFiles: (itemId: number) => invoke<PlayEntry[]>("playlist_item_files", { itemId }),
  /** プレイリストから、そのファイルの項目をすべて外す */
  removeFile: (id: number, fileId: number) => invoke<number>("remove_file_from_playlist", { id, fileId }),
  /** dest の中に書き出し始め、作ったフォルダのパスを返す。進み具合は "export-progress" で届く */
  startExport: (id: number, dest: string) => invoke<string>("start_export", { id, dest }),
  cancelExport: () => invoke<void>("cancel_export"),
};

/** プレイリストの出力の進み具合 */
export type ExportProgress = {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  cancelled: boolean;
  /** 書き出し先（作ったフォルダ） */
  folder: string;
};

export function describeExport(p: ExportProgress): string {
  if (p.running) return `書き出し中 ${p.done}/${p.total}`;
  const parts = [`${p.done - p.failed}件`];
  if (p.failed) parts.push(`書き出せなかったファイル ${p.failed}件`);
  return `${p.cancelled ? "書き出しを中止しました" : "書き出しました"}（${parts.join("、")}）: `;
}
