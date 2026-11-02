/** パスの最後の名前（フォルダ名・ファイル名） */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
