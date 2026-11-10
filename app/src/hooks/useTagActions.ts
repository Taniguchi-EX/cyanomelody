import { api, type MoveTarget, type Tag, type TagCount, type TagSettings } from "../api";
import { confirmDialog } from "../confirm";
import type { AppOps } from "./appOps";

type Params = {
  tags: Tag[];
  /** 統合・削除で消えたタグの絞り込みを、統合先に置き換える（null なら外す） */
  replaceTagFilter: (from: number, to: number | null) => void;
  /** 右の欄に出しているファイル（なければ空） */
  focusedIds: () => number[];
  /** 一括操作の対象（チェックしたファイルすべて） */
  bulkFileIds: number[];
};

/** タグの操作：タグ自体（作る・詳細・削除・並べ替え）と、ファイルへの付け外し（右の欄・一括操作・ドラッグ） */
export function useTagActions({ run, showInfo }: AppOps, { tags, replaceTagFilter, focusedIds, bulkFileIds }: Params) {
  const createTag = async (name: string) =>
    run(async () => {
      await api.createTag(name);
      showInfo(`タグ「${name.trim()}」を作成しました`);
    });

  /** タグの詳細画面の保存。名前が別のタグと同じなら統合を確認する（統合したときは、並び順と色は保存しない） */
  const saveTagDetail = async (tag: Tag, name: string, settings: TagSettings, synonyms: string[]) => {
    const newName = name.trim();
    // ほかのタグの名前かシノニムと同じ名前にしたときは、そのタグへの統合
    const key = newName.toLowerCase();
    const other = tags.find(
      (t) => t.id !== tag.id && (t.name.toLowerCase() === key || t.synonyms.some((s) => s.toLowerCase() === key)),
    );
    if (
      other &&
      !(await confirmDialog(
        (other.name.toLowerCase() === key
          ? `タグ「${other.name}」が既にあります。`
          : `「${newName}」は、タグ「${other.name}」のシノニムです。`) +
          `\n「${tag.name}」を「${other.name}」に統合しますか？\n` +
          `「${tag.name}」が付いたファイルに「${other.name}」が付き、「${tag.name}」は削除されます。` +
          `\n「${tag.name}」の名前とシノニムは、「${other.name}」のシノニムになります。` +
          "\n子のタグがあれば、統合先の子の最後に移ります。この画面で決めた並び順・色・シノニムは保存しません。",
      ))
    ) {
      return false;
    }
    return run(async () => {
      if (other) {
        const r = await api.renameTag(tag.id, newName, true);
        replaceTagFilter(tag.id, r.tagId);
        showInfo(`タグ「${tag.name}」を「${other.name}」に統合しました`);
        return;
      }
      // シノニムを先に確かめて保存する（重なりがあれば、ほかは変えずにエラーを出す）
      await api.setTagSynonyms(tag.id, synonyms, newName);
      await api.setTagSettings(tag.id, settings);
      if (newName !== tag.name) await api.renameTag(tag.id, newName, false);
      showInfo(`タグ「${newName}」の詳細を保存しました`);
    });
  };

  const deleteTag = async (tag: Tag) => {
    // fileCount は子孫のタグの分を含むので、件数は出さない
    const children = tags.filter((t) => t.parentId === tag.id).length;
    const message =
      `タグ「${tag.name}」を削除しますか？\n付いているファイルから外れます。` +
      (children > 0 ? `\n子のタグ${children}件は、削除したタグの位置に繰り上がります。` : "");
    if (!(await confirmDialog(message))) return;
    run(async () => {
      await api.deleteTag(tag.id);
      replaceTagFilter(tag.id, null);
      showInfo(`タグ「${tag.name}」を削除しました`);
    });
  };

  const moveTag = (tag: Tag, target: MoveTarget) =>
    run(async () => {
      await api.moveTag(tag.id, target);
      showInfo(`タグ「${tag.name}」を移しました`);
    });

  /** 右の欄：表示しているファイルにタグを付ける（まだない名前なら作る） */
  const addTag = async (name: string) =>
    run(async () => {
      await api.addTag(focusedIds(), name);
      showInfo(`タグ「${name.trim()}」を付けました`);
    });

  /** 右の欄：表示しているファイルからタグを外す */
  const removeTag = (tagId: number) =>
    run(async () => {
      await api.removeTag(focusedIds(), tagId);
      showInfo("タグを外しました");
    });

  /** 一括操作：対象のファイルすべてに、タグを付ける（まだない名前なら作る） */
  const bulkAddTag = async (name: string) =>
    run(async () => {
      await api.addTag(bulkFileIds, name);
      showInfo(`${bulkFileIds.length}件にタグ「${name.trim()}」を付けました`);
    });

  /** 一括操作：対象のファイルすべてから、タグを外す（確認してから） */
  const bulkRemoveTag = async (tag: TagCount) => {
    if (!(await confirmDialog(`対象の${tag.count}件から、タグ「${tag.name}」を外しますか？`))) return;
    run(async () => {
      await api.removeTag(bulkFileIds, tag.id);
      showInfo(`${tag.count}件からタグ「${tag.name}」を外しました`);
    });
  };

  /** ファイルの行をタグに落としたとき。外しやすいので、プレイリストへの追加と同じく確認しない */
  const addTagByDrop = (tagId: number, fileIds: number[]) => {
    const tag = tags.find((t) => t.id === tagId);
    if (!tag) return;
    run(async () => {
      await api.addTag(fileIds, tag.name);
      showInfo(`${fileIds.length}件にタグ「${tag.name}」を付けました`);
    });
  };

  return { createTag, saveTagDetail, deleteTag, moveTag, addTag, removeTag, bulkAddTag, bulkRemoveTag, addTagByDrop };
}
