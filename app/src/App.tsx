import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, type AudioFile, type Credit, type CreditKind, type Facets, type FileFilter, type LibraryFolder, type LicenseType, playlistApi, type PlaylistNode, type Tag } from "./api";
import { FILE_SORTS, PLAYLIST_SORTS } from "./listOptions";
import { FolderPanel } from "./components/FolderPanel";
import { FilterChips } from "./components/FilterChips";
import { TagPanel } from "./components/TagPanel";
import { FileList, type ListView } from "./components/FileList";
import { LibraryHead } from "./components/LibraryHead";
import type { FileDropTarget } from "./hooks/useFileDrag";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { PlaylistEditor } from "./components/PlaylistEditor";
import { PlayerBar } from "./components/PlayerBar";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useChecks } from "./hooks/useChecks";
import { usePlaylistSelection } from "./hooks/usePlaylistSelection";
import { FILTER_KEYS, useFileFilter } from "./hooks/useFileFilter";
import type { AppOps } from "./hooks/appOps";
import { useJobProgress } from "./hooks/useJobProgress";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { usePlaylistEditor } from "./hooks/usePlaylistEditor";
import { useTagActions } from "./hooks/useTagActions";
import { useCreditActions } from "./hooks/useCreditActions";
import { useLibraryActions } from "./hooks/useLibraryActions";
import { usePlaylistActions } from "./hooks/usePlaylistActions";
import { usePlayback } from "./hooks/usePlayback";
import { useEffectChainActions } from "./hooks/useEffectChainActions";
import { useFileOperations } from "./hooks/useFileOperations";
import { EffectManager } from "./components/EffectManager";
import { chainApi, type EffectChain } from "./effects";
import { SelectionPanel } from "./components/SelectionPanel";
import { CheckBar } from "./components/CheckBar";
import { StatusBar, type Status } from "./components/StatusBar";
import { CreditPanel } from "./components/CreditPanel";
import { OtherPanel } from "./components/OtherPanel";
import { CreditForm } from "./components/CreditForm";
import { TagDetail } from "./components/TagDetail";
import { UpdateDialog } from "./components/UpdateDialog";
import { BulkPanel } from "./components/BulkPanel";
import { AutotagDialog } from "./components/AutotagDialog";
import { DeleteDialog } from "./components/DeleteDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { tagStyleMap } from "./tagColors";
import { CreditField } from "./components/CreditField";
import { Splitter } from "./components/Splitter";
import { SearchBox } from "./components/SearchBox";
import { useStoredNumber, useStoredString } from "./storage";
import { isAndroid } from "./platform";

/** 左・右の欄の最小の幅と、中央の欄に残す最小の幅 */
const SIDE_MIN = 180;
const MAIN_MIN = 320;

/** 出典・ライセンスの欄を並べる順 */
const CREDIT_KINDS: CreditKind[] = ["source", "license"];

/**
 * 画面全体。データ（フォルダ・タグ・プレイリストなど）と中央の一覧を持ち、読み直し（reloadAll）と画面の組み立てを行う。
 * 操作は役割ごとのフック（hooks/use〜Actions など）に分け、run・showInfo・showError（AppOps）を渡して使う
 */
