/**
 * 確認のダイアログを出し、OKなら true を返す。
 * Tauriのダイアログのプラグインは window.confirm を非同期（Promiseを返す）に置き換えるので、必ず await する。
 */
export async function confirmDialog(message: string): Promise<boolean> {
  return Boolean(await (window.confirm(message) as boolean | Promise<boolean>));
}
