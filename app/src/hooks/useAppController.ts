import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type AudioFile,
  type Credit,
  type CreditKind,
  type Facets,
  type FileFilter,
  type LibraryFolder,
  type LicenseType,
  playlistApi,
  type PlaylistNode,
  type Tag,
} from "../api";
import { FILE_SORTS, PLAYLIST_SORTS } from "../listOptions";
import type { ListView } from "../components/FileList";
import type { FileDropTarget } from "./useFileDrag";
import { useAudioPlayer } from "./useAudioPlayer";
import { useMediaSession } from "./useMediaSession";
import { useChecks } from "./useChecks";
import { usePlaylistSelection } from "./usePlaylistSelection";
import { EMPTY_FILTER, useFileFilter } from "./useFileFilter";
import type { AppOps } from "./appOps";
import { useJobProgress } from "./useJobProgress";
import { useUpdateCheck } from "./useUpdateCheck";
import { usePlaylistEditor } from "./usePlaylistEditor";
import { useTagActions } from "./useTagActions";
import { useCreditActions } from "./useCreditActions";
import { useLibraryActions } from "./useLibraryActions";
import { usePlaylistActions } from "./usePlaylistActions";
import { usePlayback } from "./usePlayback";
import { useEffectChainActions } from "./useEffectChainActions";
import { useFileOperations } from "./useFileOperations";
import { chainApi, type EffectChain } from "../effects";
import type { Status } from "../components/StatusBar";
import { tagStyleMap } from "../tagColors";
import { useStoredString } from "../storage";

/**
 * 画面全体の状態（データ・絞り込み・選択など）と、読み直し・操作。Windows の画面（App）と Android の画面（MobileApp）で共有する。
 * 画面の組み立てに使うものを返す
 */
export function useAppController() {
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
   * 一覧に出ていないのに詳細に出しているファイル（Android の全画面の再生で、曲名を押したとき）。行を押していない（focusedKey が null の）ときだけ使う。
   * 一覧を読み直すたびに読み直す（ref は読み直しの処理から id を読むため）
   */
  const [outsideFile, setOutsideFile] = useState<AudioFile | null>(null);
  const outsideIdRef = useRef<number | null>(null);
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
  // Android：再生の通知とロック画面に出し、画面をロックしても鳴らし続ける
  useMediaSession(audio);

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
    const outsideId = outsideIdRef.current;
    const [list, counts, outside] = await Promise.all([
      api.listFiles(request),
      api.facetCounts(request),
      outsideId === null ? null : api.listFiles({ ...EMPTY_FILTER, fileIds: [outsideId] }),
    ]);
    setFiles(list);
    // 外したファイルなら、詳細からも消す
    if (outside !== null && outsideIdRef.current === outsideId) setOutsideFile(outside[0] ?? null);
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
  const focusedFile = useMemo(
    () => (focusedKey !== null ? (files.find((f) => f.key === focusedKey) ?? null) : outsideFile),
    [files, focusedKey, outsideFile],
  );
  /** 行を選ぶ（右の欄・詳細に出す）。一覧に出ていないファイルの詳細はやめる */
  const focusRow = (key: number | null) => {
    outsideIdRef.current = null;
    setOutsideFile(null);
    setFocusedKey(key);
  };
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
    focusRow(null);
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
      focusRow(key);
      setRevealFile({ key, seq: Date.now() });
    },
    showInfo,
    showError,
  });
  /**
   * 鳴らしている曲を、ファイルの詳細に出す（Android の全画面の再生の曲名）。一覧に出ていればその行（一覧から鳴らしているならその行）を選び、
   * 出ていなければライブラリから読んで出す。出せたら true
   */
  const focusPlaying = async () => {
    const id = playback.playingFileId;
    if (id === null) return false;
    setBulkOpen(false);
    const row = files.find((f) => f.key === playback.playingRowKey && f.id === id) ?? files.find((f) => f.id === id);
    if (row) {
      focusRow(row.key);
      return true;
    }
    const [file] = await api.listFiles({ ...EMPTY_FILTER, fileIds: [id] });
    if (!file) {
      showInfo("鳴らしている曲は、ライブラリにありません");
      return false;
    }
    setFocusedKey(null);
    outsideIdRef.current = id;
    setOutsideFile(file);
    return true;
  };
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

  return {
    folders,
    tags,
    tagStyles,
    files,
    fileFilter,
    filter,
    text,
    setText,
    toggleTag,
    toggleUntagged,
    toggleCredit,
    toggleCreditNone,
    toggleOther,
    selectedPlaylistId,
    sorts,
    setFileSortValue,
    fileSort,
    setStoredView,
    listView,
    focusedKey,
    setFocusedKey: focusRow,
    revealFile,
    setRevealFile,
    checkedOnly,
    setCheckedOnly,
    sideQuery,
    setSideQuery,
    facets,
    listVersion,
    busy,
    runCount,
    status,
    sources,
    licenses,
    licenseTypes,
    creditForm,
    setCreditForm,
    setTagDetailId,
    tagDetail,
    chains,
    chainNames,
    playlists,
    bulkOpen,
    setBulkOpen,
    dataVersion,
    showError,
    showInfo,
    playlistEditor,
    editor,
    checks,
    checked,
    audio,
    reloadAll,
    settingsOpen,
    setSettingsOpen,
    showSettingsError,
    update,
    jobs,
    bulkFileIds,
    focusedFile,
    focusedIds,
    focusPlaying,
    resetFilter,
    showSameAudio,
    tagActions,
    creditActions,
    creditsOf,
    library,
    playlistActions,
    playlistName,
    playback,
    effectActions,
    effectDialog,
    fileOps,
    togglePlaylist,
    dropFiles,
    selectedPlaylist,
    filterChips,
  };
}

/** useAppController の結果 */
export type AppController = ReturnType<typeof useAppController>;
