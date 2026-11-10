/** 画面の操作で共通に使うもの。App が作り、操作のフック（use〜Actions）に渡す */
export type AppOps = {
  /**
   * 処理中は操作できないようにし、終わったらデータを読み直す（読み直しが済むまでを処理中とする）。
   * 処理が成功したかを返す（失敗したときはエラーを出して false）
   */
  run: (task: () => Promise<void>) => Promise<boolean>;
  /** 一番下の行に、処理の結果を出す */
  showInfo: (text: string) => void;
  /** 一番下の行に、エラーを出す */
  showError: (e: unknown) => void;
};
