import { api, type AudioFile, type LibraryFolder, type LinkOutcome } from "../api";
import { describeScan } from "../statusText";
import { confirmDialog } from "../confirm";
import { pickPath } from "../dialogs";
import type { AppOps } from "./appOps";

/** 「ファイルを紐づける」で選べるファイル（スキャンの対象と同じ拡張子） */
const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "m4a"];

type Params = {
  /** ハッシュ値の計算を始める（フォルダを登録・スキャンした後） */
  startHashing: () => void;
  /** フォルダを登録したとき（取り込んだファイルを整理できるよう、そのフォルダだけを表示する） */
  onFolderAdded: (folderId: number) => void;
  /** 登録を解除したフォルダの絞り込みを外す */
  dropFolderFilter: (folderId: number) => void;
};

/** ライブラリの操作：フォルダの登録・解除・スキャンと、見つからないファイル（リンク切れ）の扱い */
export function useLibraryActions({ run, showInfo, showError }: AppOps, { startHashing, onFolderAdded, dropFolderFilter }: Params) {
  const addFolder = (path: string) =>
    run(async () => {
      const r = await api.addFolder(path);
      showInfo(describeScan(path, r));
      onFolderAdded(r.folderId);
      startHashing();
    });

  /** フォルダを選んで、そのまま登録する */
  const browseAndAddFolder = async () => {
    const path = await pickPath({ directory: true }).catch(showError);
    if (typeof path === "string") await addFolder(path);
  };

  const removeFolder = async (folder: LibraryFolder) => {
    const message =
      `「${folder.path}」の登録を解除しますか？\n` +
      `このフォルダのファイル${folder.fileCount}件の情報と、付けたタグ・出典・ライセンスの設定がアプリから消えます。\n` +
      "実際のファイルは消えません。";
    if (!(await confirmDialog(message))) return;
    run(async () => {
      await api.removeFolder(folder.id);
      dropFolderFilter(folder.id);
      showInfo(`登録を解除しました: ${folder.path}`);
    });
  };

  /** フォルダをスキャンし直す。読めなかったフォルダがあれば、そのエラーを出す */
  const scan = (targets: LibraryFolder[]) =>
    run(async () => {
      const messages: string[] = [];
      const errors: string[] = [];
      for (const f of targets) {
        try {
          messages.push(describeScan(f.path, await api.scanFolder(f.id)));
        } catch (e) {
          errors.push(String(e));
        }
      }
      if (errors.length) showError(errors.join(" / "));
      else showInfo(messages.join(" / "));
      startHashing();
    });

  /** 結び付けの結果を出す。フォルダを登録したときは、ハッシュ値の計算を始める */
  const reportLink = (r: LinkOutcome) => {
    showInfo(
      r.addedFolder
        ? `フォルダ「${r.addedFolder}」をライブラリに登録し、${r.path} にひも付けました`
        : `${r.path} にひも付けました`,
    );
    if (r.addedFolder) startHashing();
  };

  /** リンク切れのファイルを、選んだファイルにひも付ける */
  const linkMissingFile = async (file: AudioFile) => {
    const path = await pickPath({ filters: [{ name: "音声ファイル", extensions: AUDIO_EXTENSIONS }] }).catch(showError);
    if (typeof path !== "string") return;
    run(async () => reportLink(await api.linkMissingFile(file.id, path)));
  };

  /** リンク切れのファイルと同じ音声のファイルを、選んだフォルダから探してひも付ける */
  const findMissingInFolder = async (file: AudioFile) => {
    const folder = await pickPath({ directory: true }).catch(showError);
    if (typeof folder !== "string") return;
    run(async () => {
      const r = await api.findMissingInFolder(file.id, folder);
      if (r) reportLink(r);
      else showInfo(`同じ音声のファイルは見つかりませんでした: ${folder}`);
    });
  };

  /** チェックしたリンク切れのファイルそれぞれと同じ音声のファイルを、選んだフォルダからまとめて探してひも付ける */
  const findManyInFolder = async (ids: number[]) => {
    const folder = await pickPath({ directory: true }).catch(showError);
    if (typeof folder !== "string") return;
    run(async () => {
      const r = await api.findMissingInFolderMany(ids, folder);
      const parts = [`ひも付けた ${r.linked}件`];
      if (r.notFound) parts.push(`見つからなかった ${r.notFound}件`);
      if (r.noHash) parts.push(`ハッシュ値がない ${r.noHash}件`);
      if (r.addedFolder) parts.push(`フォルダ「${r.addedFolder}」をライブラリに登録しました`);
      showInfo(parts.join("、"));
      if (r.addedFolder) startHashing();
    });
  };

  /** ひも付け直す。ids のうち見つからない印のないファイルは何もしない */
  const relink = (ids: number[]) =>
    run(async () => {
      const r = await api.relinkFiles(ids);
      const parts = [`ひも付け直した ${r.relinked}件`];
      if (r.notFound) parts.push(`同じ音声のファイルがない ${r.notFound}件`);
      if (r.ambiguous) parts.push(`候補が複数ある ${r.ambiguous}件`);
      if (r.noHash) parts.push(`ハッシュ値がない ${r.noHash}件`);
      showInfo(parts.join("、"));
    });

  /** 見つからないファイルをライブラリから外す。ids のうち見つからない印のないファイルは外れない */
  const removeMissing = async (ids: number[], count: number) => {
    const message = `見つからないファイル${count}件をライブラリから外しますか？\n付けたタグ・出典・ライセンスの設定も消えます。`;
    if (!(await confirmDialog(message))) return;
    run(async () => {
      const n = await api.removeMissingFiles(ids);
      showInfo(`${n}件をライブラリから外しました`);
    });
  };

  return { browseAndAddFolder, removeFolder, scan, linkMissingFile, findMissingInFolder, findManyInFolder, relink, removeMissing };
}
