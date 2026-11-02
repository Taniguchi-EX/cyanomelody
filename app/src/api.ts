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
};

export type FileFilter = {
  text: string;
  tagIds: number[];
  untaggedOnly: boolean;
  missingOnly: boolean;
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
};

export function describeScan(path: string, r: ScanResult): string {
  const parts = [`${r.found}件`];
  if (r.added) parts.push(`追加 ${r.added}件`);
  if (r.missing) parts.push(`見つからない ${r.missing}件`);
  if (r.restored) parts.push(`戻った ${r.restored}件`);
  return `スキャンしました: ${path}（${parts.join("、")}）`;
}
