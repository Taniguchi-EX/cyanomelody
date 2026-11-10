import { playlistApi, type AudioFile, type MoveTarget, type PlayMode, type PlaylistItem, type PlaylistNode, type TagCount } from "../api";
import { confirmDialog } from "../confirm";
import { pickPath } from "../dialogs";
import type { AppOps } from "./appOps";

type Params = {
  playlists: PlaylistNode[];
  /** 開いている編集画面のプレイリスト（なければ null） */
  editorId: number | null;
  /** 右の欄に出しているファイル */
  focusedFile: AudioFile | null;
  /** 一括操作の対象（チェックしたファイルすべて） */
  bulkFileIds: number[];
};

/** プレイリストの操作：プレイリスト自体（作る・名前・削除・並べ替え）、項目（加える・外す・並べ替え・別名・再生方法）、書き出し */
export function usePlaylistActions({ run, showInfo, showError }: AppOps, { playlists, editorId, focusedFile, bulkFileIds }: Params) {
  const playlistName = (id: number) => playlists.find((p) => p.id === id)?.name ?? "";

  const createPlaylist = async (name: string, parent: number | null = null) =>
    run(async () => {
      await playlistApi.create(name, parent);
      showInfo(`プレイリスト「${name.trim()}」を作りました`);
    });

  const renamePlaylist = async (id: number, name: string) =>
    run(async () => {
      await playlistApi.rename(id, name);
      showInfo(`プレイリストの名前を「${name.trim()}」に変えました`);
    });

  const deletePlaylist = async (id: number) => {
    const node = playlists.find((p) => p.id === id);
    if (!node) return;
    const children = playlists.filter((p) => p.parentId === id).length;
    // 子として持つ親を除いた、参照しているプレイリスト
    const referrers = playlists.filter((p) => p.id !== node.parentId && p.refs.includes(id)).length;
    let message = `プレイリスト「${node.name}」を削除しますか？`;
    if (children > 0) message += `\n子のプレイリスト${children}件は、削除したプレイリストの位置に繰り上がります。`;
    if (referrers > 0) message += `\nこのプレイリストを入れているプレイリスト${referrers}件から外れます。`;
    if (!(await confirmDialog(message))) return;
    await run(async () => {
      await playlistApi.remove(id);
      showInfo(`プレイリスト「${node.name}」を削除しました`);
    });
  };

  const movePlaylist = (id: number, target: MoveTarget) =>
    run(async () => {
      await playlistApi.move(id, target);
      showInfo(`プレイリスト「${playlistName(id)}」を移しました`);
    });

  /** ファイルをプレイリストの最後に加える */
  const addToPlaylist = async (playlistId: number, fileIds: number[]) =>
    run(async () => {
      await playlistApi.addFiles(playlistId, fileIds);
      showInfo(`${fileIds.length}件をプレイリスト「${playlistName(playlistId)}」に追加しました`);
    });

  /** 右の欄のプレイリストのチップの「✕」：そのプレイリストから、このファイルの項目をすべて外す */
  const removeFromPlaylist = (playlistId: number) =>
    focusedFile &&
    run(async () => {
      await playlistApi.removeFile(playlistId, focusedFile.id);
      showInfo(`プレイリスト「${playlistName(playlistId)}」から外しました`);
    });

  /** 一括操作：プレイリストから、対象のファイルの項目を外す（確認してから） */
  const bulkRemoveFromPlaylist = async (p: TagCount) => {
    if (!(await confirmDialog(`プレイリスト「${p.name}」から、対象の${p.count}件を外しますか？`))) return;
    run(async () => {
      await playlistApi.removeFiles(p.id, bulkFileIds);
      showInfo(`プレイリスト「${p.name}」から${p.count}件を外しました`);
    });
  };

  // 編集画面の項目の操作
  const addTagsToPlaylist = async (tagIds: number[]) => {
    if (editorId === null) return false;
    return run(async () => {
      await playlistApi.addTags(editorId, tagIds);
      showInfo("タグの組み合わせを加えました");
    });
  };

  const addRefToPlaylist = (refId: number) =>
    editorId !== null &&
    run(async () => {
      await playlistApi.addRef(editorId, refId);
      showInfo(`プレイリスト「${playlistName(refId)}」を加えました`);
    });

  const removePlaylistItem = (item: PlaylistItem) =>
    run(async () => {
      await playlistApi.removeItem(item.id);
      showInfo(
        item.owned
          ? `子のプレイリスト「${item.playlist?.name}」を外しました（最上位に移りました）`
          : "項目を外しました",
      );
    });

  /** チェックした項目をまとめて外す（確認する） */
  const removePlaylistItems = async (items: PlaylistItem[]) => {
    if (!(await confirmDialog(`チェックした${items.length}件の項目をプレイリストから外しますか？`))) return false;
    return run(async () => {
      for (const item of items) await playlistApi.removeItem(item.id);
      showInfo(`${items.length}件の項目を外しました`);
    });
  };

  const movePlaylistItem = (item: PlaylistItem, index: number) =>
    run(async () => {
      await playlistApi.moveItem(item.id, index);
    });

  const setPlaylistItemAlias = async (item: PlaylistItem, alias: string) =>
    run(async () => {
      await playlistApi.setItemAlias(item.id, alias);
      showInfo(alias.trim() ? `プレイリスト上での名前を「${alias.trim()}」にしました` : "プレイリスト上での名前を外しました");
    });

  const setPlaylistItemMode = (items: PlaylistItem[], mode: PlayMode) =>
    run(async () => {
      for (const item of items) await playlistApi.setItemMode(item.id, mode);
      if (items.length > 1) showInfo(`${items.length}件の項目の再生方法を変えました`);
    });

  /** プレイリストを書き出し始める（items の項目。空ならすべて。🎲・🔀の項目は抽選し直す） */
  const exportPlaylist = async (id: number, items: number[], dest: string) => {
    try {
      const folder = await playlistApi.startExport(id, items, dest);
      showInfo(`書き出しを始めました: ${folder}`);
      return true;
    } catch (e) {
      showError(e);
      return false;
    }
  };

  // 前に書き出したフォルダがもうないなどで開けないときは、最初の場所を決めずに開き直す
  const browseFolder = (defaultPath?: string) =>
    pickPath({ directory: true, defaultPath }).catch(() => pickPath({ directory: true }));

  return {
    playlistName,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    movePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    bulkRemoveFromPlaylist,
    addTagsToPlaylist,
    addRefToPlaylist,
    removePlaylistItem,
    removePlaylistItems,
    movePlaylistItem,
    setPlaylistItemAlias,
    setPlaylistItemMode,
    exportPlaylist,
    browseFolder,
  };
}
