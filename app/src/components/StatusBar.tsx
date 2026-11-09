import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  describeAutotag,
  describeExport,
  describeHashing,
  playlistApi,
  type AutotagProgress,
  type ExportProgress,
  type HashProgress,
} from "../api";

export type Status = { text: string; error: boolean };

type Props = {
  status: Status;
  busy: boolean;
  /** 終わった処理の数。画面テストが、処理が終わったことを知るのに使う（data-run-count） */
  runCount: number;
  /** 一覧を読み直した回数。画面テストが、絞り込みを変えた後の一覧を待つのに使う（data-list-version） */
  listVersion: number;
  fileCount: number;
  checkedCount: number;
  shownChecked: number;
  /** プレイリストを選んでいる：一覧は行（曲）の数、チェックはファイルの数なので、単位を「曲」「ファイル」にして分ける */
  songs: boolean;
  exportProgress: ExportProgress | null;
  hashProgress: HashProgress | null;
  autotagProgress: AutotagProgress | null;
  onError: (e: unknown) => void;
};

/** ウィンドウの一番下の行。処理の結果、一覧とチェックの件数、裏で行う処理（書き出し・ハッシュ値の計算）の進み具合 */
export function StatusBar({
  status,
  busy,
  runCount,
  listVersion,
  fileCount,
  checkedCount,
  shownChecked,
  songs,
  exportProgress,
  hashProgress,
  autotagProgress,
  onError,
}: Props) {
  return (
    <div className="status-bar">
      <div className={`status${status.error ? " error" : ""}`} data-testid="status" data-run-count={runCount}>
        {busy ? "処理中…" : status.text || " "}
      </div>
      {/* 一覧の件数と、チェックしている件数（0件のときも常に出す） */}
      <div className="counts" data-testid="counts" data-list-version={listVersion}>
        <span data-testid="file-count">
          {fileCount}
          {songs ? "曲" : "件"}
        </span>
        <span className="checked-count" data-testid="checked-count">
          {songs
            ? `チェック ${checkedCount}ファイル（表示中 ${shownChecked}ファイル）`
            : `チェック ${checkedCount}件（表示中 ${shownChecked}件）`}
        </span>
      </div>
      {exportProgress && (
        <div className="hash-status" data-testid="export-status">
          {describeExport(exportProgress)}
          {/* 書き出したフォルダは、押すとエクスプローラーで見せる（渡すときに探さなくてよい） */}
          {!exportProgress.running && (
            <a
              href="#"
              className="folder-link"
              title="エクスプローラーで見せる"
              data-testid="export-folder"
              onClick={(e) => {
                e.preventDefault();
                revealItemInDir(exportProgress.folder).catch(onError);
              }}
            >
              {exportProgress.folder}
            </a>
          )}
          {exportProgress.running && <button onClick={() => playlistApi.cancelExport().catch(onError)}>中止</button>}
        </div>
      )}
      {autotagProgress && (
        <div className="hash-status" data-testid="autotag-status">
          {describeAutotag(autotagProgress)}
          {autotagProgress.running && <button onClick={() => api.cancelAutotag().catch(onError)}>中止</button>}
        </div>
      )}
      {hashProgress && (
        <div className="hash-status" data-testid="hash-status">
          {describeHashing(hashProgress)}
          {hashProgress.running && <button onClick={() => api.cancelHashing().catch(onError)}>中止</button>}
        </div>
      )}
    </div>
  );
}
