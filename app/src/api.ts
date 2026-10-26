// 中核（Rust）のコマンドの呼び出し口と、受け渡す値の型。

import { invoke } from "@tauri-apps/api/core";

/** Rust から返るエラー。`kind` が `offline` ならオフライン、`login` ならログインが必要。 */
export interface UiError {
  kind: "offline" | "login" | "not_found" | "error";
  message: string;
  /** オフラインのとき、代わりに表示できる端末に保存した内容 */
  cached?: unknown;
}

export function isUiError(e: unknown): e is UiError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export function errorMessage(e: unknown): string {
  return isUiError(e) ? e.message : String(e);
}

export interface AppInfo {
  core_version: string;
  device_id: string;
  platform: "desktop" | "mobile";
  can_login: boolean;
  logged_in: boolean;
}

export interface DriveFolder {
  id: string;
  path: string;
}

export interface LocalFolder {
  path: string;
  device_name: string;
}

export interface Settings {
  drive_folder: DriveFolder | null;
  local_folder: LocalFolder | null;
  cache_max_bytes: number;
  cache_used_bytes: number;
  volume: number;
}

export interface Folder {
  id: string;
  name: string;
}

export interface Song {
  source: SourceName;
  key: string;
  relative_path: string;
  title: string;
  artist: string | null;
  album: string | null;
}

export interface Listing {
  folders: string[];
  songs: Song[];
}

export interface Report {
  source: SourceName;
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
  /** タグを読めなかった曲（ファイル名を曲名にした） */
  tag_failures: number;
}

export interface Summary {
  id: string;
  name: string;
  favorite: boolean;
  count: number;
}

export interface Item {
  source: SourceName;
  key: string;
  title: string;
  artist: string | null;
  /** この端末で再生できる（できなければグレーアウト） */
  available: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  favorite: boolean;
  items: Item[];
}

export type SourceName = "drive" | "local";
export type PlayState = "stopped" | "playing" | "paused";

export interface Status {
  state: PlayState;
  index: number | null;
  position: number;
  duration: number | null;
  shuffle: boolean;
  repeat: boolean;
  volume: number;
  playlist_id: string | null;
  playlist_name: string | null;
  title: string | null;
  artist: string | null;
}

export interface LibraryProgress {
  source: SourceName;
  done: number;
  total: number;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  login: () => invoke<void>("drive_login"),
  logout: () => invoke<void>("drive_logout"),
  account: () => invoke<string>("drive_account"),
  driveFolders: (parentId: string) => invoke<Folder[]>("drive_folders", { parentId }),
  settings: () => invoke<Settings>("get_settings"),
  setDriveFolder: (id: string, path: string) => invoke<Settings>("set_drive_folder", { id, path }),
  setLocalFolder: (path: string) => invoke<Settings>("set_local_folder", { path }),
  setCacheMax: (bytes: number) => invoke<void>("set_cache_max", { bytes }),
  localFolders: (path: string) => invoke<string[]>("local_folders", { path }),
  refreshLibrary: () => invoke<Report[]>("refresh_library"),
  browse: (source: SourceName, folder: string) => invoke<Listing>("browse", { source, folder }),
  listPlaylists: () => invoke<Summary[]>("list_playlists"),
  getPlaylist: (id: string) => invoke<Playlist>("get_playlist", { id }),
  createPlaylist: (name: string) => invoke<Playlist>("create_playlist", { name }),
  deletePlaylist: (id: string) => invoke<void>("delete_playlist", { id }),
  renamePlaylist: (id: string, name: string) => invoke<Playlist>("rename_playlist", { id, name }),
  setFavorite: (id: string, favorite: boolean) => invoke<Playlist>("set_favorite", { id, favorite }),
  addFolder: (id: string, source: SourceName, folder: string) =>
    invoke<Playlist>("add_to_playlist", { id, source, folder, key: null }),
  addSong: (id: string, source: SourceName, key: string) =>
    invoke<Playlist>("add_to_playlist", { id, source, folder: null, key }),
  removeItem: (id: string, index: number) => invoke<Playlist>("remove_from_playlist", { id, index }),
  moveItem: (id: string, from: number, to: number) => invoke<Playlist>("move_in_playlist", { id, from, to }),
  play: (id: string, start: number) => invoke<void>("play_playlist", { id, start }),
  command: (command: "play" | "pause" | "stop" | "next" | "prev") => invoke<void>("player_command", { command }),
  seek: (seconds: number) => invoke<void>("player_seek", { seconds }),
  volume: (volume: number) => invoke<void>("player_volume", { volume }),
  shuffle: (shuffle: boolean) => invoke<void>("player_shuffle", { shuffle }),
  repeat: (repeat: boolean) => invoke<void>("player_repeat", { repeat }),
  status: () => invoke<Status>("player_status"),
};

export function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}
