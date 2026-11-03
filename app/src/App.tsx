import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { pickPath } from "./dialogs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  describeHashing,
  describeScan,
  type AudioFile,
  type Credit,
  type CreditInput,
  type CreditKind,
  type FileFilter,
  type Facets,
  type HashProgress,
  type ExportProgress,
  describeExport,
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
} from "./api";
import { CREDIT_LABEL } from "./credits";
import { confirmDialog } from "./confirm";
import { FolderPanel } from "./components/FolderPanel";
import { baseName } from "./paths";
import { FilterChips, type FilterChip } from "./components/FilterChips";
import { TagPanel } from "./components/TagPanel";
import { FileList } from "./components/FileList";
import type { FileDropTarget } from "./hooks/useFileDrag";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { PlaylistEditor } from "./components/PlaylistEditor";
import { PlayerBar } from "./components/PlayerBar";
import { useAudioPlayer, type PreviewTarget } from "./hooks/useAudioPlayer";
import { useChecks } from "./hooks/useChecks";
import { EffectManager } from "./components/EffectManager";
import { chainApi, type Effect, type EffectChain } from "./effects";
import { SelectionPanel } from "./components/SelectionPanel";
import { AliasField, ItemDetail } from "./components/ItemDetail";
import { CreditPanel } from "./components/CreditPanel";
import { OtherPanel } from "./components/OtherPanel";
import { OTHER_ITEMS, type OtherKey } from "./otherFilters";
import { CreditForm } from "./components/CreditForm";
import { CreditField } from "./components/CreditField";
import { Splitter } from "./components/Splitter";
import { useStoredNumber } from "./storage";

type Status = { text: string; error: boolean };

const EMPTY_FILTER: FileFilter = {
  text: "",
  tagIds: [],
  untaggedOnly: false,
  missingOnly: false,
  duplicatesOnly: false,
  hash: null,
  sourceIds: [],
  noSource: false,
  licenseIds: [],
  noLicense: false,
  fileIds: null,
  folderId: null,
  recentOnly: false,
};

/** ファイルの一覧を再生するときの、再生の欄の名前 */
const LIST_NAME = "ファイルの一覧";

/** 並びをばらばらにした写し（フィッシャー–イェーツ） */
function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 「ファイルを紐づける」で選べるファイル（スキャンの対象と同じ拡張子） */
const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "m4a"];

/** 出典・ライセンスの絞り込みの条件を持つ FileFilter の項目 */
const FILTER_KEYS = {
  source: { ids: "sourceIds", none: "noSource" },
  license: { ids: "licenseIds", none: "noLicense" },
} as const;

/** 左・右の欄の最小の幅と、中央の欄に残す最小の幅 */
const SIDE_MIN = 180;
const MAIN_MIN = 320;

