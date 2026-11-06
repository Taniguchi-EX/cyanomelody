import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { pickPath } from "./dialogs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  describeScan,
  FILE_SORTS,
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
import { FileList } from "./components/FileList";
import type { FileDropTarget } from "./hooks/useFileDrag";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { PlaylistEditor } from "./components/PlaylistEditor";
import { PlayerBar } from "./components/PlayerBar";
import { useAudioPlayer, type PreviewTarget } from "./hooks/useAudioPlayer";
import { useChecks } from "./hooks/useChecks";
import { EMPTY_FILTER, FILTER_KEYS, useFileFilter } from "./hooks/useFileFilter";
import { EffectManager } from "./components/EffectManager";
import { chainApi, type Effect, type EffectChain } from "./effects";
import { SelectionPanel } from "./components/SelectionPanel";
import { CheckBar } from "./components/CheckBar";
import { StatusBar, type Status } from "./components/StatusBar";
import { AliasField, ItemDetail } from "./components/ItemDetail";
import { CreditPanel } from "./components/CreditPanel";
import { OtherPanel } from "./components/OtherPanel";
import { CreditForm } from "./components/CreditForm";
import { TagDetail } from "./components/TagDetail";
import { UpdateDialog } from "./components/UpdateDialog";
import { BulkPanel } from "./components/BulkPanel";
import { AutotagDialog } from "./components/AutotagDialog";
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
  /** ライブラリの一覧の並び順（FILE_SORTS の value）。アプリを閉じても覚えておく */
  const [fileSortValue, setFileSortValue] = useStoredString("cyanomelody.fileSort");
  const fileSort = FILE_SORTS.find((s) => s.value === fileSortValue) ?? FILE_SORTS[0];
  /** クリックして右の欄に出しているファイル */
  const [focusedId, setFocusedId] = useState<number | null>(null);
  /**
   * 一覧のその行までスクロールする（再生の欄の曲名を押したとき）。seq は押すたびに変え、同じ行でもスクロールし直す。
   * スクロールし終えたら null に戻す
   */
  const [revealFile, setRevealFile] = useState<{ id: number; seq: number } | null>(null);
  const [revealItem, setRevealItem] = useState<{ id: number; seq: number } | null>(null);
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
  /** 中央で開いているプレイリスト（null ならファイルの一覧を出す） */
  const [openPlaylistId, setOpenPlaylistId] = useState<number | null>(null);
  const [playlistDetail, setPlaylistDetail] = useState<PlaylistDetail | null>(null);
  /** 詳細画面で押して、右の欄に出している項目 */
  const [focusedItemId, setFocusedItemId] = useState<number | null>(null);
  /** 詳細画面でチェックした項目（一括操作の対象を求めるので、ここで持つ） */
  const [itemChecks, setItemChecks] = useState<Set<number>>(new Set());
  /** 右の欄に一括操作を出しているか（出していなければファイルの詳細） */
  const [bulkOpen, setBulkOpen] = useState(false);
  /** 自動タグ付けの確認のダイアログ（対象のファイル。single はファイルの詳細から開いた） */
  const [autotagDialog, setAutotagDialog] = useState<{ fileIds: number[]; single: boolean } | null>(null);
  const [autotagProgress, setAutotagProgress] = useState<AutotagProgress | null>(null);
  /** 右の欄に出している項目のファイル（ファイルの一覧に出ていないこともあるので、別に読む） */
  const [itemFile, setItemFile] = useState<AudioFile | null>(null);
  /** データを読み直すたびに増える（右の欄の項目のファイルを読み直すのに使う） */
  const [dataVersion, setDataVersion] = useState(0);
  // 開いているプレイリスト。データを読み直すとき（reloadAll）に参照する
  const openPlaylistRef = useRef<number | null>(null);
  useEffect(() => {
    openPlaylistRef.current = openPlaylistId;
  }, [openPlaylistId]);

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

  // 「チェックしたファイルだけ表示」のときだけ、チェックが変わったら読み直す
  const checkedFilter = checkedOnly ? checked : null;
  const reloadFiles = useCallback(async () => {
    const request = {
      ...filter,
      fileIds: checkedFilter ? [...checkedFilter] : null,
      sort: fileSort.sort,
      sortDesc: fileSort.desc,
    };
    const [list, counts] = await Promise.all([api.listFiles(request), api.facetCounts(request)]);
    setFiles(list);
    setFacets(counts);
    setListVersion((v) => v + 1);
    // 絞り込みで消えたファイルは、右の欄からも消す
    setFocusedId((prev) => (prev !== null && list.some((f) => f.id === prev) ? prev : null));
  }, [filter, checkedFilter, fileSort.sort, fileSort.desc]);

  useEffect(() => {
    reloadFilesRef.current = reloadFiles;
  }, [reloadFiles]);

  /** 開いているプレイリストの中身を読み直す。削除されていたら、ファイルの一覧に戻る */
  const reloadPlaylistDetail = async () => {
    const id = openPlaylistRef.current;
    if (id === null) return;
    try {
      setPlaylistDetail(await playlistApi.get(id));
    } catch {
      setOpenPlaylistId(null);
      setPlaylistDetail(null);
    }
  };

  const reloadAll = useCallback(async () => {
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
    await Promise.all([reloadFiles(), reloadPlaylistDetail()]);
    setDataVersion((v) => v + 1);
  }, [reloadFiles]);

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

  /** 詳細画面でチェックした項目に入る曲（一括操作の対象）。タグの組み合わせなどの項目は、当てはまる曲すべて */
  const [itemCheckFiles, setItemCheckFiles] = useState<{ key: string; ids: number[] } | null>(null);
  const checkedItemIds = playlistDetail ? playlistDetail.items.filter((i) => itemChecks.has(i.id)).map((i) => i.id) : [];
  const checkedItemKey = checkedItemIds.join(",");
  useEffect(() => {
    if (!bulkOpen || checkedItemKey === "") return;
    let alive = true;
    Promise.all(checkedItemKey.split(",").map((id) => playlistApi.itemFiles(Number(id))))
      .then((lists) => alive && setItemCheckFiles({ key: checkedItemKey, ids: [...new Set(lists.flat().map((e) => e.fileId))] }))
      .catch(showSettingsError);
    return () => {
      alive = false;
    };
  }, [bulkOpen, checkedItemKey, dataVersion, showSettingsError]);
  const bulkFileIds = playlistDetail
    ? itemCheckFiles && itemCheckFiles.key === checkedItemKey
      ? itemCheckFiles.ids
      : []
    : [...checked];
  // チェックがなくなったら、ファイルの詳細に戻る
  const bulkTargetCount = playlistDetail ? checkedItemIds.length : checked.size;
  if (bulkOpen && bulkTargetCount === 0) setBulkOpen(false);

  const listFocusedFile = useMemo(() => files.find((f) => f.id === focusedId) ?? null, [files, focusedId]);
  const focusedItem = playlistDetail?.items.find((i) => i.id === focusedItemId) ?? null;
  const itemFileId = focusedItem?.kind === "file" ? (focusedItem.file?.id ?? null) : null;
  useEffect(() => {
    if (itemFileId === null) return;
    let alive = true;
    api
      .listFiles({ ...EMPTY_FILTER, fileIds: [itemFileId] })
      .then((list) => alive && setItemFile(list[0] ?? null))
      .catch(showError);
    return () => {
      alive = false;
    };
  }, [itemFileId, dataVersion]);
  /** 右の欄に出しているファイル。プレイリストを開いているときは、押した項目のファイル */
  const focusedFile = playlistDetail
    ? itemFile && itemFile.id === itemFileId
      ? itemFile
      : null
    : listFocusedFile;
  const focusedIds = () => (focusedFile ? [focusedFile.id] : []);
  const addFolder = (path: string) =>
    run(async () => {
      const r = await api.addFolder(path);
      showInfo(describeScan(path, r));
      // 取り込んだファイルを整理できるよう、そのフォルダだけを表示する
      clearAll();
      fileFilter.reset({ folderId: r.folderId });
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

  /** 自動タグ付けの確認のダイアログで「タグを付ける」 */
  const runAutotag = (fileIds: number[], single: boolean, ignore: boolean) => {
    setAutotagDialog(null);
    if (single) {
      run(async () => {
        const r = await api.autotagFile(fileIds[0], ignore);
        if (!r.readable) showInfo("ファイルを読めませんでした");
        else if (r.added.length > 0) showInfo(`${r.added.map((a) => `${a.field}：${a.name}`).join("、")} を付けました`);
        else showInfo(r.hasInfo ? "付けるタグはもう付いています" : "ファイルの中に、タグにできる情報はありませんでした");
      });
      return;
    }
    api.startAutotag(fileIds, ignore).catch(showError);
  };

  /** 一括操作：プレイリストから、対象のファイルの項目を外す（確認してから） */
  const bulkRemoveFromPlaylist = async (p: TagCount) => {
    if (!(await confirmDialog(`プレイリスト「${p.name}」から、対象の${p.count}件を外しますか？`))) return;
    run(async () => {
      await playlistApi.removeFiles(p.id, bulkFileIds);
      showInfo(`プレイリスト「${p.name}」から${p.count}件を外しました`);
    });
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
    fileFilter.reset();
    setCheckedOnly(false);
    checks.clear();
    setFocusedId(null);
  };

  const showSameAudio = (hash: string) => {
    fileFilter.reset({ hash });
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
  const saveTagDetail = async (tag: Tag, name: string, settings: TagSettings) => {
    const newName = name.trim();
    const other = tags.find((t) => t.id !== tag.id && t.name.toLowerCase() === newName.toLowerCase());
    if (
      other &&
      !(await confirmDialog(
        `タグ「${other.name}」が既にあります。\n「${tag.name}」を「${other.name}」に統合しますか？\n` +
          `「${tag.name}」が付いたファイルに「${other.name}」が付き、「${tag.name}」は削除されます。` +
          "\n子のタグがあれば、統合先の子の最後に移ります。この画面で決めた並び順と色は保存しません。",
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
  const openPlaylist = (id: number) => {
    if (id !== openPlaylistId) setItemChecks(new Set());
    setBulkOpen(false);
    setOpenPlaylistId(id);
    setFocusedItemId(null);
    playlistApi.get(id).then(setPlaylistDetail).catch(showError);
  };

  const closePlaylist = () => {
    setItemChecks(new Set());
    setBulkOpen(false);
    setOpenPlaylistId(null);
    setFocusedItemId(null);
    setPlaylistDetail(null);
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

  /** プレイリストの項目を左の欄に落としたとき。対象は、その項目に入る曲すべて（再生方法にかかわらず） */
  const dropItems = async (itemIds: number[], target: FileDropTarget) => {
    try {
      const lists = await Promise.all(itemIds.map((id) => playlistApi.itemFiles(id)));
      dropFiles([...new Set(lists.flat().map((e) => e.fileId))], target);
    } catch (e) {
      showError(e);
    }
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
    if (!playlistDetail) return false;
    return run(async () => {
      await playlistApi.addTags(playlistDetail.id, tagIds);
      showInfo("タグの組み合わせを加えました");
    });
  };

  const addRefToPlaylist = (refId: number) =>
    playlistDetail &&
    run(async () => {
      await playlistApi.addRef(playlistDetail.id, refId);
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

  /** プレイリストを書き出し始める */
  const exportPlaylist = async (id: number, dest: string) => {
    try {
      const folder = await playlistApi.startExport(id, dest);
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
   * 再生の欄の曲名を押したとき：鳴らしている曲を中央の欄に出す。
   * プレイリストを再生しているならその項目の行、ライブラリの一覧（試聴を含む）ならそのファイルの行へスクロールし、右の欄に出す
   */
  const jumpToPlaying = () => {
    const sourceId = audio.player?.sourceId ?? null;
    const itemId = playingEntry?.itemId ?? null;
    if (sourceId !== null && itemId !== null && playlists.some((p) => p.id === sourceId)) {
      if (openPlaylistId !== sourceId) openPlaylist(sourceId);
      setFocusedItemId(itemId);
      setRevealItem({ id: itemId, seq: Date.now() });
      return;
    }
    if (!playingTarget) return;
    if (playlistDetail) closePlaylist();
    if (!files.some((f) => f.id === playingTarget.id)) {
      showInfo("鳴らしている曲は、今の絞り込みではライブラリの一覧に出ていません");
      return;
    }
    setFocusedId(playingTarget.id);
    setRevealFile({ id: playingTarget.id, seq: Date.now() });
  };

  const setPlaylistItemAlias = async (item: PlaylistItem, alias: string) =>
    run(async () => {
      await playlistApi.setItemAlias(item.id, alias);
      showInfo(alias.trim() ? `プレイリスト上での名前を「${alias.trim()}」にしました` : "プレイリスト上での名前を外しました");
    });

  const setPlaylistItemMode = (item: PlaylistItem, mode: PlayMode) =>
    run(async () => {
      await playlistApi.setItemMode(item.id, mode);
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

  /** プレイリストを、再生の欄で選んだ再生方法で再生する（プレイリスト自体は順に展開してから当てはめる） */
  const playPlaylist = (id: number) =>
    startQueue(playlistName(id), () => playlistApi.expand(id, "order"), id, `「${playlistName(id)}」には再生するファイルがありません`);

  /**
   * 表示中のファイルの一覧を、プレイリストのように再生する（試聴）。見つからないファイルは除く。
   * 再生を始めたときの一覧で再生し、途中で絞り込みを変えても順番は変わらない。start があればその曲から（再生方法に従う）
   */
  const playList = (start?: AudioFile) => {
    const source: PlayEntry[] = files
      .filter((f) => !f.missing)
      .map((f) => ({ fileId: f.id, relPath: f.relPath, path: f.path, alias: null, chains: [], itemId: null }));
    if (source.length === 0) {
      showInfo("再生するファイルがありません");
      return;
    }
    const index = start ? source.findIndex((e) => e.fileId === start.id) : -1;
    audio.playSource(LIST_NAME, source, index >= 0 ? index : null);
  };

  /** 鳴らしているファイル（一覧の再生・プレイリストの再生・エフェクトの試聴） */
  const playingFileId = audio.previewId ?? audio.player?.queue[audio.player.index]?.fileId ?? null;

  /** 一覧の行の「▶」：その行から一覧を再生する。鳴らしている行なら止める */
  const toggleRowPlay = (file: AudioFile) => {
    if (playingFileId === file.id) audio.stop();
    else playList(file);
  };

  const playPlaylistItem = (item: PlaylistItem) =>
    startQueue(
      playlistDetail?.name ?? "",
      () => playlistApi.expandItem(item.id),
      playlistDetail?.id ?? null,
      "再生するファイルがありません",
    );

  // 選んでいる絞り込みの条件（検索の欄の下にチップで出す。押すとその条件だけ外す）
  const filterChips = fileFilter.chips({ folders, tags, credits: creditsOf });

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
          <FilterChips chips={filterChips} onClearAll={() => fileFilter.reset()} />
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
          openId={openPlaylistId}
          busy={busy}
          onOpen={openPlaylist}
          onCreate={(name) => createPlaylist(name)}
          onRename={renamePlaylist}
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
        <OtherPanel filter={filter} onToggle={toggleOther} onDuration={fileFilter.setDuration} facets={facets} />
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
        {playlistDetail ? (
          <PlaylistEditor
            key={playlistDetail.id}
            detail={playlistDetail}
            playlists={playlists}
            tags={tags}
            filterTagIds={filter.tagIds}
            busy={busy}
            onClose={closePlaylist}
            onPlayItem={playPlaylistItem}
            onRemoveItem={removePlaylistItem}
            onMoveItem={movePlaylistItem}
            onSetMode={setPlaylistItemMode}
            focusedItemId={focusedItemId}
            playingItemId={
              audio.player && audio.player.sourceId === playlistDetail.id
                ? (audio.player.queue[audio.player.index]?.itemId ?? null)
                : null
            }
            onFocusItem={(item) => {
              setFocusedItemId(item.id);
              setBulkOpen(false);
            }}
            checked={itemChecks}
            setChecked={setItemChecks}
            bulkOpen={bulkOpen}
            onToggleBulk={() => setBulkOpen((v) => !v)}
            reveal={revealItem}
            onRevealed={() => setRevealItem(null)}
            chains={chains}
            onSetChain={(items, chainId) => setItemsChain(items.map((i) => i.id), chainId)}
            onOpenEffects={openEffects}
            onRemoveItems={removePlaylistItems}
            onDropItems={dropItems}
            onAddTags={addTagsToPlaylist}
            onAddRef={addRefToPlaylist}
            onExport={(dest) => exportPlaylist(playlistDetail.id, dest)}
            onBrowseFolder={browseFolder}
          />
        ) : (
          <>
            {/* プレイリストの詳細画面の名前と同じ位置に、ファイルの一覧であることを出す */}
            <div className="toolbar editor-head library-head">
              <h2 className="editor-title" data-testid="list-title">
                ライブラリ
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
                {FILE_SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            {/* チェックの操作は、チェックがあるときだけ出す（件数は下の行に出す） */}
            {(checked.size > 0 || checkedOnly) && (
              <CheckBar
                checked={checked}
                allShownChecked={checks.shownChecked === files.length}
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
              focusedId={focusedId}
              checked={checked}
              playingId={playingFileId}
              progress={audio.time.duration > 0 ? audio.time.current / audio.time.duration : 0}
              onFocus={(f) => {
                setFocusedId(f.id);
                setBulkOpen(false);
              }}
              onCheck={checks.checkRow}
              onCheckShown={checks.checkShown}
              onPlay={toggleRowPlay}
              showHash={filter.duplicatesOnly || filter.hash !== null}
              onDrop={dropFiles}
              tagStyles={tagStyles}
              reveal={revealFile}
              onRevealed={() => setRevealFile(null)}
            />
          </>
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
            targetLabel={playlistDetail ? "チェックした項目の曲" : "チェックしたファイル"}
            tags={tags}
            playlists={playlists}
            creditsOf={creditsOf}
            busy={busy}
            dataVersion={dataVersion}
            onAddTag={bulkAddTag}
            onRemoveTag={bulkRemoveTag}
            onAutotag={() => setAutotagDialog({ fileIds: bulkFileIds, single: false })}
            onAddToPlaylist={(id) => addToPlaylist(id, bulkFileIds)}
            onOpenPlaylist={openPlaylist}
            onRemoveFromPlaylist={bulkRemoveFromPlaylist}
            onSetCredit={bulkSetCredit}
            onRelink={relink}
            onFindInFolder={findManyInFolder}
            onRemoveMissing={(ids) => removeMissing(ids, ids.length)}
            onError={showError}
          />
        )}
        {/* ファイルの項目は、ファイルを読み終えてから右の欄に出す（読む間に別の欄を出すと、入力が消えるため） */}
        {!bulkOpen && focusedItem && itemFileId === null && (
          <ItemDetail
            key={focusedItem.id}
            item={focusedItem}
            busy={busy}
            onSave={(alias) => setPlaylistItemAlias(focusedItem, alias)}
            dataVersion={dataVersion}
          />
        )}
        <SelectionPanel
          file={bulkOpen ? null : focusedFile}
          top={
            focusedItem &&
            focusedFile && (
              <AliasField
                key={`${focusedItem.id}:${focusedItem.alias ?? ""}`}
                item={focusedItem}
                busy={busy}
                onSave={(alias) => setPlaylistItemAlias(focusedItem, alias)}
              />
            )
          }
          tags={tags}
          busy={busy}
          onAddTag={addTag}
          onRemoveTag={removeTag}
          onAutotag={() => focusedFile && setAutotagDialog({ fileIds: [focusedFile.id], single: true })}
          onRemoveMissing={() => removeMissing(focusedIds(), 1)}
          onRelink={() => relink(focusedIds())}
          onLinkFile={() => focusedFile && linkMissingFile(focusedFile)}
          onFindInFolder={() => focusedFile && findMissingInFolder(focusedFile)}
          onShowSameAudio={showSameAudio}
          onReveal={(path) => revealItemInDir(path).catch(showError)}
          playlists={playlists}
          onAddToPlaylist={(id) => addToPlaylist(id, focusedIds())}
          onOpenPlaylist={openPlaylist}
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
        // プレイリストを開いていればそのプレイリスト、開いていなければ表示中の一覧を再生する
        canPlayOpen={playlistDetail !== null || files.some((f) => !f.missing)}
        onPlayOpen={() => (playlistDetail ? playPlaylist(playlistDetail.id) : playList())}
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
        exportProgress={exportProgress}
        hashProgress={hashProgress}
        autotagProgress={autotagProgress}
        onError={showError}
      />
      <audio {...audio.audioProps} />
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
      {autotagDialog && (
        <AutotagDialog
          count={autotagDialog.fileIds.length}
          single={autotagDialog.single}
          onConfirm={(ignore) => runAutotag(autotagDialog.fileIds, autotagDialog.single, ignore)}
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
          onSubmit={(name, settings) => saveTagDetail(tagDetail, name, settings)}
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
