import { invoke } from "@tauri-apps/api/core";
import type {
  AudioFile,
  AutotagFileResult,
  BulkSummary,
  Credit,
  CreditInput,
  CreditKind,
  DataSections,
  DeleteResult,
  ExportSummary,
  Facets,
  FileFilter,
  HashProgress,
  ImportPreview,
  ImportResult,
  LibraryFolder,
  LicenseType,
  LinkOutcome,
  MoveTarget,
  PlayEntry,
  PlayMode,
  PlaylistDetail,
  PlaylistNode,
  RelinkResult,
  RenameResult,
  ScanResult,
  Tag,
  TagSettings,
} from "./types";

/** データの型は types.ts にある（これまでどおり api から読めるようにする） */
export type * from "./types";

/** Rust のコマンドを呼ぶ（ファイル・タグ・出典・ライセンス・データの入出力など） */
export const api = {
  listFolders: () => invoke<LibraryFolder[]>("list_folders"),
  addFolder: (path: string) => invoke<ScanResult>("add_folder", { path }),
  removeFolder: (folderId: number) => invoke<void>("remove_folder", { folderId }),
  scanFolder: (folderId: number) => invoke<ScanResult>("scan_folder", { folderId }),
  listFiles: (filter: FileFilter) => invoke<AudioFile[]>("list_files", { filter }),
  facetCounts: (filter: FileFilter) => invoke<Facets>("facet_counts", { filter }),
  /** 指定したidのうち、ライブラリにあるもの */
  existingFileIds: (fileIds: number[]) => invoke<number[]>("existing_file_ids", { fileIds }),
  /** ファイルを削除する（ごみ箱に移す。permanent なら完全に消す）。削除できたファイルはライブラリから外す */
  deleteFiles: (fileIds: number[], permanent: boolean) => invoke<DeleteResult>("delete_files", { fileIds, permanent }),
  /** 自動タグ付けで無視する値の一覧 */
  metaIgnoreValues: () => invoke<string[]>("meta_ignore_values"),
  setMetaIgnoreValues: (values: string[]) => invoke<void>("set_meta_ignore_values", { values }),
  /** 自動タグ付けの区切り文字の一覧 */
  metaSeparators: () => invoke<string[]>("meta_separators"),
  setMetaSeparators: (values: string[]) => invoke<void>("set_meta_separators", { values }),
  /** ファイル1件に、ファイルの中の情報からタグを付ける */
  autotagFile: (fileId: number, ignore: boolean, split: boolean) =>
    invoke<AutotagFileResult>("autotag_file", { fileId, ignore, split }),
  /** たくさんのファイルの自動タグ付けを裏で始める（進み具合はイベント "autotag-progress"） */
  startAutotag: (fileIds: number[], ignore: boolean, split: boolean) =>
    invoke<void>("start_autotag", { fileIds, ignore, split }),
  cancelAutotag: () => invoke<void>("cancel_autotag"),
  /** 一括操作の欄に出す、対象のファイルの内訳（タグ・プレイリスト・出典・ライセンス・リンク切れ） */
  bulkSummary: (fileIds: number[]) => invoke<BulkSummary>("bulk_summary", { fileIds }),
  listTags: () => invoke<Tag[]>("list_tags"),
  addTag: (fileIds: number[], name: string) => invoke<number>("add_tag", { fileIds, name }),
  removeTag: (fileIds: number[], tagId: number) => invoke<void>("remove_tag", { fileIds, tagId }),
  removeMissingFiles: (fileIds: number[]) => invoke<number>("remove_missing_files", { fileIds }),
  createTag: (name: string) => invoke<number>("create_tag", { name }),
  renameTag: (tagId: number, name: string, merge: boolean) =>
    invoke<RenameResult>("rename_tag", { tagId, name, merge }),
  /** タグのシノニムを置き換える。name はこれから付けるタグの名前（同じものは入れない）。ほかのタグの名前・シノニムと重なればエラー */
  setTagSynonyms: (tagId: number, synonyms: string[], name: string) =>
    invoke<void>("set_tag_synonyms", { tagId, synonyms, name }),
  setTagSettings: (tagId: number, settings: TagSettings) =>
    invoke<void>("set_tag_settings", { tagId, settings }),
  deleteTag: (tagId: number) => invoke<void>("delete_tag", { tagId }),
  moveTag: (tagId: number, target: MoveTarget) => invoke<void>("move_tag", { tagId, target }),
  startHashing: () => invoke<void>("start_hashing"),
  cancelHashing: () => invoke<void>("cancel_hashing"),
  hashingProgress: () => invoke<HashProgress>("hashing_progress"),
  /** 音声ファイルのトラック名（タグ情報のタイトル）。ないときは null */
  trackTitle: (path: string) => invoke<string | null>("track_title", { path }),
  /** データのエクスポート：選んだ項目を path に書き出す。screen は画面の設定 */
  /** OS にインストールされているフォントのファミリ（name は CSS に書く名前、label は一覧に出す名前） */
  listFonts: () => invoke<{ name: string; label: string }[]>("list_fonts"),
  /** 選んだファイルのメタデータを書き出す（データのエクスポートと同じ形）。書き出した曲の数を返す */
  exportMetadata: (path: string, fileIds: number[]) => invoke<number>("export_metadata", { path, fileIds }),
  /** 選んだファイルを、dest の中に作るフォルダ（folderName）へそのままコピーし始め、作ったフォルダのパスを返す。進み具合は "export-progress" */
  startExportFiles: (fileIds: number[], dest: string, folderName: string) =>
    invoke<string>("start_export_files", { fileIds, dest, folderName }),
  exportData: (path: string, sections: DataSections, screen: Record<string, unknown> | null) =>
    invoke<ExportSummary>("export_data", { path, sections, screen }),
  /** インポートの見込み */
  inspectImport: (path: string) => invoke<ImportPreview>("inspect_import", { path }),
  /** データのインポート。replace なら、選んだ項目の今のデータを置き換える */
  importData: (path: string, sections: DataSections, replace: boolean) =>
    invoke<ImportResult>("import_data", { path, sections, replace }),
  /** 新しく作るタグの既定値（設定画面の「一般」） */
  newTagSettings: () => invoke<TagSettings>("new_tag_settings"),
  setNewTagSettings: (settings: TagSettings) => invoke<void>("set_new_tag_settings", { settings }),
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
  /** 見つからないファイルそれぞれと同じ音声のファイルを、フォルダの中からまとめて探してひも付ける */
  findMissingInFolderMany: (fileIds: number[], folder: string) =>
    invoke<{ linked: number; notFound: number; noHash: number; addedFolder: string | null }>("find_missing_in_folder_many", {
      fileIds,
      folder,
    }),
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
  /** 項目1つだけの再生順 */
  expandItem: (itemId: number) => invoke<PlayEntry[]>("expand_playlist_item", { itemId }),
  /** ファイルを項目として直接入れているプレイリストのid */
  withFile: (fileId: number) => invoke<number[]>("playlists_with_file", { fileId }),
  /** 項目に入る曲をすべて（再生方法にかかわらず、順に再生したときの並び） */
  itemFiles: (itemId: number) => invoke<PlayEntry[]>("playlist_item_files", { itemId }),
  /** プレイリストから、そのファイルの項目をすべて外す */
  removeFile: (id: number, fileId: number) => invoke<number>("remove_file_from_playlist", { id, fileId }),
  /** プレイリストから、ファイルの項目をまとめて外す。外した項目の数を返す */
  removeFiles: (id: number, fileIds: number[]) => invoke<number>("remove_files_from_playlist", { id, fileIds }),
  /** dest の中に書き出し始め、作ったフォルダのパスを返す。進み具合は "export-progress" で届く */
  /** rows は抽選した並びの行の番号（中央の一覧に見えている順） */
  /** プレイリストを書き出し始める。items は書き出す項目（直下。空ならすべて）。🎲・🔀の項目は抽選し直す */
  startExport: (id: number, items: number[], dest: string) => invoke<string>("start_export", { id, items, dest }),
  /** 抽選し直して、items の項目（空ならすべて）から来るファイル（メタデータの書き出しの対象） */
  drawItemFiles: (id: number, items: number[]) => invoke<number[]>("draw_item_files", { id, items }),
  /** プレイリストを選んで抽選する */
  select: (id: number) => invoke<void>("select_playlist", { id }),
  clearSelection: () => invoke<void>("clear_playlist_selection"),
  /** 選んでいるプレイリストを抽選し直す */
  redraw: () => invoke<void>("redraw_playlist"),
  /** データを読み直すときに呼ぶ。中身が変わっていれば抽選し直し、消えていれば選択を外す */
  refreshDraw: () => invoke<"unchanged" | "redrawn" | "cleared">("refresh_draw"),
  cancelExport: () => invoke<void>("cancel_export"),
};
