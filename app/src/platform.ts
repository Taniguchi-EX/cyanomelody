import { convertFileSrc } from "@tauri-apps/api/core";

/** Android で動いているか（Android では、フォルダを SAF で選び、ファイルを SAF のプロトコルで読む） */
export const isAndroid = /Android/.test(navigator.userAgent);

/**
 * 音のファイルの場所から、audio 要素に渡す URL を作る。
 * SAF のファイル（場所が FsUri の JSON）はプラグインのプロトコル、それ以外（パス）はアセットのプロトコルで読む
 */
export const mediaSrc = (path: string) =>
  path.startsWith("{") ? convertFileSrc(path, "android-fs-content") : convertFileSrc(path);