export default function App() {
  const [sideWidth, setSideWidth, commitSideWidth] = useStoredNumber("cyanomelody.width.side", 280);
  const [detailWidth, setDetailWidth, commitDetailWidth] = useStoredNumber("cyanomelody.width.detail", 300);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const tagStyles = useMemo(() => tagStyleMap(tags), [tags]);
  const [files, setFiles] = useState<AudioFile[]>([]);
  /** 絞り込みの条件 */
  const fileFilter = useFileFilter();
  const { filter, text, setText, toggleTag, toggleUntagged, toggleCredit, toggleCreditNone, toggleOther } = fileFilter;
  /** 左の欄で選んでいるプレイリスト（絞り込みの条件の1つ。選ぶと抽選し、中央の一覧はその並びになる） */
  // 抽選したとき：そのプレイリストの、抽選で変わりうる曲（🎲・🔀の項目の曲）を鳴らしていれば止める（再生のフックは後で作るので ref で呼ぶ）
  const onDrawnRef = useRef<(id: number) => void>(() => {});
  const selection = usePlaylistSelection((id) => onDrawnRef.current(id));
  const selectedPlaylistId = selection.selectedId;
  /** 一覧の並び順（FILE_SORTS・PLAYLIST_SORTS の value）。ライブラリとプレイリストで別々に、アプリを閉じても覚えておく */
  const [librarySortValue, setLibrarySortValue] = useStoredString("cyanomelody.fileSort");
  const [playlistSortValue, setPlaylistSortValue] = useStoredString("cyanomelody.fileSort.playlist");
  const sorts = selectedPlaylistId !== null ? PLAYLIST_SORTS : FILE_SORTS;
  const fileSortValue = selectedPlaylistId !== null ? playlistSortValue : librarySortValue;
  const setFileSortValue = selectedPlaylistId !== null ? setPlaylistSortValue : setLibrarySortValue;
  const fileSort = sorts.find((s) => s.value === fileSortValue) ?? sorts[0];
  /** 中央の一覧の見せ方（一覧・グリッド）。アプリを閉じても覚えておく */
  const [storedView, setStoredView] = useStoredString("cyanomelody.listView");
  const listView: ListView = storedView === "grid" ? "grid" : "list";
  /** クリックして右の欄に出している行（AudioFile.key） */
  const [focusedKey, setFocusedKey] = useState<number | null>(null);
  /**
   * 一覧のその行までスクロールする（再生の欄の曲名を押したとき）。seq は押すたびに変え、同じ行でもスクロールし直す。
   * スクロールし終えたら null に戻す
   */
  const [revealFile, setRevealFile] = useState<{ key: number; seq: number } | null>(null);
  const [checkedOnly, setCheckedOnly] = useState(false);
  /** 左の欄の検索の文字（タグ・プレイリスト・出典・ライセンスを名前で絞り込む） */
  const [sideQuery, setSideQuery] = useState("");
  /** 左の欄の各項目を選んだときの件数 */
  const [facets, setFacets] = useState<Facets | null>(null);
  /** 一覧を読み直した回数。画面テストが、絞り込みを変えた後の一覧を待つのに使う（data-list-version） */
  const [listVersion, setListVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  /** 終わった処理（run）の数。画面テストが、処理が終わったことを知るのに使う（data-run-count） */
  const [runCount, setRunCount] = useState(0);
  const [status, setStatus] = useState<Status>({ text: "", error: false });
  const [sources, setSources] = useState<Credit[]>([]);
  const [licenses, setLicenses] = useState<Credit[]>([]);
  const [licenseTypes, setLicenseTypes] = useState<LicenseType[]>([]);
  const [creditForm, setCreditForm] = useState<{ kind: CreditKind; credit: Credit | null } | null>(null);
  /** 詳細画面を開いているタグのid */
  const [tagDetailId, setTagDetailId] = useState<number | null>(null);
  // 削除・統合で消えたタグなら、詳細画面は出さない
  const tagDetail = tags.find((t) => t.id === tagDetailId) ?? null;
  const [chains, setChains] = useState<EffectChain[]>([]);
  const chainNames = useMemo(() => new Map(chains.map((c) => [c.id, c.name])), [chains]);
  const [playlists, setPlaylists] = useState<PlaylistNode[]>([]);
  /** 右の欄に一括操作を出しているか（出していなければファイルの詳細） */
  const [bulkOpen, setBulkOpen] = useState(false);
  /** データを読み直すたびに増える（一括操作の欄の内訳を数え直すのに使う） */
  const [dataVersion, setDataVersion] = useState(0);

  const showError = (e: unknown) => setStatus({ text: String(e), error: true });
  const showInfo = (text: string) => setStatus({ text, error: false });
  /** プレイリストの編集画面（重ねて出す） */
  const playlistEditor = usePlaylistEditor(showError);
  const { editor } = playlistEditor;
  /** チェック（一括操作の対象） */
  const checks = useChecks(files, showError);
  const checked = checks.checked;
  /** 試聴とプレイリストの再生 */
  // 鳴らし始めたファイルは「直近で再生したもの」に記録し、一覧と件数を読み直す（reloadFiles は後で作るので ref で呼ぶ）
  const reloadFilesRef = useRef<() => Promise<void>>(async () => {});
  const audio = useAudioPlayer({
    onInfo: showInfo,
    onError: showError,
    onPlayed: (fileId) =>
      api
        .recordPlay(fileId)
        .then(() => reloadFilesRef.current())
        .catch(showError),
    chainIds: chains.map((c) => c.id),
  });

  useEffect(() => {
    onDrawnRef.current = (id) => {
      const p = audio.player;
      if (p && p.sourceId === id && p.queue[p.index]?.drawn) {
        audio.stop();
        showInfo("プレイリストを抽選し直したので、再生を止めました");
      }
    };
  });

  // 「チェックしたファイルだけ表示」のときだけ、チェックが変わったら読み直す
  const checkedFilter = checkedOnly ? checked : null;
  /** 一覧を読む条件。プレイリストを選んでいるときは、抽選した並びの中で絞り込む */
  const draw = selectedPlaylistId !== null;
  const drawSeq = selection.drawSeq;
  const listRequest = useCallback(
    (): FileFilter => ({
      ...filter,
      fileIds: checkedFilter ? [...checkedFilter] : null,
      draw,
      sort: fileSort.sort,
      sortDesc: fileSort.desc,
    }),
    [filter, checkedFilter, draw, fileSort.sort, fileSort.desc],
  );
  const reloadFiles = useCallback(async () => {
    const request = listRequest();
    const [list, counts] = await Promise.all([api.listFiles(request), api.facetCounts(request)]);
    setFiles(list);
    setFacets(counts);
    setListVersion((v) => v + 1);
    // 絞り込みで消えた行は、右の欄からも消す
    setFocusedKey((prev) => (prev !== null && list.some((f) => f.key === prev) ? prev : null));
    // 抽選し直したとき（drawSeq が変わったとき）も読み直す
    void drawSeq;
  }, [listRequest, drawSeq]);

  useEffect(() => {
    reloadFilesRef.current = reloadFiles;
  }, [reloadFiles]);

  const refreshDraw = selection.refresh;
  const reloadEditor = playlistEditor.reload;
  const reloadAll = useCallback(async () => {
    // 選んでいるプレイリストの中身が変わっていれば抽選し直し、消えていれば選択を外す（一覧を読む前に）
    await refreshDraw();
    const [fs, ts, ss, ls, ps, cs] = await Promise.all([
      api.listFolders(),
      api.listTags(),
      api.listCredits("source"),
      api.listCredits("license"),
      playlistApi.list(),
      chainApi.list(),
    ]);
    setFolders(fs);
    setTags(ts);
    setSources(ss);
    setLicenses(ls);
    setPlaylists(ps);
    setChains(cs);
    await Promise.all([reloadFiles(), reloadEditor()]);
    setDataVersion((v) => v + 1);
  }, [reloadFiles, refreshDraw, reloadEditor]);

  useEffect(() => {
    reloadAll().catch(showError);
  }, [reloadAll]);

  useEffect(() => {
    api.licenseTypes().then(setLicenseTypes).catch(showError);
  }, []);

  /** 設定画面を開いているか */
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 設定画面のエラーを出す（設定画面は読み込みの useEffect で使うので、毎回同じ関数にする）
  const showSettingsError = useCallback((e: unknown) => setStatus({ text: String(e), error: true }), []);
  /** 起動したときに見つかった新しい版 */
  const update = useUpdateCheck(showError);
  /** 裏で行う処理の進み具合 */
  const jobs = useJobProgress(reloadAll, showError);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    let ok = false;
    try {
      await task();
      ok = true;
    } catch (e) {
      showError(e);
    } finally {
      await reloadAll().catch(showError);
      setBusy(false);
      setRunCount((n) => n + 1);
    }
    return ok;
  };
  const ops: AppOps = { run, showInfo, showError };

  /** 一括操作の対象：チェックしたファイルすべて */
  const bulkFileIds = [...checked];
  // チェックがなくなったら、ファイルの詳細に戻る
  if (bulkOpen && checked.size === 0) setBulkOpen(false);

  /** 右の欄に出しているファイル（押した行のファイル） */
  const focusedFile = useMemo(() => files.find((f) => f.key === focusedKey) ?? null, [files, focusedKey]);
  const focusedIds = () => (focusedFile ? [focusedFile.id] : []);

  /** 絞り込みの条件をすべて外して next だけにする（選んでいるプレイリストも外す） */
  const resetFilter = (next: Partial<FileFilter> = {}) => {
    fileFilter.reset(next);
    if (selectedPlaylistId !== null) selection.clear().catch(showError);
  };

  /** 絞り込み・チェック・右の欄の表示を、すべて解除する */
  const clearAll = () => {
    resetFilter();
    setCheckedOnly(false);
    checks.clear();
    setFocusedKey(null);
  };

  const showSameAudio = (hash: string) => {
    resetFilter({ hash });
    setCheckedOnly(false);
  };

  // 操作（役割ごと）
  const tagActions = useTagActions(ops, { tags, replaceTagFilter: fileFilter.replaceTag, focusedIds, bulkFileIds });
  const creditActions = useCreditActions(ops, {
    sources,
    licenses,
    dropCreditFilter: fileFilter.dropCredit,
    focusedIds,
    bulkFileIds,
  });
  const { creditsOf } = creditActions;
  const library = useLibraryActions(ops, {
    startHashing: jobs.startHashing,
    // 取り込んだファイルを整理できるよう、そのフォルダだけを表示する
    onFolderAdded: (folderId) => {
      clearAll();
      resetFilter({ folderId });
    },
    dropFolderFilter: fileFilter.dropFolder,
  });
  const playlistActions = usePlaylistActions(ops, { playlists, editorId: editor?.id ?? null, focusedFile, bulkFileIds });
  const { playlistName } = playlistActions;
  const playback = usePlayback({
    audio,
    files,
    selection,
    listRequest,
    playlistSortValue,
    playlists,
    playlistName,
    editorId: editor?.id ?? null,
    openEditor: playlistEditor.open,
    reveal: (key) => {
      setFocusedKey(key);
      setRevealFile({ key, seq: Date.now() });
    },
    showInfo,
    showError,
  });
  const effectActions = useEffectChainActions(ops, {
    previewPath: audio.previewPath,
    setBaseChain: audio.setBaseChain,
    playingTarget: playback.playingTarget,
  });
  const effectDialog = effectActions.dialog;
  const fileOps = useFileOperations(ops, {
    bulkFileIds,
    playingFileId: playback.playingFileId,
    stopPlaying: () => {
      audio.stop();
      audio.stopPreview();
    },
  });

  /** 左の欄の行を押したとき：選んで（抽選して）絞り込む。選んでいれば外す */
  const togglePlaylist = (id: number) => selection.toggle(id).catch(showError);

  /** ファイルを左の欄のプレイリスト・タグ・出典・ライセンスに落としたとき */
  const dropFiles = (fileIds: number[], target: FileDropTarget) => {
    if (fileIds.length === 0) return;
    if (target.kind === "playlists") playlistActions.addToPlaylist(target.id, fileIds);
    else if (target.kind === "tags") tagActions.addTagByDrop(target.id, fileIds);
    else creditActions.setCreditByDrop(target.kind, target.id, fileIds);
  };

  // 選んでいる絞り込みの条件（左の欄の下にチップで出す。押すとその条件だけ外す）
  const selectedPlaylist = playlists.find((p) => p.id === selectedPlaylistId) ?? null;
  const filterChips = [
    ...(selectedPlaylist
      ? [
          {
            key: "playlist",
            icon: "📃",
            label: selectedPlaylist.name,
            title: "プレイリスト（抽選した並び）",
            onRemove: () => {
              selection.clear().catch(showError);
            },
            testId: "playlist-filter",
          },
        ]
      : []),
    ...fileFilter.chips({ folders, tags, credits: creditsOf }),
  ];

  return (
    // ウィンドウを狭くしたときは、左・右の欄が最小の幅まで縮んでから中央の欄が縮む
    <div
      className="app"
      style={{
        gridTemplateColumns: `minmax(${SIDE_MIN}px, ${sideWidth}px) auto minmax(${MAIN_MIN}px, 1fr) auto minmax(${SIDE_MIN}px, ${detailWidth}px)`,
      }}
    >
      <aside className="side">
        {/* 絞り込みの操作。左の欄をスクロールしても一番上に残す */}
        <div className="filter-bar" data-testid="filter-bar">
          <div className="row">
            {/* 左の欄のタグ・プレイリスト・出典・ライセンスを名前で絞り込む（ファイルの一覧は絞り込まない） */}
            <SearchBox value={sideQuery} onChange={setSideQuery} label="検索" testId="side-search" />
          </div>
        </div>
        <FolderPanel
          folders={folders}
          busy={busy}
          onAdd={library.browseAndAddFolder}
          onRemove={library.removeFolder}
          onScan={(f) => library.scan([f])}
          selectedId={filter.folderId}
          onSelect={fileFilter.toggleFolder}
        />
        <TagPanel
          tags={tags}
          filter={filter}
          onToggleTag={toggleTag}
          onToggleUntagged={toggleUntagged}
          onCreate={tagActions.createTag}
          onEdit={(tag) => setTagDetailId(tag.id)}
          onDelete={tagActions.deleteTag}
          facets={facets}
          busy={busy}
          onMove={tagActions.moveTag}
          query={sideQuery}
        />
        <PlaylistPanel
          playlists={playlists}
          selectedId={selectedPlaylistId}
          busy={busy}
          onSelect={togglePlaylist}
          onEdit={(id) => playlistEditor.open(id)}
          onCreate={(name) => playlistActions.createPlaylist(name)}
          onDelete={playlistActions.deletePlaylist}
          onMove={playlistActions.movePlaylist}
          query={sideQuery}
        />
        {CREDIT_KINDS.map((kind) => (
          <CreditPanel
            key={kind}
            kind={kind}
            credits={creditsOf(kind)}
            selectedIds={filter[FILTER_KEYS[kind].ids]}
            noneSelected={filter[FILTER_KEYS[kind].none]}
            counts={facets ? (kind === "source" ? facets.sources : facets.licenses) : null}
            onToggle={(id) => toggleCredit(kind, id)}
            onToggleNone={() => toggleCreditNone(kind)}
            busy={busy}
            onEdit={(credit) => setCreditForm({ kind, credit })}
            onDelete={(credit) => creditActions.deleteCredit(kind, credit)}
            onMove={(credit, target) => creditActions.moveCredit(kind, credit, target)}
            query={sideQuery}
          />
        ))}
        <OtherPanel filter={filter} onToggle={toggleOther} onDuration={fileFilter.setDuration} onYear={fileFilter.setYear} facets={facets} />
        {/*
          選んでいる絞り込みの条件。左の欄の一番下に残す（出たり消えたりしても、上の行の位置が変わらないように）
        */}
        {filterChips.length > 0 && (
          <div className="filter-dock" data-testid="filter-dock">
            <FilterChips chips={filterChips} onClearAll={() => resetFilter()} />
          </div>
        )}
      </aside>
      <Splitter
        label="左の欄の幅"
        width={sideWidth}
        direction={1}
        min={SIDE_MIN}
        max={() => window.innerWidth - detailWidth - MAIN_MIN}
        onChange={setSideWidth}
        onCommit={commitSideWidth}
      />

      <main className="main">
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
      </main>
      <Splitter
        label="右の欄の幅"
        width={detailWidth}
        direction={-1}
        min={SIDE_MIN}
        max={() => window.innerWidth - sideWidth - MAIN_MIN}
        onChange={setDetailWidth}
        onCommit={commitDetailWidth}
      />

      <aside className="detail">
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
      </aside>

      <PlayerBar
        player={audio.player}
        time={audio.time}
        // 表示中の一覧を再生する（プレイリストを選んでいれば、プレイリストとして）
        canPlayOpen={files.some((f) => !f.missing)}
        onPlayOpen={playback.playOpen}
        playMode={audio.playMode}
        onPlayMode={audio.setPlayMode}
        onSeek={audio.seek}
        onSeekBy={audio.seekBy}
        onPrev={audio.prev}
        onNext={audio.next}
        onTogglePause={audio.togglePause}
        onStop={audio.stop}
        previewFile={audio.previewFile}
        volume={audio.volume}
        onVolume={audio.setVolume}
        onVolumeCommit={audio.commitVolume}
        onToggleMute={audio.toggleMute}
        chains={chains}
        baseChain={audio.baseChain}
        onBaseChain={audio.setBaseChain}
        onOpenEffects={effectActions.openForPlayer}
        onJump={playback.jumpToPlaying}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <StatusBar
        status={status}
        busy={busy}
        runCount={runCount}
        listVersion={listVersion}
        fileCount={files.length}
        checkedCount={checked.size}
        shownChecked={checks.shownChecked}
        songs={selectedPlaylistId !== null}
        exportProgress={jobs.exportProgress}
        hashProgress={jobs.hashProgress}
        autotagProgress={jobs.autotagProgress}
        onError={showError}
      />
      <audio {...audio.audioProps} />
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
            if (r.foldersAdded.length > 0) jobs.startHashing();
          }}
        />
      )}
      {update.version && (
        <UpdateDialog
          version={update.version}
          busy={update.updating}
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
    </div>
  );
}
