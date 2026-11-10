import { useState } from "react";
import { api } from "../api";
import { pickJsonSavePath, pickPath } from "../dialogs";
import { todayStamp } from "../paths";
import type { AppOps } from "./appOps";
import { EMPTY_FILTER } from "./useFileFilter";

/** ファイルの削除の確認（permanent はごみ箱に移せなかったファイルを完全に消す確認） */
export type DeleteDialogState = {
  permanent: boolean;
  files: { id: number; relPath: string; reason?: string }[];
};

/** ファイルの情報からのタグ付けの確認（対象のファイル。single はファイルの詳細から開いた） */
export type AutotagDialogState = { fileIds: number[]; single: boolean };

type Params = {
  /** 一括操作の対象（チェックしたファイルすべて） */
  bulkFileIds: number[];
  /** 鳴らしているファイル（消す前に止める） */
  playingFileId: number | null;
  /** 再生と試聴を止める */
  stopPlaying: () => void;
};

/** ファイルへの操作のうち、確認のダイアログや保存先を選ぶもの：削除、ファイルの情報からのタグ付け、書き出し */
export function useFileOperations({ run, showInfo, showError }: AppOps, { bulkFileIds, playingFileId, stopPlaying }: Params) {
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);
  const [autotagDialog, setAutotagDialog] = useState<AutotagDialogState | null>(null);

  /** 「ファイルを削除する」：見つかっているファイル（リンク切れは除く）の確認のダイアログを出す */
  const startDelete = async (fileIds: number[]) => {
    try {
      const list = await api.listFiles({ ...EMPTY_FILTER, fileIds });
      const files = list.filter((f) => !f.missing).map((f) => ({ id: f.id, relPath: f.relPath }));
      if (files.length === 0) showInfo("削除できるファイルはありません（リンク切れのファイルは「ライブラリから外す」で外せます）");
      else setDeleteDialog({ permanent: false, files });
    } catch (e) {
      showError(e);
    }
  };

  /** 削除の確認で「削除する」「完全に削除する」。鳴らしているファイルなら先に止める。ごみ箱に移せなかったものは、完全に消すか聞く */
  const confirmDelete = () => {
    if (!deleteDialog) return;
    const { permanent, files } = deleteDialog;
    const ids = files.map((f) => f.id);
    setDeleteDialog(null);
    if (playingFileId !== null && ids.includes(playingFileId)) stopPlaying();
    run(async () => {
      const r = await api.deleteFiles(ids, permanent);
      const done = permanent ? `${r.deleted}件を完全に削除しました` : `${r.deleted}件を削除しました（ごみ箱に移しました）`;
      showInfo(r.failed.length > 0 ? `${done}。${r.failed.length}件は削除できませんでした` : done);
      if (!permanent && r.failed.length > 0) setDeleteDialog({ permanent: true, files: r.failed });
    });
  };

  /** 削除の確認を閉じる（完全に消す確認なら、消さなかったことを出す） */
  const cancelDelete = () => {
    if (deleteDialog?.permanent) showInfo(`${deleteDialog.files.length}件は削除していません`);
    setDeleteDialog(null);
  };

  /** 自動タグ付けの確認のダイアログで「タグを付ける」 */
  const runAutotag = (ignore: boolean, split: boolean) => {
    if (!autotagDialog) return;
    const { fileIds, single } = autotagDialog;
    setAutotagDialog(null);
    if (single) {
      run(async () => {
        const r = await api.autotagFile(fileIds[0], ignore, split);
        if (!r.readable) showInfo("ファイルを読めませんでした");
        else if (r.added.length > 0) showInfo(`${r.added.map((a) => `${a.field}：${a.name}`).join("、")} を付けました`);
        else showInfo(r.hasInfo ? "付けるタグはもう付いています" : "ファイルの中に、タグにできる情報はありませんでした");
      });
      return;
    }
    api.startAutotag(fileIds, ignore, split).catch(showError);
  };

  /**
   * ファイルのメタデータを、データのエクスポートと同じ形の JSON に書き出す（保存先を選ぶ）。
   * fileIds が関数なら、保存先を選んだ後に呼んで対象を決める（プレイリストの曲など）
   */
  const exportMetadata = async (name: string, fileIds: number[] | (() => Promise<number[]>)) => {
    const path = await pickJsonSavePath(name).catch(showError);
    if (!path) return;
    run(async () => {
      const ids = typeof fileIds === "function" ? await fileIds() : fileIds;
      const n = await api.exportMetadata(path, ids);
      showInfo(`${n}件のファイルのメタデータを書き出しました: ${path}`);
    });
  };

  /** 一括操作：対象のファイルを、選んだフォルダの中に作るフォルダへそのままコピーし始める */
  const exportCheckedFiles = async () => {
    const dest = await pickPath({ directory: true }).catch(showError);
    if (typeof dest !== "string") return;
    try {
      const folder = await api.startExportFiles(bulkFileIds, dest, `cyanomelody-files-${todayStamp()}`);
      showInfo(`書き出しを始めました: ${folder}`);
    } catch (e) {
      showError(e);
    }
  };

  /** 一括操作：対象のファイルのメタデータを書き出す */
  const exportCheckedMetadata = () => exportMetadata(`cyanomelody-files-${todayStamp()}`, bulkFileIds);

  return {
    deleteDialog,
    startDelete,
    confirmDelete,
    cancelDelete,
    autotagDialog,
    openAutotag: (fileIds: number[], single: boolean) => setAutotagDialog({ fileIds, single }),
    closeAutotag: () => setAutotagDialog(null),
    runAutotag,
    exportMetadata,
    exportCheckedFiles,
    exportCheckedMetadata,
  };
}
