import type { CopyFolderStatus, DataSections, ImportPreview, ImportResult } from "./api";

/** データのエクスポート・インポートと Windows からのコピーで出す、項目の名前と見込み・結果の文言 */

export const SECTIONS: { key: keyof DataSections; label: string }[] = [
  { key: "library", label: "ライブラリ（登録したフォルダ）" },
  { key: "tags", label: "タグ（階層・並び順・色と、曲へのタグ付け）" },
  { key: "playlists", label: "プレイリストとエフェクト" },
  { key: "credits", label: "出典・ライセンスと設定（新しく作るタグの既定値、音量などの画面の設定）" },
];

export const dateText = (seconds: number) => new Date(seconds * 1000).toLocaleString("ja-JP");

/** 項目ごとの、ファイルに入っている件数 */
export function sectionCount(p: ImportPreview, key: keyof DataSections): string {
  switch (key) {
    case "library":
      return `フォルダ ${p.folders}件（このPCにあるもの ${p.foldersFound}件）`;
    case "tags":
      return `タグ ${p.tags}件`;
    case "playlists":
      return `プレイリスト ${p.playlists}件、エフェクトセット ${p.effectChains}件`;
    case "credits":
      return `出典 ${p.sources}件、ライセンス ${p.licenses}件`;
  }
}

/** 「置き換える」で消えるもの */
export function replaceWarnings(p: ImportPreview, s: DataSections): string[] {
  const c = p.current;
  const out: string[] = [];
  if (s.library && c.foldersNotInFile > 0) out.push(`登録を外すフォルダ ${c.foldersNotInFile}件（中の曲のタグなども消えます）`);
  if (s.tags) {
    out.push(
      `タグ ${c.tags}件（曲へのタグ付けも消えます` +
        (s.playlists ? "）" : "。プレイリストのタグの組み合わせの項目からも外れます）"),
    );
  }
  if (s.playlists) out.push(`プレイリスト ${c.playlists}件、エフェクトセット ${c.effectChains}件`);
  if (s.credits) out.push(`出典 ${c.sources}件、ライセンス ${c.licenses}件（曲への設定も消えます）`);
  return out;
}

export function resultLines(r: ImportResult, s: DataSections): string[] {
  const lines: string[] = [];
  if (s.library) {
    lines.push(
      `フォルダ：登録 ${r.foldersAdded.length}件` +
        (r.foldersSkipped ? `、このPCにないため飛ばした ${r.foldersSkipped}件` : "") +
        (r.foldersRemoved ? `、登録を外した ${r.foldersRemoved}件` : ""),
    );
  }
  lines.push(`曲：見つかった ${r.filesMatched}件、見つからなかった ${r.filesUnmatched}件`);
  if (s.tags) lines.push(`タグ：作った ${r.tagsAdded}件、タグ付け ${r.fileTagsAdded}件`);
  if (s.playlists) {
    lines.push(
      `プレイリスト：作った ${r.playlistsAdded}件、エフェクトセット ${r.effectChainsAdded}件` +
        (r.itemsSkipped ? `、取り込まなかった項目 ${r.itemsSkipped}件（曲が見つからないなど）` : ""),
    );
  }
  if (s.credits) {
    lines.push(`出典・ライセンス：作った 出典 ${r.sourcesAdded}件・ライセンス ${r.licensesAdded}件、曲への設定 ${r.creditsSet}件`);
    if (r.screen) lines.push("画面の設定（音量など）は、次にアプリを起動したときに反映されます。");
  }
  return lines;
}

/** 新しいデータがあるか（cyanomelody 用のフォルダのデータが、前に取り込んだものより新しい） */
export const hasNewCopy = (s: CopyFolderStatus) =>
  s.readable && s.exportedAt !== null && (s.importedAt === null || s.exportedAt > s.importedAt);
