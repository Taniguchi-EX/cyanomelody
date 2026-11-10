import { api, type Credit, type CreditInput, type CreditKind, type MoveTarget } from "../api";
import { confirmDialog } from "../confirm";
import { CREDIT_LABEL } from "../credits";
import type { AppOps } from "./appOps";

type Params = {
  sources: Credit[];
  licenses: Credit[];
  /** 削除した出典・ライセンスの絞り込みを外す */
  dropCreditFilter: (kind: CreditKind, id: number) => void;
  /** 右の欄に出しているファイル（なければ空） */
  focusedIds: () => number[];
  /** 一括操作の対象（チェックしたファイルすべて） */
  bulkFileIds: number[];
};

/** 出典・ライセンスの操作：出典・ライセンス自体（作る・直す・削除・並べ替え）と、ファイルへの設定（右の欄・一括操作・ドラッグ） */
export function useCreditActions({ run, showInfo }: AppOps, { sources, licenses, dropCreditFilter, focusedIds, bulkFileIds }: Params) {
  const creditsOf = (kind: CreditKind) => (kind === "source" ? sources : licenses);

  const createCredit = async (kind: CreditKind, input: CreditInput) =>
    run(async () => {
      await api.createCredit(kind, input);
      showInfo(`${CREDIT_LABEL[kind]}「${input.name.trim()}」を作成しました`);
    });

  const updateCredit = async (kind: CreditKind, credit: Credit, input: CreditInput) =>
    run(async () => {
      await api.updateCredit(kind, credit.id, input);
      showInfo(`${CREDIT_LABEL[kind]}「${input.name.trim()}」を保存しました`);
    });

  const deleteCredit = async (kind: CreditKind, credit: Credit) => {
    const label = CREDIT_LABEL[kind];
    const message =
      `${label}「${credit.name}」を削除しますか？\n` + `設定されているファイル${credit.fileCount}件は「${label}なし」になります。`;
    if (!(await confirmDialog(message))) return;
    run(async () => {
      await api.deleteCredit(kind, credit.id);
      dropCreditFilter(kind, credit.id);
      showInfo(`${label}「${credit.name}」を削除しました`);
    });
  };

  const moveCredit = (kind: CreditKind, credit: Credit, target: MoveTarget) =>
    run(async () => {
      await api.moveCredit(kind, credit.id, target);
      showInfo(`${CREDIT_LABEL[kind]}「${credit.name}」を移しました`);
    });

  /** 右の欄：表示しているファイルに設定する（まだない名前なら作る） */
  const setFileCredit = async (kind: CreditKind, name: string) =>
    run(async () => {
      await api.setFileCredit(kind, focusedIds(), name);
      showInfo(`${CREDIT_LABEL[kind]}「${name.trim()}」を設定しました`);
    });

  /** 右の欄：表示しているファイルの設定を外す */
  const clearFileCredit = (kind: CreditKind) =>
    run(async () => {
      await api.setFileCredit(kind, focusedIds(), null);
      showInfo(`${CREDIT_LABEL[kind]}を外しました`);
    });

  /** 一括操作：対象のファイルすべてに出典・ライセンスを設定する（null なら外す） */
  const bulkSetCredit = (kind: CreditKind, name: string | null) =>
    run(async () => {
      await api.setFileCredit(kind, bulkFileIds, name);
      showInfo(
        name
          ? `${bulkFileIds.length}件に${CREDIT_LABEL[kind]}「${name.trim()}」を設定しました`
          : `${bulkFileIds.length}件の${CREDIT_LABEL[kind]}を外しました`,
      );
    });

  /** ファイルの行を出典・ライセンスに落としたとき。設定済みなら置き換わる。確認はしない */
  const setCreditByDrop = (kind: CreditKind, creditId: number, fileIds: number[]) => {
    const credit = creditsOf(kind).find((c) => c.id === creditId);
    if (!credit) return;
    run(async () => {
      await api.setFileCredit(kind, fileIds, credit.name);
      showInfo(`${fileIds.length}件に${CREDIT_LABEL[kind]}「${credit.name}」を設定しました`);
    });
  };

  return { creditsOf, createCredit, updateCredit, deleteCredit, moveCredit, setFileCredit, clearFileCredit, bulkSetCredit, setCreditByDrop };
}
