/** パスの最後の名前（フォルダ名・ファイル名） */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** 拡張子を除いたファイル名（パスは含めない）。曲名がないときの名前に使う */
export const stem = (path: string) => baseName(path).replace(/\.[^.]+$/, "");

/** 今日の日付（YYYYMMDD）。書き出すファイル・フォルダの名前に使う */
export function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 一覧などに出すファイル名（パスの最後）。hideExtension なら拡張子を省く（設定画面の「表示」） */
export const displayFileName = (path: string, hideExtension: boolean) => (hideExtension ? stem(path) : baseName(path));
