import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { SelectionPanel } from "../components/SelectionPanel";
import { BulkPanel } from "../components/BulkPanel";
import { CreditField } from "../components/CreditField";
import { isAndroid } from "../platform";
import type { AppController } from "../hooks/useAppController";
import { CREDIT_KINDS } from "../credits";

/** 右の欄の中身：一括操作の欄か、ファイルの詳細（Windows の右の欄） */
export function DetailArea({ c }: { c: AppController }) {
  const {
    tags,
    busy,
    licenseTypes,
    playlists,
    bulkOpen,
    dataVersion,
    showError,
    playlistEditor,
    bulkFileIds,
    focusedFile,
    focusedIds,
    showSameAudio,
    tagActions,
    creditActions,
    creditsOf,
    library,
    playlistActions,
    fileOps,
  } = c;
  return (
    <>
        {bulkOpen && (
          <BulkPanel
            fileIds={bulkFileIds}
            targetLabel="チェックしたファイル"
            tags={tags}
            playlists={playlists}
            creditsOf={creditsOf}
            busy={busy}
            dataVersion={dataVersion}
            onAddTag={tagActions.bulkAddTag}
            onRemoveTag={tagActions.bulkRemoveTag}
            onAutotag={() => fileOps.openAutotag(bulkFileIds, false)}
            onDelete={() => fileOps.startDelete(bulkFileIds)}
            onExportFiles={fileOps.exportCheckedFiles}
            onExportMetadata={fileOps.exportCheckedMetadata}
            onAddToPlaylist={(id) => playlistActions.addToPlaylist(id, bulkFileIds)}
            onOpenPlaylist={(id) => playlistEditor.open(id)}
            onRemoveFromPlaylist={playlistActions.bulkRemoveFromPlaylist}
            onSetCredit={creditActions.bulkSetCredit}
            onRelink={library.relink}
            onFindInFolder={library.findManyInFolder}
            onRemoveMissing={(ids) => library.removeMissing(ids, ids.length)}
            onError={showError}
          />
        )}
        <SelectionPanel
          file={bulkOpen ? null : focusedFile}
          tags={tags}
          busy={busy}
          onAddTag={tagActions.addTag}
          onRemoveTag={tagActions.removeTag}
          onAutotag={() => focusedFile && fileOps.openAutotag([focusedFile.id], true)}
          onDelete={() => focusedFile && fileOps.startDelete([focusedFile.id])}
          onRemoveMissing={() => library.removeMissing(focusedIds(), 1)}
          onRelink={() => library.relink(focusedIds())}
          onLinkFile={() => focusedFile && library.linkMissingFile(focusedFile)}
          onFindInFolder={() => focusedFile && library.findMissingInFolder(focusedFile)}
          onShowSameAudio={showSameAudio}
          onReveal={(path) =>
            isAndroid ? showError("この端末では、ファイルの場所を開けません") : revealItemInDir(path).catch(showError)
          }
          playlists={playlists}
          onAddToPlaylist={(id) => playlistActions.addToPlaylist(id, focusedIds())}
          onOpenPlaylist={(id) => focusedFile && playlistEditor.open(id, null, focusedFile.id)}
          onRemoveFromPlaylist={playlistActions.removeFromPlaylist}
          onError={showError}
        >
          {CREDIT_KINDS.map((kind) => (
            <CreditField
              key={kind}
              kind={kind}
              currentId={focusedFile ? (kind === "source" ? focusedFile.sourceId : focusedFile.licenseId) : null}
              credits={creditsOf(kind)}
              licenseTypes={licenseTypes}
              busy={busy}
              onSet={(name) => creditActions.setFileCredit(kind, name)}
              onClear={() => creditActions.clearFileCredit(kind)}
              onError={showError}
            />
          ))}
        </SelectionPanel>
    </>
  );
}
