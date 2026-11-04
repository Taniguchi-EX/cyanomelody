import { open, save, type OpenDialogOptions, type SaveDialogOptions } from "@tauri-apps/plugin-dialog";

declare global {
  interface Window {
    /** 画面テストで、ダイアログで選んだことにするパス（null はキャンセル） */
    __dialogReply?: string | null;
  }
}

/** フォルダ・ファイルを1つ選ぶOSのダイアログ。キャンセルしたら null。
 *  OSのダイアログは画面テストから操作できず、Tauri の呼び出しもテストからは差し替えられないため、
 *  テストが window.__dialogReply を決めているときは、ダイアログを開かずにそれを返す */
export async function pickPath(options: Omit<OpenDialogOptions, "multiple">): Promise<string | null> {
  if (window.__dialogReply !== undefined) return window.__dialogReply;
  const selected = await open({ ...options, multiple: false });
  return typeof selected === "string" ? selected : null;
}

/** 保存先のファイルを選ぶOSのダイアログ。キャンセルしたら null（画面テストでは window.__dialogReply を返す） */
export async function pickSavePath(options: SaveDialogOptions): Promise<string | null> {
  if (window.__dialogReply !== undefined) return window.__dialogReply;
  return await save(options);
}
