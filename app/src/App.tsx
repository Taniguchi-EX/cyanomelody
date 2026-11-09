import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { pickJsonSavePath, pickPath } from "./dialogs";
import { todayStamp } from "./paths";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  describeScan,
  FILE_SORTS,
  PLAYLIST_SORTS,
  type AudioFile,
  type Credit,
  type CreditInput,
  type CreditKind,
  type Facets,
  type HashProgress,
  type AutotagProgress,
  type ExportProgress,
  type LibraryFolder,
  type LicenseType,
  type LinkOutcome,
  type MoveTarget,
  playlistApi,
  type PlayMode,
  type PlaylistDetail,
  type PlayEntry,
  type FileFilter,
  type PlaylistItem,
  type PlaylistNode,
  type Tag,
  type TagSettings,
  type TagCount,
} from "./api";
import { CREDIT_LABEL } from "./credits";
import { confirmDialog } from "./confirm";
import { FolderPanel } from "./components/FolderPanel";
import { FilterChips } from "./components/FilterChips";
import { TagPanel } from "./components/TagPanel";
import { FileList, type ListView } from "./components/FileList";
import type { FileDropTarget } from "./hooks/useFileDrag";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { PlaylistEditor } from "./components/PlaylistEditor";
import { PlayerBar } from "./components/PlayerBar";
import { useAudioPlayer, type PreviewTarget } from "./hooks/useAudioPlayer";
import { useChecks } from "./hooks/useChecks";
import { usePlaylistSelection } from "./hooks/usePlaylistSelection";
import { useKeepInPlace } from "./hooks/useKeepInPlace";
import { EMPTY_FILTER, FILTER_KEYS, useFileFilter } from "./hooks/useFileFilter";
import { EffectManager } from "./components/EffectManager";
import { chainApi, type Effect, type EffectChain } from "./effects";
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

/** ファイルの一覧を再生するときの、再生の欄の名前 */
const LIST_NAME = "ファイルの一覧";

/** 「ファイルを紐づける」で選べるファイル（スキャンの対象と同じ拡張子） */
const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "m4a"];

