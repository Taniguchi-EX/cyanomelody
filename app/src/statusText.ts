/** 処理の結果と進み具合を、一番下の行に出す文にする */
import type { AutotagProgress, ExportProgress, HashProgress, ScanResult } from "./types";

export function describeScan(path: string, r: ScanResult): string {
  const parts = [`${r.found}件`];
  if (r.added) parts.push(`追加 ${r.added}件`);
  if (r.missing) parts.push(`見つからない ${r.missing}件`);
  if (r.restored) parts.push(`戻った ${r.restored}件`);
  return `スキャンしました: ${path}（${parts.join("、")}）`;
}

export function describeHashing(p: HashProgress): string {
  if (p.running) return `ハッシュ値を計算中 ${p.done}/${p.total}`;
  const parts = [`${p.done}件`];
  if (p.failed) parts.push(`計算できなかったファイル ${p.failed}件`);
  return p.cancelled
    ? `ハッシュ値の計算を中止しました（${parts.join("、")}）`
    : `ハッシュ値を計算しました（${parts.join("、")}）`;
}

export function describeExport(p: ExportProgress): string {
  if (p.phone) {
    // スマホへのコピー：消す・写すを合わせて数える
    if (p.running) return `スマホへ写しています ${p.done}/${p.total}`;
    if (p.error) return `スマホへ写せませんでした（${p.error}）: `;
    const parts = [`${p.done - p.failed}件`];
    if (p.failed) parts.push(`写せなかったファイル ${p.failed}件`);
    return `${p.cancelled ? "スマホへのコピーを中止しました" : "スマホへ写しました"}（${parts.join("、")}）: `;
  }
  if (p.running) return `書き出し中 ${p.done}/${p.total}`;
  const parts = [`${p.done - p.failed}件`];
  if (p.failed) parts.push(`書き出せなかったファイル ${p.failed}件`);
  return `${p.cancelled ? "書き出しを中止しました" : "書き出しました"}（${parts.join("、")}）: `;
}

/** 自動タグ付けの進み具合・結果の文 */
export function describeAutotag(p: AutotagProgress): string {
  if (p.running) return `ファイルの情報からタグを付けています ${p.done}/${p.total}`;
  const parts = [`タグを付けたファイル ${p.tagged}件`, `作ったタグ ${p.created}件`];
  if (p.noInfo) parts.push(`情報がなかったファイル ${p.noInfo}件`);
  if (p.failed) parts.push(`読めなかったファイル ${p.failed}件`);
  return `${p.cancelled ? "ファイルの情報からのタグ付けを中止しました" : "ファイルの情報からタグを付けました"}（読んだファイル ${p.done}件、${parts.join("、")}）`;
}
