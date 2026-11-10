import { FileList } from "../components/FileList";
import { LibraryHead } from "../components/LibraryHead";
import { CheckBar } from "../components/CheckBar";
import type { AudioFile } from "../api";
import type { AppController } from "../hooks/useAppController";

/** ファイルの一覧の欄の中身：見出しの行、ファイルの一覧、チェックの操作の行（Windows の中央の欄） */
export function ListArea({ c, onOpenFile }: { c: AppController; onOpenFile?: (file: AudioFile) => void }) {
  const {
    tagStyles,
    files,
    filter,
    text,
    setText,
    selectedPlaylistId,
    sorts,
    setFileSortValue,
    fileSort,
    setStoredView,
    listView,
    focusedKey,
    setFocusedKey,
    revealFile,
    setRevealFile,
    checkedOnly,
    setCheckedOnly,
    chainNames,
    bulkOpen,
    setBulkOpen,
    playlistEditor,
    checks,
    checked,
    audio,
    playback,
    dropFiles,
    selectedPlaylist,
  } = c;
  return (
    <>
      <LibraryHead
        playlistName={selectedPlaylist?.name ?? null}
        text={text}
        onText={setText}
        sorts={sorts}
        sortValue={fileSort.value}
        onSort={setFileSortValue}
        recentOnly={filter.recentOnly}
        view={listView}
        onView={setStoredView}
      />
      <FileList
        files={files}
        focusedKey={focusedKey}
        checked={checked}
        playingKey={playback.playingRowKey}
        progress={audio.time.duration > 0 ? audio.time.current / audio.time.duration : 0}
        onFocus={(f) => {
          setFocusedKey(f.key);
          setBulkOpen(false);
          onOpenFile?.(f);
        }}
        onCheck={checks.checkRow}
        onCheckShown={checks.checkShown}
        onPlay={playback.toggleRowPlay}
        onPlayFrom={playback.playList}
        showHash={filter.duplicatesOnly || filter.hash !== null}
        onDrop={dropFiles}
        tagStyles={tagStyles}
        reveal={revealFile}
        onRevealed={() => setRevealFile(null)}
        onOpenOrigin={(f) => selectedPlaylistId !== null && f.origin && playlistEditor.open(selectedPlaylistId, f.origin.itemId)}
        chainNames={chainNames}
        onOpenEffect={(f) => selectedPlaylistId !== null && playlistEditor.open(selectedPlaylistId, f.itemId, null, true)}
        view={listView}
      />
      {/* チェックの操作は、チェックがあるときだけ一覧の下に出す（出たり消えたりしても、一覧の行の位置が変わらないように。件数は一番下の行に出す） */}
      {(checked.size > 0 || checkedOnly) && (
        <CheckBar
          checked={checked}
          allShownChecked={checks.shownChecked === checks.shownFileCount}
          checkedOnly={checkedOnly}
          onCheckShown={() => checks.checkShown(true)}
          onClear={checks.clear}
          onCheckedOnly={setCheckedOnly}
          bulkOpen={bulkOpen}
          onToggleBulk={() => setBulkOpen((v) => !v)}
        />
      )}
    </>
  );
}
