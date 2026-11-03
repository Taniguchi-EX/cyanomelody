/** パスの最後の名前（フォルダ名・ファイル名） */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** 拡張子を除いたファイル名（パスは含めない）。曲名がないときの名前に使う */
export const stem = (path: string) => baseName(path).replace(/\.[^.]+$/, "");