/** 左・右の欄の最小の幅と、中央の欄に残す最小の幅 */
const SIDE_MIN = 180;
const MAIN_MIN = 320;

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
  /** 押した行の画面の上の位置を保つ（絞り込みの条件のチップやチェックの操作の行が出て、行がずれないように） */
  const keepInPlace = useKeepInPlace();
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
  /**
   * エフェクトセットの管理画面。開いた元の項目（作ったエフェクトセットを設定する項目）と、試聴するファイル。
   * fx のプルダウンの「新しいfxを作る」「このfxを編集」から開く
   */
  const [effectDialog, setEffectDialog] = useState<{
    target: PreviewTarget | null;
    itemIds: number[];
    /** 選んだ状態で開くエフェクトセット。null なら「新しいfxを作る」から開いた（保存していない新しいエフェクトセットを出す） */
    chainId: number | null;
    /** 再生の欄から開いた（作ったエフェクトセットを、再生の欄のエフェクトセットに選ぶ） */
    forPlayer: boolean;
  } | null>(null);
  const [hashProgress, setHashProgress] = useState<HashProgress | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistNode[]>([]);
  /** 開いている編集画面（重ねて出す）のプレイリストと、開いたときに選んでおく項目 */
  const [editor, setEditor] = useState<{ id: number; itemId: number | null; seq: number } | null>(null);
  const [editorDetail, setEditorDetail] = useState<PlaylistDetail | null>(null);
  /** 右の欄に一括操作を出しているか（出していなければファイルの詳細） */
  const [bulkOpen, setBulkOpen] = useState(false);
  /** 自動タグ付けの確認のダイアログ（対象のファイル。single はファイルの詳細から開いた） */
  const [autotagDialog, setAutotagDialog] = useState<{ fileIds: number[]; single: boolean } | null>(null);
  const [autotagProgress, setAutotagProgress] = useState<AutotagProgress | null>(null);
  /** ファイルの削除の確認（permanent はごみ箱に移せなかったファイルを完全に消す確認） */
  const [deleteDialog, setDeleteDialog] = useState<{
    permanent: boolean;
    files: { id: number; relPath: string; reason?: string }[];
  } | null>(null);
  /** データを読み直すたびに増える（一括操作の欄の内訳を数え直すのに使う） */
  const [dataVersion, setDataVersion] = useState(0);
  // 開いている編集画面のプレイリスト。データを読み直すとき（reloadAll）に参照する
  const editorRef = useRef<number | null>(null);
  useEffect(() => {
    editorRef.current = editor?.id ?? null;
  }, [editor]);

  const showError = (e: unknown) => setStatus({ text: String(e), error: true });
  const showInfo = (text: string) => setStatus({ text, error: false });

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

  /** 開いている編集画面の中身を読み直す。削除されていたら閉じる */
  const reloadEditor = async () => {
    const id = editorRef.current;
    if (id === null) return;
    try {
      setEditorDetail(await playlistApi.get(id));
    } catch {
      setEditor(null);
      setEditorDetail(null);
    }
  };

  const refreshDraw = selection.refresh;
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
  }, [reloadFiles, refreshDraw]);

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

  /** 起動したときに見つかった新しい版。「このバージョンをスキップ」した版は出さない */
  const [update, setUpdate] = useState<string | null>(null);
  const [skippedUpdate, setSkippedUpdate] = useStoredString("cyanomelody.skippedUpdate");
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    api
      .checkUpdate()
      .then((v) => v && setUpdate(v))
      .catch(() => {});
  }, []);
  const installUpdate = () => {
    setUpdating(true);
    api.installUpdate().catch((e) => {
      setUpdating(false);
      setUpdate(null);
      showError(e);
    });
  };

  // ハッシュ値の計算の進み具合。終わったら一覧を読み直す（重複や、右の欄のファイルのハッシュ値が変わるため）
  const reloadAllRef = useRef(reloadAll);
  useEffect(() => {
    reloadAllRef.current = reloadAll;
  }, [reloadAll]);

  // 自動タグ付けの進み具合。終わったら（中止したときも）データを読み直す
  useEffect(() => {
    const unlisten = listen<AutotagProgress>("autotag-progress", (e) => {
      setAutotagProgress(e.payload);
      if (!e.payload.running) reloadAllRef.current().catch(showSettingsError);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [showSettingsError]);
  useEffect(() => {
    api
      .hashingProgress()
      .then((p) => p.running && setHashProgress(p))
      .catch(showError);
    const unlisten = listen<HashProgress>("hash-progress", (e) => {
      setHashProgress(e.payload);
      if (!e.payload.running) reloadAllRef.current().catch(showError);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const startHashing = () => api.startHashing().catch(showError);

  // プレイリストの出力の進み具合
  useEffect(() => {
    const unlisten = listen<ExportProgress>("export-progress", (e) => setExportProgress(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  /**
   * 処理中は操作できないようにし、終わったら一覧を読み直す。読み直しが済むまでを処理中とする。
   * 処理が成功したかを返す（失敗したときはエラーを出して false）
   */
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


  /** 一括操作の対象：チェックしたファイルすべて */
  const bulkFileIds = [...checked];
  // チェックがなくなったら、ファイルの詳細に戻る
  if (bulkOpen && checked.size === 0) setBulkOpen(false);

  /** 右の欄に出しているファイル（押した行のファイル） */
  const focusedFile = useMemo(() => files.find((f) => f.key === focusedKey) ?? null, [files, focusedKey]);
  const focusedIds = () => (focusedFile ? [focusedFile.id] : []);
  const addFolder = (path: string) =>
    run(async () => {
      const r = await api.addFolder(path);
      showInfo(describeScan(path, r));
      // 取り込んだファイルを整理できるよう、そのフォルダだけを表示する
      clearAll();
      resetFilter({ folderId: r.folderId });
      startHashing();
    });

  const removeFolder = async (folder: LibraryFolder) => {
    const message =
      `「${folder.path}」の登録を解除しますか？\n` +
      `このフォルダのファイル${folder.fileCount}件の情報と、付けたタグ・出典・ライセンスの設定がアプリから消えます。\n` +
      "実際のファイルは消えません。";
    if (!(await confirmDialog(message))) return;
    run(async () => {
      await api.removeFolder(folder.id);
      fileFilter.dropFolder(folder.id);
      showInfo(`登録を解除しました: ${folder.path}`);
    });
  };

  const scan = (targets: LibraryFolder[]) =>
    run(async () => {
      const messages: string[] = [];
      const errors: string[] = [];
      for (const f of targets) {
        try {
          messages.push(describeScan(f.path, await api.scanFolder(f.id)));
        } catch (e) {
          errors.push(String(e));
        }
      }
      if (errors.length) setStatus({ text: errors.join(" / "), error: true });
      else showInfo(messages.join(" / "));
      startHashing();
    });

  const addTag = async (name: string) =>
    run(async () => {
      await api.addTag(focusedIds(), name);
      showInfo(`タグ「${name.trim()}」を付けました`);
    });

  /** 一括操作：対象のファイルすべてから、タグを外す（確認してから） */
  const bulkRemoveTag = async (tag: TagCount) => {
    if (!(await confirmDialog(`対象の${tag.count}件から、タグ「${tag.name}」を外しますか？`))) return;
    run(async () => {
      await api.removeTag(bulkFileIds, tag.id);
      showInfo(`${tag.count}件からタグ「${tag.name}」を外しました`);
    });
  };

  /** 一括操作：対象のファイルすべてに、タグを付ける（まだない名前なら作る） */
  const bulkAddTag = async (name: string) =>
    run(async () => {
      await api.addTag(bulkFileIds, name);
      showInfo(`${bulkFileIds.length}件にタグ「${name.trim()}」を付けました`);
    });

  /** 「ファイルを削除する」：見つかっているファイル（リンク切れは除く）の確認のダイアログを出す */
  const startDelete = async (fileIds: number[]) => {
    try {
      const list = await api.listFiles({ ...EMPTY_FILTER, fileIds });
      const files = list.filter((f) => !f.missing).map((f) => ({ id: f.id, relPath: f.relPath }));
      if (files.length === 0) showInfo("削除できるファイルはありません（リンク切れのファイルは「ライブラリから外す」で外せます）");
      else setDeleteDialog({ permanent: false, files });
    } catch (e) {
      showError(e);
    }
  };

  /** 削除の確認で「削除する」「完全に削除する」。鳴らしているファイルなら先に止める。ごみ箱に移せなかったものは、完全に消すか聞く */
  const confirmDelete = () => {
    if (!deleteDialog) return;
    const { permanent, files } = deleteDialog;
    const ids = files.map((f) => f.id);
    setDeleteDialog(null);
    if (playingFileId !== null && ids.includes(playingFileId)) {
      audio.stop();
      audio.stopPreview();
    }
    run(async () => {
      const r = await api.deleteFiles(ids, permanent);
      const done = permanent ? `${r.deleted}件を完全に削除しました` : `${r.deleted}件を削除しました（ごみ箱に移しました）`;
      showInfo(r.failed.length > 0 ? `${done}。${r.failed.length}件は削除できませんでした` : done);
      if (!permanent && r.failed.length > 0) setDeleteDialog({ permanent: true, files: r.failed });
    });
  };

  /** 自動タグ付けの確認のダイアログで「タグを付ける」 */
  const runAutotag = (fileIds: number[], single: boolean, ignore: boolean, split: boolean) => {
    setAutotagDialog(null);
    if (single) {
      run(async () => {
        const r = await api.autotagFile(fileIds[0], ignore, split);
        if (!r.readable) showInfo("ファイルを読めませんでした");
        else if (r.added.length > 0) showInfo(`${r.added.map((a) => `${a.field}：${a.name}`).join("、")} を付けました`);
        else showInfo(r.hasInfo ? "付けるタグはもう付いています" : "ファイルの中に、タグにできる情報はありませんでした");
      });
      return;
    }
    api.startAutotag(fileIds, ignore, split).catch(showError);
  };

  /** 一括操作：プレイリストから、対象のファイルの項目を外す（確認してから） */
  const bulkRemoveFromPlaylist = async (p: TagCount) => {
    if (!(await confirmDialog(`プレイリスト「${p.name}」から、対象の${p.count}件を外しますか？`))) return;
    run(async () => {
      await playlistApi.removeFiles(p.id, bulkFileIds);
      showInfo(`プレイリスト「${p.name}」から${p.count}件を外しました`);
    });
  };

  /**
   * ファイルのメタデータを、データのエクスポートと同じ形の JSON に書き出す（保存先を選ぶ）。
   * fileIds が関数なら、保存先を選んだ後に呼んで対象を決める（プレイリストの一覧など）
   */
  const exportFileInfo = async (name: string, fileIds: number[] | (() => Promise<number[]>)) => {
    const path = await pickJsonSavePath(name).catch(showError);
    if (!path) return;
    run(async () => {
      const ids = typeof fileIds === "function" ? await fileIds() : fileIds;
      const n = await api.exportFiles(path, ids);
      showInfo(`${n}件のファイルのメタデータを書き出しました: ${path}`);
    });
  };

  /** 一括操作：対象のファイルを、選んだフォルダの中に作るフォルダへそのままコピーし始める */
  const exportCheckedFiles = async () => {
    const dest = await pickPath({ directory: true }).catch(showError);
    if (typeof dest !== "string") return;
    try {
      const folder = await playlistApi.startExportFiles(bulkFileIds, dest, `cyanomelody-files-${todayStamp()}`);
      showInfo(`書き出しを始めました: ${folder}`);
    } catch (e) {
      showError(e);
    }
  };

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

  const removeTag = (tagId: number) =>
    run(async () => {
      await api.removeTag(focusedIds(), tagId);
      showInfo("タグを外しました");
    });

  /** 見つからないファイルをライブラリから外す。ids のうち見つからない印のないファイルは外れない */
  const removeMissing = async (ids: number[], count: number) => {
    const message = `見つからないファイル${count}件をライブラリから外しますか？\n付けたタグ・出典・ライセンスの設定も消えます。`;
    if (!(await confirmDialog(message))) return;
    run(async () => {
      const n = await api.removeMissingFiles(ids);
      showInfo(`${n}件をライブラリから外しました`);
    });
  };

  /** ひも付け直す。ids のうち見つからない印のないファイルは何もしない */
  const relink = (ids: number[]) =>
    run(async () => {
      const r = await api.relinkFiles(ids);
      const parts = [`ひも付け直した ${r.relinked}件`];
      if (r.notFound) parts.push(`同じ音声のファイルがない ${r.notFound}件`);
      if (r.ambiguous) parts.push(`候補が複数ある ${r.ambiguous}件`);
      if (r.noHash) parts.push(`ハッシュ値がない ${r.noHash}件`);
      showInfo(parts.join("、"));
    });

  /** チェックしたリンク切れのファイルそれぞれと同じ音声のファイルを、選んだフォルダからまとめて探してひも付ける */
  const findManyInFolder = async (ids: number[]) => {
    const folder = await pickPath({ directory: true }).catch(showError);
    if (typeof folder !== "string") return;
    run(async () => {
      const r = await api.findMissingInFolderMany(ids, folder);
      const parts = [`ひも付けた ${r.linked}件`];
      if (r.notFound) parts.push(`見つからなかった ${r.notFound}件`);
      if (r.noHash) parts.push(`ハッシュ値がない ${r.noHash}件`);
      if (r.addedFolder) parts.push(`フォルダ「${r.addedFolder}」をライブラリに登録しました`);
      showInfo(parts.join("、"));
      if (r.addedFolder) startHashing();
    });
  };

  /** 絞り込み・チェック・右の欄の表示を、すべて解除する */
  const clearAll = () => {
    resetFilter();
    setCheckedOnly(false);
    checks.clear();
    setFocusedKey(null);
  };

  /** 絞り込みの条件をすべて外して next だけにする（選んでいるプレイリストも外す） */
  const resetFilter = (next: Partial<FileFilter> = {}) => {
    fileFilter.reset(next);
    if (selectedPlaylistId !== null) selection.clear().catch(showError);
  };

  const showSameAudio = (hash: string) => {
    resetFilter({ hash });
    setCheckedOnly(false);
  };

  /** フォルダを選んで、そのまま登録する */
  const browseAndAddFolder = async () => {
    const path = await pickPath({ directory: true }).catch(showError);
    if (typeof path === "string") await addFolder(path);
  };

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
        fileFilter.replaceTag(tag.id, r.tagId);
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
      fileFilter.replaceTag(tag.id, null);
      showInfo(`タグ「${tag.name}」を削除しました`);
    });
  };

  const moveCredit = (kind: CreditKind, credit: Credit, target: MoveTarget) =>
    run(async () => {
      await api.moveCredit(kind, credit.id, target);
      showInfo(`${CREDIT_LABEL[kind]}「${credit.name}」を移しました`);
    });

  const moveTag = (tag: Tag, target: MoveTarget) =>
    run(async () => {
      await api.moveTag(tag.id, target);
      showInfo(`タグ「${tag.name}」を移しました`);
    });

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
      `${label}「${credit.name}」を削除しますか？
` +
      `設定されているファイル${credit.fileCount}件は「${label}なし」になります。`;
    if (!(await confirmDialog(message))) return;
    run(async () => {
      await api.deleteCredit(kind, credit.id);
      fileFilter.dropCredit(kind, credit.id);
      showInfo(`${label}「${credit.name}」を削除しました`);
    });
  };

  const setFileCredit = async (kind: CreditKind, name: string) =>
    run(async () => {
      await api.setFileCredit(kind, focusedIds(), name);
      showInfo(`${CREDIT_LABEL[kind]}「${name.trim()}」を設定しました`);
    });

  const clearFileCredit = (kind: CreditKind) =>
    run(async () => {
      await api.setFileCredit(kind, focusedIds(), null);
      showInfo(`${CREDIT_LABEL[kind]}を外しました`);
    });

  const creditKinds: CreditKind[] = ["source", "license"];

  // プレイリスト
  /** 左の欄の行を押したとき：選んで（抽選して）絞り込む。選んでいれば外す */
  const togglePlaylist = (id: number) => selection.toggle(id).catch(showError);

  /**
   * 編集画面を開く。itemId があれば、その項目の行を選んだ状態にする。
   * fileId があれば、そのファイルの項目（ファイルの項目として直接入れたもの）の最初の行を選ぶ
   */
  const openEditor = async (id: number, itemId: number | null = null, fileId: number | null = null) => {
    try {
      const detail = await playlistApi.get(id);
      const initial = itemId ?? (fileId !== null ? (detail.items.find((i) => i.file?.id === fileId)?.id ?? null) : null);
      setEditorDetail(detail);
      setEditor({ id, itemId: initial, seq: Date.now() });
    } catch (e) {
      showError(e);
    }
  };

  const closeEditor = () => {
    setEditor(null);
    setEditorDetail(null);
  };

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
      showInfo(`プレイリスト「${playlists.find((p) => p.id === id)?.name ?? ""}」を移しました`);
    });

  const playlistName = (id: number) => playlists.find((p) => p.id === id)?.name ?? "";

  /** ファイルをプレイリストの最後に加える */
  const addToPlaylist = async (playlistId: number, fileIds: number[]) =>
    run(async () => {
      await playlistApi.addFiles(playlistId, fileIds);
      showInfo(`${fileIds.length}件をプレイリスト「${playlistName(playlistId)}」に追加しました`);
    });

  /** ファイルを左の欄のプレイリスト・タグ・出典・ライセンスに落としたとき */
  const dropFiles = (fileIds: number[], target: FileDropTarget) => {
    if (fileIds.length === 0) return;
    if (target.kind === "playlists") addToPlaylist(target.id, fileIds);
    else if (target.kind === "tags") addTagByDrop(target.id, fileIds);
    else setCreditByDrop(target.kind, target.id, fileIds);
  };


  /** ファイルの行を出典・ライセンスに落としたとき。設定済みなら置き換わる。確認はしない */
  const setCreditByDrop = (kind: CreditKind, creditId: number, fileIds: number[]) => {
    const credit = creditsOf(kind).find((c) => c.id === creditId);
    if (!credit) return;
    run(async () => {
      await api.setFileCredit(kind, fileIds, credit.name);
      showInfo(`${fileIds.length}件に${CREDIT_LABEL[kind]}「${credit.name}」を設定しました`);
    });
  };

  /** 右の欄のプレイリストのチップの「✕」：そのプレイリストから、このファイルの項目をすべて外す */
  const removeFromPlaylist = (playlistId: number) =>
    focusedFile &&
    run(async () => {
      await playlistApi.removeFile(playlistId, focusedFile.id);
      showInfo(`プレイリスト「${playlistName(playlistId)}」から外しました`);
    });

  /** 結び付けの結果を出す。フォルダを登録したときは、ハッシュ値の計算を始める */
  const reportLink = (r: LinkOutcome) => {
    showInfo(
      r.addedFolder
        ? `フォルダ「${r.addedFolder}」をライブラリに登録し、${r.path} にひも付けました`
        : `${r.path} にひも付けました`,
    );
    if (r.addedFolder) startHashing();
  };

  /** リンク切れのファイルを、選んだファイルにひも付ける */
  const linkMissingFile = async (file: AudioFile) => {
    const path = await pickPath({ filters: [{ name: "音声ファイル", extensions: AUDIO_EXTENSIONS }] }).catch(showError);
    if (typeof path !== "string") return;
    run(async () => reportLink(await api.linkMissingFile(file.id, path)));
  };

  /** リンク切れのファイルと同じ音声のファイルを、選んだフォルダから探してひも付ける */
  const findMissingInFolder = async (file: AudioFile) => {
    const folder = await pickPath({ directory: true }).catch(showError);
    if (typeof folder !== "string") return;
    run(async () => {
      const r = await api.findMissingInFolder(file.id, folder);
      if (r) reportLink(r);
      else showInfo(`同じ音声のファイルは見つかりませんでした: ${folder}`);
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

  const addTagsToPlaylist = async (tagIds: number[]) => {
    if (!editor) return false;
    const id = editor.id;
    return run(async () => {
      await playlistApi.addTags(id, tagIds);
      showInfo("タグの組み合わせを加えました");
    });
  };

  const addRefToPlaylist = (refId: number) =>
    editor &&
    run(async () => {
      await playlistApi.addRef(editor.id, refId);
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

  // エフェクトセット
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
    const file = effectDialog?.target;
    if (!file) return;
    showInfo(`試聴の準備中: ${file.relPath}`);
    try {
      const path = await chainApi.preview(file.id, effects);
      audio.previewPath(file, path);
      showInfo(`試聴中: ${file.relPath}`);
    } catch (e) {
      showError(e);
    }
  };

  /**
   * 選んだ状態のプレイリストの、中央の一覧に出ている行（絞り込みと並び順のとおり）を読む。
   * 選んでいなければ、選んで（抽選して）から
   */
  const selectedRows = async (id: number) => {
    if (selectedPlaylistId === id) return api.listFiles(listRequest());
    await selection.select(id);
    // 選んだばかりなので、並び順はプレイリストのもの
    const sort = PLAYLIST_SORTS.find((x) => x.value === playlistSortValue) ?? PLAYLIST_SORTS[0];
    return api.listFiles({ ...listRequest(), draw: true, sort: sort.sort, sortDesc: sort.desc });
  };

  /** プレイリストを書き出し始める（中央の一覧に出ている曲。選んでいなければ選んでから） */
  const exportPlaylist = async (id: number, dest: string) => {
    try {
      const rows = await selectedRows(id);
      const folder = await playlistApi.startExport(id, rows.map((r) => r.key), dest);
      showInfo(`書き出しを始めました: ${folder}`);
      return true;
    } catch (e) {
      showError(e);
      return false;
    }
  };

  const browseFolder = () => pickPath({ directory: true });

  /** 項目（チェックした項目なら、チェックした項目すべて）にエフェクトセットを付ける。null なら外す */
  const setItemsChain = (itemIds: number[], chainId: number | null) =>
    run(async () => {
      for (const id of itemIds) await chainApi.setItemChain(id, chainId);
      if (itemIds.length > 1) showInfo(`${itemIds.length}件の項目の fx を変えました`);
    });

  /**
   * エフェクトセットの管理画面を開く。試聴するのは、その項目の曲（タグの組み合わせ・プレイリストの項目は中の最初の曲）。
   * chainId を選んだ状態で開き、作ったエフェクトセットは itemIds の項目に付ける
   */
  const openEffects = async (item: PlaylistItem, chainId: number | null, itemIds: number[]) => {
    const first = (await playlistApi.itemFiles(item.id).catch(() => []))[0];
    const target = first ? { id: first.fileId, relPath: first.relPath, path: first.path } : null;
    setEffectDialog({ target, itemIds, chainId, forPlayer: false });
  };

  /** 鳴らしているファイル（プレイリストの再生の曲か、試聴中のファイル） */
  const playingEntry = audio.player?.queue[audio.player.index] ?? null;
  const playingTarget: PreviewTarget | null = playingEntry
    ? { id: playingEntry.fileId, relPath: playingEntry.relPath, path: playingEntry.path }
    : audio.previewFile;

  /** 再生の欄のエフェクトセットから、管理画面を開く。試聴するのは鳴らしているファイル */
  const openPlayerEffects = (chainId: number | null) =>
    setEffectDialog({ target: playingTarget, itemIds: [], chainId, forPlayer: true });

  /** 管理画面で作ったエフェクトセットを、開いた元の項目（再生の欄から開いたなら、再生の欄）に付ける */
  const attachCreatedChain = (chainId: number) => {
    if (effectDialog?.forPlayer) audio.setBaseChain(chainId);
    const ids = effectDialog?.itemIds ?? [];
    if (ids.length > 0) setItemsChain(ids, chainId);
  };

  /**
   * 再生の欄の曲名を押したとき：鳴らしている曲を出す。
   * 中央の一覧から鳴らしている曲なら、その行へスクロールして右の欄に出す（一覧になければ、そのことを出す）。
   * 選んでいないプレイリストの曲（編集画面の項目の再生など）なら、そのプレイリストの編集画面を開いてその項目の行を選ぶ
   */
  const jumpToPlaying = () => {
    const sourceId = audio.player?.sourceId ?? null;
    const rowKey = playingEntry?.rowKey;
    if (sourceId !== null && sourceId !== selectedPlaylistId && playlists.some((p) => p.id === sourceId)) {
      openEditor(sourceId, playingEntry?.itemId ?? null);
      return;
    }
    if (!playingTarget) return;
    // 一覧から鳴らしている曲はその行、試聴（エフェクトの管理画面）はそのファイルの行
    const key = rowKey ?? (selectedPlaylistId === null ? playingTarget.id : files.find((f) => f.id === playingTarget.id)?.key);
    if (key === undefined || !files.some((f) => f.key === key)) {
      showInfo("鳴らしている曲は、今の絞り込みでは一覧に出ていません");
      return;
    }
    setFocusedKey(key);
    setRevealFile({ key, seq: Date.now() });
  };

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

  /**
   * 再生の順番を作って鳴らす。鳴らすファイルがなければ、そのことを出す。
   * name は再生の欄に出す名前、sourceId は再生しているプレイリスト（詳細画面で再生中の項目を示すのに使う）。
   * 読み込んだ並び（中の項目の再生方法は当てはめたもの）に、再生の欄で選んだ再生方法を当てはめて鳴らす
   */
  const startQueue = async (name: string, load: () => Promise<PlayEntry[]>, sourceId: number | null, empty: string) => {
    try {
      const source = await load();
      if (source.length === 0) showInfo(empty);
      else audio.playSource(name, source, null, sourceId);
    } catch (e) {
      showError(e);
    }
  };


  /**
   * 中央の一覧（rows）を、再生の欄で選んだ再生方法で再生する。見つからないファイルは除く。
   * 再生を始めたときの一覧で再生し、途中で絞り込みを変えても順番は変わらない。start があればその行から（再生方法に従う）。
   * プレイリストを選んでいるときは、プレイリストとして再生する（各行の項目のエフェクトをかけ、プレイリスト上での名前を使う）
   */
  const playRows = (rows: AudioFile[], start?: AudioFile, playlistId: number | null = selectedPlaylistId) => {
    const source: PlayEntry[] = rows
      .filter((f) => !f.missing)
      .map((f) => ({
        fileId: f.id,
        relPath: f.relPath,
        path: f.path,
        alias: f.alias,
        chains: f.chains,
        itemId: f.itemId,
        rowKey: f.key,
        drawn: f.drawn,
      }));
    if (source.length === 0) {
      showInfo("再生するファイルがありません");
      return;
    }
    const index = start ? source.findIndex((e) => e.rowKey === start.key) : -1;
    const name = playlistId !== null ? playlistName(playlistId) : LIST_NAME;
    audio.playSource(name, source, index >= 0 ? index : null, playlistId);
  };

  /** 表示中の一覧を再生する（start の行から） */
  const playList = (start?: AudioFile) => playRows(files, start);

  /**
   * 再生の欄の「▶」（何も再生していないとき）：表示中の一覧を再生する。
   * 選んでいるプレイリストを最後まで再生した後なら、抽選し直してから
   */
  const playOpen = async () => {
    const id = selectedPlaylistId;
    if (id !== null && audio.finished && audio.finished.sourceId === id) {
      try {
        await selection.redraw();
        playRows(await api.listFiles(listRequest()), undefined, id);
      } catch (e) {
        showError(e);
      }
      return;
    }
    playList();
  };

  /** 編集画面の「▶ 再生」：そのプレイリストを選んだ状態にして（選んでいなければ選んで抽選し）、一覧を頭から再生する */
  const playFromEditor = async (id: number) => {
    try {
      playRows(await selectedRows(id), undefined, id);
    } catch (e) {
      showError(e);
    }
  };

  /** 鳴らしているファイル（一覧の再生・プレイリストの再生・エフェクトの試聴） */
  const playingFileId = audio.previewId ?? audio.player?.queue[audio.player.index]?.fileId ?? null;
  /**
   * 一覧で鳴らしている印を付ける行。一覧から鳴らしているならその行。
   * 試聴や、選んでいないプレイリストの再生では、ライブラリの一覧ならそのファイルの行（プレイリストを選んでいるときは付けない）
   */
  const playingRowKey = playingEntry?.rowKey ?? (selectedPlaylistId === null ? playingFileId : null);

  /** 一覧の行の「▶」：その行から一覧を再生する。鳴らしている行なら止める */
  const toggleRowPlay = (file: AudioFile) => {
    if (playingRowKey === file.key) audio.stop();
    else playList(file);
  };

  /** 編集画面の項目の「▶」：その項目だけを再生する */
  const playPlaylistItem = (item: PlaylistItem) =>
    editor &&
    startQueue(playlistName(editor.id), () => playlistApi.expandItem(item.id), editor.id, "再生するファイルがありません");

  // 選んでいる絞り込みの条件（検索の欄の下にチップで出す。押すとその条件だけ外す）
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
      onClickCapture={keepInPlace}
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
          <FilterChips chips={filterChips} onClearAll={() => resetFilter()} />
        </div>
        <FolderPanel
          folders={folders}
          busy={busy}
          onAdd={browseAndAddFolder}
          onRemove={removeFolder}
          onScan={(f) => scan([f])}
          selectedId={filter.folderId}
          onSelect={fileFilter.toggleFolder}
        />
        <TagPanel
          tags={tags}
          filter={filter}
          onToggleTag={toggleTag}
          onToggleUntagged={toggleUntagged}
          onCreate={createTag}
          onEdit={(tag) => setTagDetailId(tag.id)}
          onDelete={deleteTag}
          facets={facets}
          busy={busy}
          onMove={moveTag}
          query={sideQuery}
        />
        <PlaylistPanel
          playlists={playlists}
          selectedId={selectedPlaylistId}
          busy={busy}
          onSelect={togglePlaylist}
          onEdit={(id) => openEditor(id)}
          onCreate={(name) => createPlaylist(name)}
          onDelete={deletePlaylist}
          onMove={movePlaylist}
          query={sideQuery}
        />
        {creditKinds.map((kind) => (
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
            onDelete={(credit) => deleteCredit(kind, credit)}
            onMove={(credit, target) => moveCredit(kind, credit, target)}
            query={sideQuery}
          />
        ))}
        <OtherPanel filter={filter} onToggle={toggleOther} onDuration={fileFilter.setDuration} onYear={fileFilter.setYear} facets={facets} />
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
            {/* 見出し：プレイリストを選んでいればその名前、選んでいなければ「ライブラリ」 */}
            <div className="toolbar editor-head library-head">
              <h2 className="editor-title" data-testid="list-title" title={selectedPlaylist?.name}>
                {selectedPlaylist ? selectedPlaylist.name : "ライブラリ"}
              </h2>
              {/* ファイル名（相対パス）で一覧を絞り込む */}
              <SearchBox value={text} onChange={setText} label="ファイル名で検索" testId="file-search" />
              {/* 直近で再生したものは、再生した順に並べる（選べない） */}
              <select
                className="file-sort"
                value={fileSort.value}
                onChange={(e) => setFileSortValue(e.target.value)}
                disabled={filter.recentOnly}
                aria-label="並び順"
                title={filter.recentOnly ? "直近で再生したものは、新しく再生した順に並べます" : "一覧の並び順"}
                data-testid="file-sort"
              >
                {sorts.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              {/* 見せ方の切り替え：一覧（行の並び）・グリッド（タイルの格子） */}
              <span className="view-switch" role="group" aria-label="一覧の見せ方">
                {(
                  [
                    ["list", "≡", "一覧で見る"],
                    ["grid", "▦", "グリッドで見る"],
                  ] as const
                ).map(([v, icon, label]) => (
                  <button
                    key={v}
                    className={`icon${listView === v ? " active" : ""}`}
                    aria-pressed={listView === v}
                    title={label}
                    aria-label={label}
                    onClick={() => setStoredView(v)}
                  >
                    {icon}
                  </button>
                ))}
              </span>
            </div>
            {/* チェックの操作は、チェックがあるときだけ出す（件数は下の行に出す） */}
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
            <FileList
              files={files}
              focusedKey={focusedKey}
              checked={checked}
              playingKey={playingRowKey}
              progress={audio.time.duration > 0 ? audio.time.current / audio.time.duration : 0}
              onFocus={(f) => {
                setFocusedKey(f.key);
                setBulkOpen(false);
              }}
              onCheck={checks.checkRow}
              onCheckShown={checks.checkShown}
              onPlay={toggleRowPlay}
              onPlayFrom={playList}
              showHash={filter.duplicatesOnly || filter.hash !== null}
              onDrop={dropFiles}
              tagStyles={tagStyles}
              reveal={revealFile}
              onRevealed={() => setRevealFile(null)}
              onOpenOrigin={(f) => selectedPlaylistId !== null && f.origin && openEditor(selectedPlaylistId, f.origin.itemId)}
              view={listView}
            />
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
            onAddTag={bulkAddTag}
            onRemoveTag={bulkRemoveTag}
            onAutotag={() => setAutotagDialog({ fileIds: bulkFileIds, single: false })}
            onDelete={() => startDelete(bulkFileIds)}
            onExportFiles={exportCheckedFiles}
            onExportInfo={() => exportFileInfo(`cyanomelody-files-${todayStamp()}`, bulkFileIds)}
            onAddToPlaylist={(id) => addToPlaylist(id, bulkFileIds)}
            onOpenPlaylist={(id) => openEditor(id)}
            onRemoveFromPlaylist={bulkRemoveFromPlaylist}
            onSetCredit={bulkSetCredit}
            onRelink={relink}
            onFindInFolder={findManyInFolder}
            onRemoveMissing={(ids) => removeMissing(ids, ids.length)}
            onError={showError}
          />
        )}
        <SelectionPanel
          file={bulkOpen ? null : focusedFile}
          tags={tags}
          busy={busy}
          onAddTag={addTag}
          onRemoveTag={removeTag}
          onAutotag={() => focusedFile && setAutotagDialog({ fileIds: [focusedFile.id], single: true })}
          onDelete={() => focusedFile && startDelete([focusedFile.id])}
          onRemoveMissing={() => removeMissing(focusedIds(), 1)}
          onRelink={() => relink(focusedIds())}
          onLinkFile={() => focusedFile && linkMissingFile(focusedFile)}
          onFindInFolder={() => focusedFile && findMissingInFolder(focusedFile)}
          onShowSameAudio={showSameAudio}
          onReveal={(path) => revealItemInDir(path).catch(showError)}
          playlists={playlists}
          onAddToPlaylist={(id) => addToPlaylist(id, focusedIds())}
          onOpenPlaylist={(id) => focusedFile && openEditor(id, null, focusedFile.id)}
          onRemoveFromPlaylist={removeFromPlaylist}
        >
          {creditKinds.map((kind) => (
            <CreditField
              key={kind}
              kind={kind}
              currentId={focusedFile ? (kind === "source" ? focusedFile.sourceId : focusedFile.licenseId) : null}
              credits={creditsOf(kind)}
              licenseTypes={licenseTypes}
              busy={busy}
              onSet={(name) => setFileCredit(kind, name)}
              onClear={() => clearFileCredit(kind)}
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
        onPlayOpen={playOpen}
        playMode={audio.playMode}
        onPlayMode={audio.setPlayMode}
        onSeek={audio.seek}
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
        onOpenEffects={openPlayerEffects}
        onJump={jumpToPlaying}
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
        exportProgress={exportProgress}
        hashProgress={hashProgress}
        autotagProgress={autotagProgress}
        onError={showError}
      />
      <audio {...audio.audioProps} />
      {editor && editorDetail && editorDetail.id === editor.id && (
        <PlaylistEditor
          key={`${editor.id}:${editor.seq}`}
          detail={editorDetail}
          playlists={playlists}
          tags={tags}
          busy={busy}
          // エフェクトの管理画面を重ねているときの Esc は、そちらだけを閉じる
          onClose={() => !effectDialog && closeEditor()}
          onRename={(name) => renamePlaylist(editor.id, name)}
          onPlay={() => playFromEditor(editor.id)}
          onPlayItem={playPlaylistItem}
          onRemoveItem={removePlaylistItem}
          onMoveItem={movePlaylistItem}
          onSetMode={setPlaylistItemMode}
          initialItemId={editor.itemId}
          playingItemId={
            audio.player && audio.player.sourceId === editor.id ? (audio.player.queue[audio.player.index]?.itemId ?? null) : null
          }
          chains={chains}
          onSetChain={(items, chainId) => setItemsChain(items.map((i) => i.id), chainId)}
          onOpenEffects={openEffects}
          onRemoveItems={removePlaylistItems}
          onSetAlias={setPlaylistItemAlias}
          onAddTags={addTagsToPlaylist}
          onAddRef={addRefToPlaylist}
          onExport={(dest) => exportPlaylist(editor.id, dest)}
          onExportInfo={() =>
            exportFileInfo(playlistName(editor.id), async () => [...new Set((await selectedRows(editor.id)).map((r) => r.id))])
          }
          onBrowseFolder={browseFolder}
          onError={showError}
        />
      )}
      {effectDialog && (
        <EffectManager
          chains={chains}
          busy={busy}
          initialChainId={effectDialog.chainId}
          startNew={effectDialog.chainId === null}
          onCreated={attachCreatedChain}
          previewFileName={effectDialog.target?.relPath ?? null}
          onCreate={createChain}
          onRename={renameChain}
          onDelete={deleteChain}
          onSave={saveChain}
          onPreview={previewChain}
          previewing={audio.previewId !== null && audio.previewId === effectDialog.target?.id}
          onStopPreview={audio.stopPreview}
          onClose={() => setEffectDialog(null)}
        />
      )}
      {deleteDialog && (
        <DeleteDialog
          permanent={deleteDialog.permanent}
          files={deleteDialog.files}
          onConfirm={confirmDelete}
          onClose={() => {
            if (deleteDialog.permanent) showInfo(`${deleteDialog.files.length}件は削除していません`);
            setDeleteDialog(null);
          }}
        />
      )}
      {autotagDialog && (
        <AutotagDialog
          count={autotagDialog.fileIds.length}
          single={autotagDialog.single}
          onConfirm={(ignore, split) => runAutotag(autotagDialog.fileIds, autotagDialog.single, ignore, split)}
          onClose={() => setAutotagDialog(null)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onError={showSettingsError}
          onImported={(r) => {
            showInfo("データを取り込みました");
            reloadAll().catch(showError);
            if (r.foldersAdded.length > 0) startHashing();
          }}
        />
      )}
      {update && update !== skippedUpdate && (
        <UpdateDialog
          version={update}
          busy={updating}
          onUpdate={installUpdate}
          onLater={() => setUpdate(null)}
          onError={showError}
          onSkip={() => {
            setSkippedUpdate(update);
            setUpdate(null);
          }}
        />
      )}
      {tagDetail && (
        <TagDetail
          tag={tagDetail}
          parent={tags.find((t) => t.id === tagDetail.parentId) ?? null}
          busy={busy}
          tags={tags}
          onSubmit={(name, settings, synonyms) => saveTagDetail(tagDetail, name, settings, synonyms)}
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
              ? updateCredit(creditForm.kind, creditForm.credit, input)
              : createCredit(creditForm.kind, input)
          }
          onClose={() => setCreditForm(null)}
        />
      )}
    </div>
  );
}
