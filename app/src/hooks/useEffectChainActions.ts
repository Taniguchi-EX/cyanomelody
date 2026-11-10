import { useState } from "react";
import { playlistApi, type PlaylistItem } from "../api";
import { confirmDialog } from "../confirm";
import { chainApi, type Effect, type EffectChain } from "../effects";
import type { AppOps } from "./appOps";
import type { PreviewTarget } from "./useAudioPlayer";

/**
 * エフェクトセットの管理画面。開いた元の項目（作ったエフェクトセットを設定する項目）と、試聴するファイル。
 * fx のプルダウンの「新しいfxを作る」「このfxを編集」と、再生の欄のエフェクトセットから開く
 */
export type EffectDialogState = {
  target: PreviewTarget | null;
  itemIds: number[];
  /** 選んだ状態で開くエフェクトセット。null なら「新しいfxを作る」から開いた（保存していない新しいエフェクトセットを出す） */
  chainId: number | null;
  /** 再生の欄から開いた（作ったエフェクトセットを、再生の欄のエフェクトセットに選ぶ） */
  forPlayer: boolean;
};

type Params = {
  /** 試聴を鳴らす（再生のフックの previewPath） */
  previewPath: (file: PreviewTarget, path: string) => void;
  /** 再生の欄のエフェクトセットを選ぶ */
  setBaseChain: (chainId: number | null) => void;
  /** 鳴らしているファイル（再生の欄から開いた管理画面で試聴する） */
  playingTarget: PreviewTarget | null;
};

/** エフェクトセットの操作：管理画面を開く、作る・名前・削除・保存・試聴、プレイリストの項目への設定 */
export function useEffectChainActions({ run, showInfo, showError }: AppOps, { previewPath, setBaseChain, playingTarget }: Params) {
  const [dialog, setDialog] = useState<EffectDialogState | null>(null);

  const createChain = async (name: string) => {
    let id: number | null = null;
    await run(async () => {
      id = await chainApi.create(name);
      showInfo(`エフェクトセット「${name.trim()}」を作りました`);
    });
    return id;
  };

  const renameChain = async (chain: EffectChain, name: string) =>
    run(async () => {
      await chainApi.rename(chain.id, name);
      showInfo(`エフェクトセットの名前を「${name.trim()}」に変えました`);
    });

  const deleteChain = async (chain: EffectChain) => {
    let message = `エフェクトセット「${chain.name}」を削除しますか？`;
    if (chain.itemCount > 0) message += `\n結び付けているプレイリストの項目${chain.itemCount}件から外れます。`;
    if (!(await confirmDialog(message))) return;
    await run(async () => {
      await chainApi.remove(chain.id);
      showInfo(`エフェクトセット「${chain.name}」を削除しました`);
    });
  };

  const saveChain = async (chain: EffectChain, effects: Effect[]) =>
    run(async () => {
      await chainApi.setEffects(chain.id, effects);
      showInfo(`エフェクトセット「${chain.name}」を保存しました`);
    });

  /** 管理画面を開いた元の項目の曲に、エフェクトをかけて試聴する */
  const previewChain = async (effects: Effect[]) => {
    const file = dialog?.target;
    if (!file) return;
    showInfo(`試聴の準備中: ${file.relPath}`);
    try {
      const path = await chainApi.preview(file.id, effects);
      previewPath(file, path);
      showInfo(`試聴中: ${file.relPath}`);
    } catch (e) {
      showError(e);
    }
  };

  /** 項目（チェックした項目なら、チェックした項目すべて）にエフェクトセットを付ける。null なら外す */
  const setItemsChain = (itemIds: number[], chainId: number | null) =>
    run(async () => {
      for (const id of itemIds) await chainApi.setItemChain(id, chainId);
      if (itemIds.length > 1) showInfo(`${itemIds.length}件の項目の fx を変えました`);
    });

  /**
   * 編集画面の fx のプルダウンから、管理画面を開く。試聴するのは、その項目の曲（タグの組み合わせ・プレイリストの項目は中の最初の曲）。
   * chainId を選んだ状態で開き、作ったエフェクトセットは itemIds の項目に付ける
   */
  const openForItems = async (item: PlaylistItem, chainId: number | null, itemIds: number[]) => {
    // 項目の曲を読めないときは、試聴できない状態で開く（管理画面は使える）
    const first = (await playlistApi.itemFiles(item.id).catch(() => []))[0];
    const target = first ? { id: first.fileId, relPath: first.relPath, path: first.path } : null;
    setDialog({ target, itemIds, chainId, forPlayer: false });
  };

  /** 再生の欄のエフェクトセットから、管理画面を開く。試聴するのは鳴らしているファイル */
  const openForPlayer = (chainId: number | null) => setDialog({ target: playingTarget, itemIds: [], chainId, forPlayer: true });

  /** 管理画面で作ったエフェクトセットを、開いた元の項目（再生の欄から開いたなら、再生の欄）に付ける */
  const attachCreatedChain = (chainId: number) => {
    if (dialog?.forPlayer) setBaseChain(chainId);
    const ids = dialog?.itemIds ?? [];
    if (ids.length > 0) setItemsChain(ids, chainId);
  };

  return {
    dialog,
    closeDialog: () => setDialog(null),
    openForItems,
    openForPlayer,
    createChain,
    renameChain,
    deleteChain,
    saveChain,
    previewChain,
    setItemsChain,
    attachCreatedChain,
  };
}
