import { playlistApi } from "../api";
import { PlaylistEditor } from "../components/PlaylistEditor";
import { EffectManager } from "../components/EffectManager";
import { CreditForm } from "../components/CreditForm";
import { TagDetail } from "../components/TagDetail";
import { UpdateDialog } from "../components/UpdateDialog";
import { AutotagDialog } from "../components/AutotagDialog";
import { DeleteDialog } from "../components/DeleteDialog";
import { SettingsDialog } from "../components/SettingsDialog";
import type { AppController } from "../hooks/useAppController";

/** 重ねて出す画面：プレイリストの編集、エフェクトセットの管理、削除・タグ付けの確認、設定、アップデート、タグの詳細、出典・ライセンスの編集 */
export function Overlays({ c }: { c: AppController }) {
  const {
    tags,
    busy,
    licenseTypes,
    creditForm,
    setCreditForm,
    setTagDetailId,
    tagDetail,
    chains,
    playlists,
    showError,
    showInfo,
    playlistEditor,
    editor,
    audio,
    reloadAll,
    settingsOpen,
    setSettingsOpen,
    showSettingsError,
    update,
    jobs,
    tagActions,
    creditActions,
    playlistActions,
    playlistName,
    playback,
    effectActions,
    effectDialog,
    fileOps,
  } = c;
  return (
    <>
      {editor && playlistEditor.detail && (
        <PlaylistEditor
          key={`${editor.id}:${editor.seq}`}
          detail={playlistEditor.detail}
          playlists={playlists}
          tags={tags}
          busy={busy}
          // エフェクトの管理画面を重ねているときの Esc は、そちらだけを閉じる
          onClose={() => !effectDialog && playlistEditor.close()}
          onRename={(name) => playlistActions.renamePlaylist(editor.id, name)}
          onPlay={() => playback.playFromEditor(editor.id)}
          onPlayItem={playback.playPlaylistItem}
          onRemoveItem={playlistActions.removePlaylistItem}
          onMoveItem={playlistActions.movePlaylistItem}
          onSetMode={playlistActions.setPlaylistItemMode}
          initialItemId={editor.itemId}
          initialOpenChain={editor.openChain}
          playingItemId={
            audio.player && audio.player.sourceId === editor.id ? (audio.player.queue[audio.player.index]?.itemId ?? null) : null
          }
          chains={chains}
          onSetChain={(items, chainId) => effectActions.setItemsChain(items.map((i) => i.id), chainId)}
          onOpenEffects={effectActions.openForItems}
          onRemoveItems={playlistActions.removePlaylistItems}
          onSetAlias={playlistActions.setPlaylistItemAlias}
          onAddTags={playlistActions.addTagsToPlaylist}
          onAddRef={playlistActions.addRefToPlaylist}
          onExport={(dest, items) => playlistActions.exportPlaylist(editor.id, items, dest)}
          onExportMetadata={(items) =>
            fileOps.exportMetadata(playlistName(editor.id), () => playlistApi.drawItemFiles(editor.id, items))
          }
          onBrowseFolder={playlistActions.browseFolder}
          onError={showError}
        />
      )}
      {effectDialog && (
        <EffectManager
          chains={chains}
          busy={busy}
          initialChainId={effectDialog.chainId}
          startNew={effectDialog.chainId === null}
          onCreated={effectActions.attachCreatedChain}
          previewFileName={effectDialog.target?.relPath ?? null}
          onCreate={effectActions.createChain}
          onRename={effectActions.renameChain}
          onDelete={effectActions.deleteChain}
          onSave={effectActions.saveChain}
          onPreview={effectActions.previewChain}
          previewing={audio.previewId !== null && audio.previewId === effectDialog.target?.id}
          onStopPreview={audio.stopPreview}
          onClose={effectActions.closeDialog}
        />
      )}
      {fileOps.deleteDialog && (
        <DeleteDialog
          permanent={fileOps.deleteDialog.permanent}
          files={fileOps.deleteDialog.files}
          onConfirm={fileOps.confirmDelete}
          onClose={fileOps.cancelDelete}
        />
      )}
      {fileOps.autotagDialog && (
        <AutotagDialog
          count={fileOps.autotagDialog.fileIds.length}
          single={fileOps.autotagDialog.single}
          onConfirm={fileOps.runAutotag}
          onClose={fileOps.closeAutotag}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onError={showSettingsError}
          onImported={(r) => {
            showInfo("データを取り込みました");
            reloadAll().catch(showError);
            if (r.foldersAdded.length > 0 || r.foldersScanned > 0) jobs.startHashing();
          }}
        />
      )}
      {update.version && (
        <UpdateDialog
          version={update.version}
          busy={update.updating}
          installerOpened={update.installerOpened}
          onUpdate={update.install}
          onLater={update.later}
          onError={showError}
          onSkip={update.skip}
        />
      )}
      {tagDetail && (
        <TagDetail
          tag={tagDetail}
          parent={tags.find((t) => t.id === tagDetail.parentId) ?? null}
          busy={busy}
          tags={tags}
          onSubmit={(name, settings, synonyms) => tagActions.saveTagDetail(tagDetail, name, settings, synonyms)}
          onClose={() => setTagDetailId(null)}
        />
      )}
      {creditForm && (
        <CreditForm
          kind={creditForm.kind}
          credit={creditForm.credit}
          licenseTypes={licenseTypes}
          busy={busy}
          onSubmit={(input) =>
            creditForm.credit
              ? creditActions.updateCredit(creditForm.kind, creditForm.credit, input)
              : creditActions.createCredit(creditForm.kind, input)
          }
          onClose={() => setCreditForm(null)}
        />
      )}
    </>
  );
}
