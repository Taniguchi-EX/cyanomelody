import { convertFileSrc } from "@tauri-apps/api/core";

/** Android で動いているか（Android では、フォルダを SAF で選び、ファイルを SAF のプロトコルで読む） */
export const isAndroid = /Android/.test(navigator.userAgent);

/**
 * 音のファイルの場所から、audio 要素に渡す URL を作る。
 * Android は、アプリのプロトコル `cm-media`（SAF のファイルとエフェクトの音を、CORS のヘッダー付きで返す。src-tauri の media_protocol.rs）で読む。
 * プラグインのプロトコルやアセットのプロトコルでは、音を Web Audio に通すと無音にされる（リアルタイムエフェクトで通す）。
 * Windows は、アセットのプロトコルで読む
 */
export const mediaSrc = (path: string) => (isAndroid ? convertFileSrc(path, "cm-media") : convertFileSrc(path));