export default function App() {
  const [sideWidth, setSideWidth, commitSideWidth] = useStoredNumber("cyanomelody.width.side", 280);
  const [detailWidth, setDetailWidth, commitDetailWidth] = useStoredNumber("cyanomelody.width.detail", 300);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [filter, setFilter] = useState<FileFilter>(EMPTY_FILTER);
  const [text, setText] = useState("");
  /** クリックして右の欄に出しているファイル */
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [checkedOnly, setCheckedOnly] = useState(false);
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
  const [chains, setChains] = useState<EffectChain[]>([]);
  /**
   * エフェクトセットの管理画面。開いた元の項目（作ったエフェクトセットを設定する項目）と、試聴するファイル。
   * fx のプルダウンの「新しいfxを作る」「このfxを編集」から開く
   */
  const [effectDialog, setEffectDialog] = useState<{
    target: PreviewTarget | null;
    itemIds: number[];
    chainId: number | null;
    /** 「新しいfxを作る」から開いた（保存していない新しいエフェクトセットを出す） */
    startNew: boolean;
  } | null>(null);
  const [hashProgress, setHashProgress] = useState<HashProgress | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistNode[]>([]);
  /** 中央で開いているプレイリスト（null ならファイルの一覧を出す） */
  const [openPlaylistId, setOpenPlaylistId] = useState<number | null>(null);
  const [playlistDetail, setPlaylistDetail] = useState<PlaylistDetail | null>(null);
  /** 詳細画面で押して、右の欄に出している項目 */
  const [focusedItemId, setFocusedItemId] = useState<number | null>(null);
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
  });

  // 「チェックしたファイルだけ表示」のときだけ、チェックが変わったら読み直す
  const checkedFilter = checkedOnly ? checked : null;
  const reloadFiles = useCallback(async () => {
    const request = { ...filter, fileIds: checkedFilter ? [...checkedFilter] : null };
    const [list, counts] = await Promise.all([api.listFiles(request), api.facetCounts(request)]);
    setFiles(list);
    setFacets(counts);
    setListVersion((v) => v + 1);
    // 絞り込みで消えたファイルは、右の欄からも消す
    setFocusedId((prev) => (prev !== null && list.some((f) => f.id === prev) ? prev : null));
  }, [filter, checkedFilter]);

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

  // ハッシュ値の計算の進み具合。終わったら一覧を読み直す（重複や、右の欄のファイルのハッシュ値が変わるため）
  const reloadAllRef = useRef(reloadAll);
  useEffect(() => {
    reloadAllRef.current = reloadAll;
  }, [reloadAll]);
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

  // ファイル名の入力は少し待ってから絞り込む
  useEffect(() => {
    const timer = setTimeout(() => setFilter((f) => (f.text === text ? f : { ...f, text })), 200);
    return () => clearTimeout(timer);
  }, [text]);

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
      setFilter({ ...EMPTY_FILTER, folderId: r.folderId });
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
      setFilter((f) => (f.folderId === folder.id ? { ...f, folderId: null } : f));
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

  // チェックしたファイルに付いているタグと件数（ファイルの一覧の、チェックの操作の行に出す）
  const [checkedTags, setCheckedTags] = useState<{ id: number; name: string; count: number }[]>([]);
  useEffect(() => {
    if (checked.size === 0) return;
    let alive = true;
    api
      .checkedTagCounts([...checked])
      .then((list) => alive && setCheckedTags(list))
      .catch(showError);
    return () => {
      alive = false;
    };
  }, [checked, dataVersion]);

  /** チェックしたファイルすべてから、タグを外す（確認してから） */
  const removeTagFromChecked = async (tag: { id: number; name: string; count: number }) => {
    if (!(await confirmDialog(`チェックした${tag.count}件から、タグ「${tag.name}」を外しますか？`))) return;
    run(async () => {
      await api.removeTag(checks.ids(), tag.id);
      showInfo(`${tag.count}件からタグ「${tag.name}」を外しました`);
    });
  };

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

  /** 絞り込み・チェック・右の欄の表示を、すべて解除する */
  const clearAll = () => {
    setText("");
    setCheckedOnly(false);
    setFilter(EMPTY_FILTER);
    checks.clear();
    setFocusedId(null);
  };

  const showSameAudio = (hash: string) => {
    setText("");
    setCheckedOnly(false);
    setFilter({ ...EMPTY_FILTER, hash });
  };

  /** フォルダを選んで、そのまま登録する */
  const browseAndAddFolder = async () => {
    const path = await pickPath({ directory: true }).catch(showError);
    if (typeof path === "string") await addFolder(path);
  };

  const toggleTag = (tagId: number) =>
    setFilter((f) => ({
      ...f,
      untaggedOnly: false,
      tagIds: f.tagIds.includes(tagId) ? f.tagIds.filter((id) => id !== tagId) : [...f.tagIds, tagId],
    }));

  const toggleUntagged = () => setFilter((f) => ({ ...f, tagIds: [], untaggedOnly: !f.untaggedOnly }));

  /** 削除・統合したタグを、絞り込みの条件から外す・置き換える */
  const replaceFilterTag = (from: number, to: number | null) =>
    setFilter((f) => {
      if (!f.tagIds.includes(from)) return f;
      const ids = f.tagIds.filter((id) => id !== from);
      if (to !== null && !ids.includes(to)) ids.push(to);
      return { ...f, tagIds: ids };
    });

  const createTag = async (name: string) => 
    run(async () => {
      await api.createTag(name);
      showInfo(`タグ「${name.trim()}」を作成しました`);
    });

  const renameTag = async (tag: Tag, name: string) => {
    const newName = name.trim();
    const other = tags.find((t) => t.id !== tag.id && t.name.toLowerCase() === newName.toLowerCase());
    if (
      other &&
      !(await confirmDialog(
        `タグ「${other.name}」が既にあります。\n「${tag.name}」を「${other.name}」に統合しますか？\n` +
          `「${tag.name}」が付いたファイルに「${other.name}」が付き、「${tag.name}」は削除されます。` +
          "\n子のタグがあれば、統合先の子の最後に移ります。",
      ))
    ) {
      return false;
    }
    return run(async () => {
      const r = await api.renameTag(tag.id, newName, other !== undefined);
      if (r.merged) {
        replaceFilterTag(tag.id, r.tagId);
        showInfo(`タグ「${tag.name}」を「${other?.name}」に統合しました`);
      } else {
        showInfo(`タグ「${tag.name}」の名前を「${newName}」に変えました`);
      }
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
      replaceFilterTag(tag.id, null);
      showInfo(`タグ「${tag.name}」を削除しました`);
    });
  };

  const moveTag = (tag: Tag, target: MoveTarget) =>
    run(async () => {
      await api.moveTag(tag.id, target);
      showInfo(`タグ「${tag.name}」を移しました`);
    });

  const creditsOf = (kind: CreditKind) => (kind === "source" ? sources : licenses);

  /** 出典どうし・ライセンスどうしはOR。「なし」とは同時に選べない */
  const toggleCredit = (kind: CreditKind, id: number) => {
    const k = FILTER_KEYS[kind];
    setFilter((f) => ({
      ...f,
      [k.none]: false,
      [k.ids]: f[k.ids].includes(id) ? f[k.ids].filter((x) => x !== id) : [...f[k.ids], id],
    }));
  };

  const toggleCreditNone = (kind: CreditKind) => {
    const k = FILTER_KEYS[kind];
    setFilter((f) => ({ ...f, [k.ids]: [], [k.none]: !f[k.none] }));
  };

  const removeFilterCredit = (kind: CreditKind, id: number) => {
    const k = FILTER_KEYS[kind];
    setFilter((f) => (f[k.ids].includes(id) ? { ...f, [k.ids]: f[k.ids].filter((x) => x !== id) } : f));
  };

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
      removeFilterCredit(kind, credit.id);
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
    setOpenPlaylistId(id);
    setFocusedItemId(null);
    playlistApi.get(id).then(setPlaylistDetail).catch(showError);
  };

  const closePlaylist = () => {
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

  /** 「その他」の条件（重複・直近で再生・リンク切れ）を選ぶ・外す */
  const toggleOther = (key: OtherKey) => setFilter((f) => ({ ...f, [key]: !f[key] }));

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

  /** 絞り込みの条件だけをすべて外す（チェックと右の欄の表示はそのまま） */
  const clearConditions = () => {
    setText("");
    setFilter(EMPTY_FILTER);
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

  /** 右の欄に出しているファイルに、エフェクトをかけて試聴する */
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
  const setPlaylistItemChain = (items: PlaylistItem[], chainId: number | null) =>
    run(async () => {
      for (const item of items) await chainApi.setItemChain(item.id, chainId);
      if (items.length > 1) showInfo(`${items.length}件の項目の fx を変えました`);
    });

  /**
   * エフェクトセットの管理画面を開く。試聴するのは、その項目の曲（タグの組み合わせ・プレイリストの項目は中の最初の曲）。
   * chainId を選んだ状態で開き、作ったエフェクトセットは itemIds の項目に付ける
   */
  const openEffects = async (item: PlaylistItem, chainId: number | null, itemIds: number[]) => {
    const first = (await playlistApi.itemFiles(item.id).catch(() => []))[0];
    const target = first ? { id: first.fileId, relPath: first.relPath, path: first.path } : null;
    setEffectDialog({ target, itemIds, chainId, startNew: chainId === null });
  };

  /** 管理画面で作ったエフェクトセットを、開いた元の項目に付ける */
  const attachCreatedChain = (chainId: number) => {
    const ids = effectDialog?.itemIds ?? [];
    if (ids.length === 0) return;
    run(async () => {
      for (const id of ids) await chainApi.setItemChain(id, chainId);
    });
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

  const playPlaylist = async (id: number, mode: PlayMode = "order") => {
    try {
      const queue = await playlistApi.expand(id, mode);
      if (queue.length === 0) {
        showInfo(`「${playlistName(id)}」には再生するファイルがありません`);
        return;
      }
      audio.playQueue(playlistName(id), queue, 0, id);
    } catch (e) {
      showError(e);
    }
  };

  /**
   * 表示中のファイルの一覧を、プレイリストのように再生する（試聴）。見つからないファイルは除く。
   * 再生を始めたときの一覧で再生し、途中で絞り込みを変えても順番は変わらない。start があればその曲から
   */
  const playList = (mode: PlayMode, start?: AudioFile) => {
    let queue: PlayEntry[] = files
      .filter((f) => !f.missing)
      .map((f) => ({ fileId: f.id, relPath: f.relPath, path: f.path, alias: null, effects: [], itemId: null }));
    if (queue.length === 0) {
      showInfo("再生するファイルがありません");
      return;
    }
    if (mode === "shuffle") queue = shuffled(queue);
    if (mode === "random") queue = [queue[Math.floor(Math.random() * queue.length)]];
    const index = start ? Math.max(0, queue.findIndex((e) => e.fileId === start.id)) : 0;
    audio.playQueue(LIST_NAME, queue, index);
  };

  /** 鳴らしているファイル（一覧の再生・プレイリストの再生・エフェクトの試聴） */
  const playingFileId = audio.previewId ?? audio.player?.queue[audio.player.index]?.fileId ?? null;

  /** 一覧の行の「▶」：その行から一覧を再生する。鳴らしている行なら止める */
  const toggleRowPlay = (file: AudioFile) => {
    if (playingFileId === file.id) audio.stop();
    else playList("order", file);
  };

  const playPlaylistItem = async (item: PlaylistItem) => {
    try {
      const queue = await playlistApi.expandItem(item.id);
      if (queue.length === 0) {
        showInfo("再生するファイルがありません");
        return;
      }
      audio.playQueue(playlistDetail?.name ?? "", queue, 0, playlistDetail?.id ?? null);
    } catch (e) {
      showError(e);
    }
  };

  // 選んでいる絞り込みの条件（一覧の上にチップで出す。押すとその条件だけ外す）
  const nameOf = (list: { id: number; name: string }[], id: number) => list.find((x) => x.id === id)?.name ?? "?";
  const filterChips: FilterChip[] = [];
  if (filter.folderId !== null) {
    const folder = folders.find((f) => f.id === filter.folderId);
    filterChips.push({
      key: "folder",
      icon: "📁",
      label: folder ? baseName(folder.path) : "?",
      title: folder?.path,
      onRemove: () => setFilter((f) => ({ ...f, folderId: null })),
    });
  }
  if (filter.untaggedOnly) filterChips.push({ key: "untagged", icon: "🏷", label: "タグなし", onRemove: toggleUntagged });
  for (const id of filter.tagIds) {
    filterChips.push({ key: `tag-${id}`, icon: "🏷", label: nameOf(tags, id), onRemove: () => toggleTag(id) });
  }
  for (const kind of ["source", "license"] as const) {
    const k = FILTER_KEYS[kind];
    const icon = kind === "source" ? "🔗" : "⚖";
    if (filter[k.none]) {
      filterChips.push({ key: `${kind}-none`, icon, label: `${CREDIT_LABEL[kind]}なし`, onRemove: () => toggleCreditNone(kind) });
    }
    for (const id of filter[k.ids]) {
      filterChips.push({
        key: `${kind}-${id}`,
        icon,
        label: nameOf(creditsOf(kind), id),
        title: CREDIT_LABEL[kind],
        onRemove: () => toggleCredit(kind, id),
      });
    }
  }
  for (const item of OTHER_ITEMS) {
    if (filter[item.key]) {
      filterChips.push({ key: item.key, icon: item.icon, label: item.chip, title: item.label, onRemove: () => toggleOther(item.key) });
    }
  }
  if (filter.hash) {
    const hash = filter.hash;
    filterChips.push({
      key: "hash",
      icon: "🔊",
      label: "同じ音声",
      title: hash,
      onRemove: () => setFilter((f) => ({ ...f, hash: null })),
      testId: "hash-filter",
    });
  }

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
            <input type="text" placeholder="検索" value={text} onChange={(e) => setText(e.target.value)} aria-label="検索" />
          </div>
          <FilterChips chips={filterChips} onClearAll={clearConditions} />
        </div>
        <FolderPanel
          folders={folders}
          busy={busy}
          onAdd={browseAndAddFolder}
          onRemove={removeFolder}
          onScan={(f) => scan([f])}
          selectedId={filter.folderId}
          onSelect={(id) => setFilter((f) => ({ ...f, folderId: f.folderId === id ? null : id }))}
        />
        <TagPanel
          tags={tags}
          filter={filter}
          onToggleTag={toggleTag}
          onToggleUntagged={toggleUntagged}
          onCreate={createTag}
          onRename={renameTag}
          onDelete={deleteTag}
          facets={facets}
          busy={busy}
          onMove={moveTag}
        />
        <PlaylistPanel
          playlists={playlists}
          openId={openPlaylistId}
          busy={busy}
          onOpen={openPlaylist}
          onCreate={(name) => createPlaylist(name)}
          onMove={movePlaylist}
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
          />
        ))}
        <OtherPanel filter={filter} onToggle={toggleOther} facets={facets} />
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
            onRename={(name) => renamePlaylist(playlistDetail.id, name)}
            onDelete={() => deletePlaylist(playlistDetail.id)}
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
            onFocusItem={(item) => setFocusedItemId(item.id)}
            chains={chains}
            onSetChain={setPlaylistItemChain}
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
            </div>
            {/* チェックの操作は、チェックがあるときだけ出す（件数は下の行に出す） */}
            {(checked.size > 0 || checkedOnly) && (
              <div className="toolbar">
                <button onClick={() => checks.checkShown(true)} disabled={checks.shownChecked === files.length}>
                  全てチェック
                </button>
                <button onClick={checks.clear} disabled={checked.size === 0}>
                  チェックをすべて外す
                </button>
                <label>
                  <input type="checkbox" checked={checkedOnly} onChange={(e) => setCheckedOnly(e.target.checked)} />
                  チェックしたファイルだけ表示
                </label>
                {/* チェックしたファイルに付いているタグ。名前・件数・✕（押すとチェックしたファイルすべてから外す） */}
                {checked.size > 0 && checkedTags.length > 0 && (
                  <div className="filter-chips checked-tags" data-testid="checked-tags">
                    {checkedTags.map((t) => (
                      <button
                        key={t.id}
                        className="chip filter-chip"
                        onClick={() => removeTagFromChecked(t)}
                        disabled={busy}
                        title="押すと、チェックしたファイルすべてから外す"
                        aria-label={`${t.name}をチェックしたファイルから外す`}
                        data-testid="checked-tag"
                        data-tag-name={t.name}
                      >
                        <span className="chip-icon">🏷</span>
                        {t.name}
                        <span className="chip-count">{t.count}</span>
                        <span className="chip-x">✕</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <FileList
              files={files}
              focusedId={focusedId}
              checked={checked}
              playingId={playingFileId}
              progress={audio.time.duration > 0 ? audio.time.current / audio.time.duration : 0}
              onFocus={(f) => setFocusedId(f.id)}
              onCheck={checks.checkRow}
              onCheckShown={checks.checkShown}
              onPlay={toggleRowPlay}
              showHash={filter.duplicatesOnly || filter.hash !== null}
              onDrop={dropFiles}
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
        {/* ファイルの項目は、ファイルを読み終えてから右の欄に出す（読む間に別の欄を出すと、入力が消えるため） */}
        {focusedItem && itemFileId === null && (
          <ItemDetail
            key={focusedItem.id}
            item={focusedItem}
            busy={busy}
            onSave={(alias) => setPlaylistItemAlias(focusedItem, alias)}
            dataVersion={dataVersion}
          />
        )}
        <SelectionPanel
          file={focusedFile}
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
        onPlayOpen={(mode) => (playlistDetail ? playPlaylist(playlistDetail.id, mode) : playList(mode))}
        onSeek={audio.seek}
        onPrev={audio.prev}
        onNext={audio.next}
        onTogglePause={audio.togglePause}
        onStop={audio.stop}
        previewFile={audio.previewFile}
        volume={audio.volume}
        onVolume={audio.setVolume}
        onVolumeCommit={audio.commitVolume}
      />
      <div className="status-bar">
        <div className={`status${status.error ? " error" : ""}`} data-testid="status" data-run-count={runCount}>
          {busy ? "処理中…" : status.text || " "}
        </div>
        {/* 一覧の件数と、チェックしている件数（0件のときも常に出す） */}
        <div className="counts" data-testid="counts" data-list-version={listVersion}>
          <span data-testid="file-count">{files.length}件</span>
          <span className="checked-count" data-testid="checked-count">
            チェック {checked.size}件（表示中 {checks.shownChecked}件）
          </span>
        </div>
        {exportProgress && (
          <div className="hash-status" data-testid="export-status">
            {describeExport(exportProgress)}
            {/* 書き出したフォルダは、押すとエクスプローラーで見せる（渡すときに探さなくてよい） */}
            {!exportProgress.running && (
              <a
                href="#"
                className="folder-link"
                title="エクスプローラーで見せる"
                data-testid="export-folder"
                onClick={(e) => {
                  e.preventDefault();
                  revealItemInDir(exportProgress.folder).catch(showError);
                }}
              >
                {exportProgress.folder}
              </a>
            )}
            {exportProgress.running && (
              <button onClick={() => playlistApi.cancelExport().catch(showError)}>中止</button>
            )}
          </div>
        )}
        {hashProgress && (
          <div className="hash-status" data-testid="hash-status">
            {describeHashing(hashProgress)}
            {hashProgress.running && <button onClick={() => api.cancelHashing().catch(showError)}>中止</button>}
          </div>
        )}
      </div>
      <audio {...audio.audioProps} />
      {effectDialog && (
        <EffectManager
          chains={chains}
          busy={busy}
          initialChainId={effectDialog.chainId}
          startNew={effectDialog.startNew}
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
