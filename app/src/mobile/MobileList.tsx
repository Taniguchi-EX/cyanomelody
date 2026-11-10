import { useState } from "react";
import { FileList } from "../components/FileList";
import { CheckBar } from "../components/CheckBar";
import { SearchBox } from "../components/SearchBox";
import { FunnelIcon, GridIcon, ListIcon, SearchIcon } from "../components/Icons";
import type { AudioFile } from "../api";
import type { AppController } from "../hooks/useAppController";
import { MobileHeader } from "./MobileHeader";

type Props = {
  c: AppController;
  /** チェックしているか（長押しで始め、見出しの「✕」・戻る操作で終わる） */
  checking: boolean;
  /** 長押しでチェックを始めたとき */
  onStartChecking: () => void;
  /** チェックをやめる（見出しの「✕」） */
  onStopChecking: () => void;
  /** 行を押したとき（ファイルの詳細へ） */
  onOpenFile: (file: AudioFile) => void;
  /** 切り替えのボタン（漏斗）：絞り込みへ */
  onOpenFilter: () => void;
};

/**
 * Android のファイルの一覧の画面：見出しの行（見出し・🔍・切り替えのボタン）、並び順と見せ方、一覧（行は名前だけ）。
 * 長押しでチェックを始め、チェックしている間は見出しの行がチェックの件数になり、下にチェックの操作の行を出す
 */
export function MobileList({ c, checking, onStartChecking, onStopChecking, onOpenFile, onOpenFilter }: Props) {
  const {
    files,
    filter,
    text,
    setText,
    selectedPlaylist,
    selectedPlaylistId,
    sorts,
    fileSort,
    setFileSortValue,
    listView,
    setStoredView,
    focusedKey,
    setFocusedKey,
    setBulkOpen,
    bulkOpen,
    checked,
    checkedOnly,
    setCheckedOnly,
    checks,
    audio,
    playback,
    tagStyles,
    revealFile,
    setRevealFile,
    chainNames,
    playlistEditor,
    filterChips,
  } = c;
  // ファイル名の検索：🔍 で見出しの行が検索の欄になる（文字があるときは、検索の欄のまま）
  const [searching, setSearching] = useState(text !== "");

  const header = checking ? (
    <MobileHeader
      title={`${checked.size}件をチェック`}
      onBack={onStopChecking}
      right={
        <button onClick={() => checks.checkShown(true)} disabled={checks.shownChecked === checks.shownFileCount}>
          全て
        </button>
      }
    />
  ) : searching ? (
    <div className="m-header m-search" data-testid="m-header">
      <SearchBox value={text} onChange={setText} label="ファイル名で検索" testId="file-search" />
      <button
        className="icon"
        onClick={() => {
          setText("");
          setSearching(false);
        }}
        aria-label="検索をやめる"
        title="検索をやめる"
      >
        ✕
      </button>
    </div>
  ) : (
    <MobileHeader
      title={<span data-testid="list-title">{selectedPlaylist ? selectedPlaylist.name : "ライブラリ"}</span>}
      right={
        <>
          <button className="icon" onClick={() => setSearching(true)} aria-label="ファイル名で検索" title="ファイル名で検索">
            <SearchIcon />
          </button>
          <button className="icon m-switch" onClick={onOpenFilter} aria-label="絞り込み" title="絞り込み" data-testid="m-to-filter">
            <FunnelIcon />
            {filterChips.length > 0 && <span className="m-badge">{filterChips.length}</span>}
          </button>
        </>
      }
    />
  );

  return (
    <section className="m-screen">
      {header}
      <div className="m-body m-list">
        {/* 並び順と見せ方 */}
        <div className="m-toolbar">
          <select
            className="file-sort"
            value={fileSort.value}
            onChange={(e) => setFileSortValue(e.target.value)}
            disabled={filter.recentOnly}
            aria-label="並び順"
            data-testid="file-sort"
          >
            {sorts.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="sub m-count">{files.length}件</span>
          <button
            className="icon view-switch"
            aria-label={listView === "grid" ? "一覧で見る" : "グリッドで見る"}
            data-view={listView}
            data-testid="view-switch"
            onClick={() => setStoredView(listView === "grid" ? "list" : "grid")}
          >
            {listView === "grid" ? <ListIcon /> : <GridIcon />}
          </button>
        </div>
        <FileList
          files={files}
          focusedKey={focusedKey}
          checked={checked}
          playingKey={playback.playingRowKey}
          progress={audio.time.duration > 0 ? audio.time.current / audio.time.duration : 0}
          onFocus={(f) => {
            setFocusedKey(f.key);
            setBulkOpen(false);
            onOpenFile(f);
          }}
          onCheck={checks.checkRow}
          onCheckShown={checks.checkShown}
          onPlay={playback.toggleRowPlay}
          onPlayFrom={playback.playList}
          showHash={filter.duplicatesOnly || filter.hash !== null}
          onDrop={() => {}}
          tagStyles={tagStyles}
          reveal={revealFile}
          onRevealed={() => setRevealFile(null)}
          onOpenOrigin={(f) => selectedPlaylistId !== null && f.origin && playlistEditor.open(selectedPlaylistId, f.origin.itemId)}
          chainNames={chainNames}
          onOpenEffect={(f) => selectedPlaylistId !== null && playlistEditor.open(selectedPlaylistId, f.itemId, null, true)}
          view={listView}
          touch={{
            checking,
            onLongPress: (index) => {
              checks.checkRow(index, false);
              onStartChecking();
            },
          }}
        />
        {(checking || checkedOnly) && (
          <CheckBar
            checked={checked}
            allShownChecked={checks.shownChecked === checks.shownFileCount}
            checkedOnly={checkedOnly}
            onCheckShown={() => checks.checkShown(true)}
            onClear={onStopChecking}
            onCheckedOnly={setCheckedOnly}
            bulkOpen={bulkOpen}
            onToggleBulk={() => setBulkOpen(true)}
          />
        )}
      </div>
    </section>
  );
}
