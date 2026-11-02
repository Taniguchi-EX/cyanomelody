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
};

export type FileFilter = {
  text: string;
  tagIds: number[];
  untaggedOnly: boolean;
  missingOnly: boolean;
  duplicatesOnly: boolean;
  hash: string | null;
};

export type Tag = {
  id: number;
  name: string;
  fileCount: number;
};

export const api = {
  listFolders: () => invoke<LibraryFolder[]>("list_folders"),
  addFolder: (path: string) => invoke<ScanResult>("add_folder", { path }),
  removeFolder: (folderId: number) => invoke<void>("remove_folder", { folderId }),
  scanFolder: (folderId: number) => invoke<ScanResult>("scan_folder", { folderId }),
  listFiles: (filter: FileFilter) => invoke<AudioFile[]>("list_files", { filter }),
  listTags: () => invoke<Tag[]>("list_tags"),
  addTag: (fileIds: number[], name: string) => invoke<number>("add_tag", { fileIds, name }),
  removeTag: (fileIds: number[], tagId: number) => invoke<void>("remove_tag", { fileIds, tagId }),
  removeMissingFiles: (fileIds: number[]) => invoke<number>("remove_missing_files", { fileIds }),
  createTag: (name: string) => invoke<number>("create_tag", { name }),
  renameTag: (tagId: number, name: string, merge: boolean) =>
    invoke<RenameResult>("rename_tag", { tagId, name, merge }),
  deleteTag: (tagId: number) => invoke<void>("delete_tag", { tagId }),
  deleteUnusedTags: () => invoke<number>("delete_unused_tags"),
  startHashing: () => invoke<void>("start_hashing"),
  cancelHashing: () => invoke<void>("cancel_hashing"),
  hashingProgress: () => invoke<HashProgress>("hashing_progress"),
  hashFile: (path: string) => invoke<string>("hash_file", { path }),
  relinkFiles: (fileIds: number[]) => invoke<RelinkResult>("relink_files", { fileIds }),
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
