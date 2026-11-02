import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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
  type MoveTarget,
  playlistApi,
  type PlayMode,
  type PlaylistDetail,
  type PlaylistItem,
  type PlaylistNode,
  type Tag,
} from "./api";
import { CREDIT_LABEL } from "./credits";
import { confirmDialog } from "./confirm";
import { AUDIO_EXTENSIONS } from "./audio";
import { FolderPanel } from "./components/FolderPanel";
import { TagPanel } from "./components/TagPanel";
import { FileList } from "./components/FileList";
import { BulkBar } from "./components/BulkBar";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { PlaylistEditor } from "./components/PlaylistEditor";
import { PlayerBar } from "./components/PlayerBar";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useChecks } from "./hooks/useChecks";
import { EffectManager } from "./components/EffectManager";
import { chainApi, type Effect, type EffectChain } from "./effects";
import { SelectionPanel } from "./components/SelectionPanel";
import { TagManager } from "./components/TagManager";
import { CreditPanel } from "./components/CreditPanel";
import { CreditManager } from "./components/CreditManager";
import { CreditField } from "./components/CreditField";

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
};

/** 出典・ライセンスの絞り込みの条件を持つ FileFilter の項目 */
const FILTER_KEYS = {
  source: { ids: "sourceIds", none: "noSource" },
  license: { ids: "licenseIds", none: "noLicense" },
} as const;

export default function App() {
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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ text: "", error: false });
  const [managing, setManaging] = useState(false);
  const [sources, setSources] = useState<Credit[]>([]);
  const [licenses, setLicenses] = useState<Credit[]>([]);
  const [licenseTypes, setLicenseTypes] = useState<LicenseType[]>([]);
  const [managingCredit, setManagingCredit] = useState<CreditKind | null>(null);
  const [chains, setChains] = useState<EffectChain[]>([]);
  const [managingEffects, setManagingEffects] = useState(false);
  const [hashProgress, setHashProgress] = useState<HashProgress | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchPath, setSearchPath] = useState("");
  const [playlists, setPlaylists] = useState<PlaylistNode[]>([]);
  /** 中央で開いているプレイリスト（null ならファイルの一覧を出す） */
  const [openPlaylistId, setOpenPlaylistId] = useState<number | null>(null);
  const [playlistDetail, setPlaylistDetail] = useState<PlaylistDetail | null>(null);
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
  const audio = useAudioPlayer({ onInfo: showInfo, onError: showError });

  // 「チェックしたファイルだけ」のときだけ、チェックが変わったら読み直す
  const checkedFilter = checkedOnly ? checked : null;
  const reloadFiles = useCallback(async () => {
    const request = { ...filter, fileIds: checkedFilter ? [...checkedFilter] : null };
    const [list, counts] = await Promise.all([api.listFiles(request), api.facetCounts(request)]);
    setFiles(list);
    setFacets(counts);
    // 絞り込みで消えたファイルは、右の欄からも消す
    setFocusedId((prev) => (prev !== null && list.some((f) => f.id === prev) ? prev : null));
  }, [filter, checkedFilter]);

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

  /** 処理中は操作できないようにし、終わったら一覧を読み直す。読み直しが済むまでを処理中とする */
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      showError(e);
    } finally {
      await reloadAll().catch(showError);
      setBusy(false);
    }
  };

  const focusedFile = useMemo(() => files.find((f) => f.id === focusedId) ?? null, [files, focusedId]);
  const focusedIds = () => (focusedFile ? [focusedFile.id] : []);
  const addFolder = async (path: string) => {
    let ok = false;
    await run(async () => {
      const r = await api.addFolder(path);
      showInfo(describeScan(path, r));
      ok = true;
      startHashing();
    });
    return ok;
  };

  const removeFolder = async (folder: LibraryFolder) => {
    const message =
      `「${folder.path}」の登録を解除しますか？\n` +
      `このフォルダのファイル${folder.fileCount}件の情報と、付けたタグ・出典・ライセンスの設定がアプリから消えます。\n` +
      "実際のファイルは消えません。";
    if (!(await confirmDialog(message))) return;
    run(async () => {
      await api.removeFolder(folder.id);
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

  const addTag = async (name: string) => {
    let ok = false;
    await run(async () => {
      await api.addTag(focusedIds(), name);
      showInfo(`タグ「${name.trim()}」を付けました`);
      ok = true;
    });
    return ok;
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

  /** 絞り込み・チェック・右の欄の表示のどれかがあるか */
  const anyActive =
    filter.tagIds.length > 0 ||
    filter.untaggedOnly ||
    filter.missingOnly ||
    filter.duplicatesOnly ||
    filter.hash !== null ||
    filter.sourceIds.length > 0 ||
    filter.noSource ||
    filter.licenseIds.length > 0 ||
    filter.noLicense ||
    checkedOnly ||
    text !== "" ||
    checked.size > 0 ||
    focusedId !== null;

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

  const browseSearchFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "音声ファイル", extensions: [...AUDIO_EXTENSIONS] }],
    });
    if (typeof selected === "string") setSearchPath(selected);
  };

  const searchByFile = () =>
    run(async () => {
      const path = searchPath.trim();
      const hash = await api.hashFile(path);
      showSameAudio(hash);
      setSearching(false);
      setSearchPath("");
      showInfo(`同じ音声のファイルを探しました: ${path}`);
    });

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

  const createTag = async (name: string) => {
    let ok = false;
    await run(async () => {
      await api.createTag(name);
      showInfo(`タグ「${name.trim()}」を作成しました`);
      ok = true;
    });
    return ok;
  };

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
    let ok = false;
    await run(async () => {
      const r = await api.renameTag(tag.id, newName, other !== undefined);
      if (r.merged) {
        replaceFilterTag(tag.id, r.tagId);
        showInfo(`タグ「${tag.name}」を「${other?.name}」に統合しました`);
      } else {
        showInfo(`タグ「${tag.name}」の名前を「${newName}」に変えました`);
      }
      ok = true;
    });
    return ok;
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

  const deleteUnusedTags = async () => {
    const unused = tags.filter((t) => t.fileCount === 0);
    if (!(await confirmDialog(`どのファイルにも付いていないタグ${unused.length}件を削除しますか？`))) return;
    run(async () => {
      const n = await api.deleteUnusedTags();
      for (const t of unused) replaceFilterTag(t.id, null);
      showInfo(`使われていないタグ${n}件を削除しました`);
    });
  };

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

  const createCredit = async (kind: CreditKind, input: CreditInput) => {
    let ok = false;
    await run(async () => {
      await api.createCredit(kind, input);
      showInfo(`${CREDIT_LABEL[kind]}「${input.name.trim()}」を作成しました`);
      ok = true;
    });
    return ok;
  };

  const updateCredit = async (kind: CreditKind, credit: Credit, input: CreditInput) => {
    let ok = false;
    await run(async () => {
      await api.updateCredit(kind, credit.id, input);
      showInfo(`${CREDIT_LABEL[kind]}「${input.name.trim()}」を保存しました`);
      ok = true;
    });
    return ok;
  };

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

  const setFileCredit = async (kind: CreditKind, name: string) => {
    let ok = false;
    await run(async () => {
      await api.setFileCredit(kind, focusedIds(), name);
      showInfo(`${CREDIT_LABEL[kind]}「${name.trim()}」を設定しました`);
      ok = true;
    });
    return ok;
  };

  const clearFileCredit = (kind: CreditKind) =>
    run(async () => {
      await api.setFileCredit(kind, focusedIds(), null);
      showInfo(`${CREDIT_LABEL[kind]}を外しました`);
    });

  // 一括操作。対象はチェックしたファイルすべて（表示していないものも含む）なので、毎回件数を出して確認する

  /** 確認してから実行する。実行したら true */
  const bulk = async (message: string, task: () => Promise<void>) => {
    if (!(await confirmDialog(message))) return false;
    let ok = false;
    await run(async () => {
      await task();
      ok = true;
    });
    return ok;
  };

  const bulkAddTag = (name: string) =>
    bulk(`チェックした${checked.size}件にタグ「${name.trim()}」を付けますか？`, async () => {
      await api.addTag(checks.ids(), name);
      showInfo(`チェックした${checked.size}件にタグ「${name.trim()}」を付けました`);
    });

  const bulkRemoveTag = (tag: Tag) =>
    bulk(`チェックした${checked.size}件からタグ「${tag.name}」を外しますか？`, async () => {
      await api.removeTag(checks.ids(), tag.id);
      showInfo(`チェックした${checked.size}件からタグ「${tag.name}」を外しました`);
    });

  const bulkSetCredit = (kind: CreditKind, name: string) => {
    const label = CREDIT_LABEL[kind];
    return bulk(`チェックした${checked.size}件に${label}「${name.trim()}」を設定しますか？`, async () => {
      await api.setFileCredit(kind, checks.ids(), name);
      showInfo(`チェックした${checked.size}件に${label}「${name.trim()}」を設定しました`);
    });
  };

  const bulkClearCredit = (kind: CreditKind) => {
    const label = CREDIT_LABEL[kind];
    return bulk(`チェックした${checked.size}件の${label}を外しますか？`, async () => {
      await api.setFileCredit(kind, checks.ids(), null);
      showInfo(`チェックした${checked.size}件の${label}を外しました`);
    });
  };

  const bulkRelink = async () => {
    const message = `チェックしたうち、見つからないファイル${checks.summary?.missing ?? 0}件をひも付け直しますか？`;
    if (!(await confirmDialog(message))) return;
    relink(checks.ids());
  };

  const creditKinds: CreditKind[] = ["source", "license"];

  // プレイリスト
  const openPlaylist = (id: number) => {
    setOpenPlaylistId(id);
    playlistApi.get(id).then(setPlaylistDetail).catch(showError);
  };

  const closePlaylist = () => {
    setOpenPlaylistId(null);
    setPlaylistDetail(null);
  };

  const createPlaylist = async (name: string, parent: number | null = null) => {
    let ok = false;
    await run(async () => {
      await playlistApi.create(name, parent);
      showInfo(`プレイリスト「${name.trim()}」を作りました`);
      ok = true;
    });
    return ok;
  };

  const renamePlaylist = async (id: number, name: string) => {
    let ok = false;
    await run(async () => {
      await playlistApi.rename(id, name);
      showInfo(`プレイリストの名前を「${name.trim()}」に変えました`);
      ok = true;
    });
    return ok;
  };

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
  const addToPlaylist = async (playlistId: number, fileIds: number[]) => {
    let ok = false;
    await run(async () => {
      await playlistApi.addFiles(playlistId, fileIds);
      showInfo(`${fileIds.length}件をプレイリスト「${playlistName(playlistId)}」に追加しました`);
      ok = true;
    });
    return ok;
  };

  // 加えるのは元に戻しやすい（編集画面で外せる）ので、確認しない
  const bulkAddToPlaylist = (playlistId: number) => addToPlaylist(playlistId, checks.ids());

  const addTagsToPlaylist = async (tagIds: number[]) => {
    if (!playlistDetail) return false;
    let ok = false;
    await run(async () => {
      await playlistApi.addTags(playlistDetail.id, tagIds);
      showInfo("タグの組み合わせを加えました");
      ok = true;
    });
    return ok;
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

  const movePlaylistItem = (item: PlaylistItem, index: number) =>
    run(async () => {
      await playlistApi.moveItem(item.id, index);
    });

  // エフェクトのまとまり
  const createChain = async (name: string) => {
    let id: number | null = null;
    await run(async () => {
      id = await chainApi.create(name);
      showInfo(`エフェクトのまとまり「${name.trim()}」を作りました`);
    });
    return id;
  };

  const renameChain = async (chain: EffectChain, name: string) => {
    let ok = false;
    await run(async () => {
      await chainApi.rename(chain.id, name);
      showInfo(`エフェクトのまとまりの名前を「${name.trim()}」に変えました`);
      ok = true;
    });
    return ok;
  };

  const deleteChain = async (chain: EffectChain) => {
    let message = `エフェクトのまとまり「${chain.name}」を削除しますか？`;
    if (chain.itemCount > 0) message += `\n結び付けているプレイリストの項目${chain.itemCount}件から外れます。`;
    if (!(await confirmDialog(message))) return;
    await run(async () => {
      await chainApi.remove(chain.id);
      showInfo(`エフェクトのまとまり「${chain.name}」を削除しました`);
    });
  };

  const saveChain = async (chain: EffectChain, effects: Effect[]) => {
    let ok = false;
    await run(async () => {
      await chainApi.setEffects(chain.id, effects);
      showInfo(`エフェクトのまとまり「${chain.name}」を保存しました`);
      ok = true;
    });
    return ok;
  };

  /** 右の欄に出しているファイルに、エフェクトをかけて試聴する */
  const previewChain = async (effects: Effect[]) => {
    const file = focusedFile;
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

  const browseFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    return typeof dir === "string" ? dir : null;
  };

  const setPlaylistItemChain = (item: PlaylistItem, chainId: number | null) =>
    run(async () => {
      await chainApi.setItemChain(item.id, chainId);
    });

  const setPlaylistItemAlias = async (item: PlaylistItem, alias: string) => {
    let ok = false;
    await run(async () => {
      await playlistApi.setItemAlias(item.id, alias);
      showInfo(alias.trim() ? `別名を「${alias.trim()}」にしました` : "別名を外しました");
      ok = true;
    });
    return ok;
  };

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
      audio.playQueue(playlistName(id), queue);
    } catch (e) {
      showError(e);
    }
  };

  const playPlaylistItem = async (item: PlaylistItem) => {
    try {
      const queue = await playlistApi.expandItem(item.id);
      if (queue.length === 0) {
        showInfo("再生するファイルがありません");
        return;
      }
      audio.playQueue(playlistDetail?.name ?? "", queue);
    } catch (e) {
      showError(e);
    }
  };

  return (
    <div className="app">
      <aside className="side">
        <FolderPanel
          folders={folders}
          busy={busy}
          onAdd={addFolder}
          onRemove={removeFolder}
          onScan={(f) => scan([f])}
          onScanAll={() => scan(folders)}
        />
        <TagPanel
          tags={tags}
          filter={filter}
          onToggleTag={toggleTag}
          onToggleUntagged={toggleUntagged}
          onManage={() => setManaging(true)}
          facets={facets}
          busy={busy}
          onMove={moveTag}
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
            onManage={() => setManagingCredit(kind)}
          />
        ))}
        <PlaylistPanel
          playlists={playlists}
          openId={openPlaylistId}
          busy={busy}
          onOpen={openPlaylist}
          onPlay={(id) => playPlaylist(id)}
          onCreate={(name) => createPlaylist(name)}
          onMove={movePlaylist}
          onManageEffects={() => setManagingEffects(true)}
        />
      </aside>

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
            onPlay={(mode) => playPlaylist(playlistDetail.id, mode)}
            onPlayItem={playPlaylistItem}
            onRemoveItem={removePlaylistItem}
            onMoveItem={movePlaylistItem}
            onSetMode={setPlaylistItemMode}
            onSetAlias={setPlaylistItemAlias}
            chains={chains}
            onSetChain={setPlaylistItemChain}
            onAddTags={addTagsToPlaylist}
            onAddRef={addRefToPlaylist}
            onCreateChild={(name) => createPlaylist(name, playlistDetail.id)}
            onExport={(dest) => exportPlaylist(playlistDetail.id, dest)}
            onBrowseFolder={browseFolder}
          />
        ) : (
          <>
            <div className="toolbar">
              <input
                type="text"
                placeholder="ファイル名で絞り込む"
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label="ファイル名で絞り込む"
              />
              <label>
                <input
                  type="checkbox"
                  checked={filter.missingOnly}
                  onChange={(e) => setFilter((f) => ({ ...f, missingOnly: e.target.checked }))}
                />
                見つからないファイルだけ
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={filter.duplicatesOnly}
                  onChange={(e) => setFilter((f) => ({ ...f, duplicatesOnly: e.target.checked }))}
                />
                重複しているファイルだけ
              </label>
              <button onClick={() => setSearching((s) => !s)}>ファイルを指定して探す</button>
              {filter.hash && (
                <span className="chip" data-testid="hash-filter" title={filter.hash}>
                  同じ音声：{filter.hash.slice(0, 12)}…
                </span>
              )}
              {anyActive && (
                <button className="icon clear-all" onClick={clearAll} title="絞り込み・チェック・選択をすべて解除" aria-label="すべて解除">
                  ✕
                </button>
              )}
              <span className="sub" data-testid="file-count">
                {files.length}件
              </span>
              <span className="checked-count" data-testid="checked-count">
                チェック {checked.size}件（表示中 {checks.shownChecked}件）
              </span>
              <button onClick={checks.clear} disabled={checked.size === 0}>
                チェックをすべて外す
              </button>
              <label>
                <input type="checkbox" checked={checkedOnly} onChange={(e) => setCheckedOnly(e.target.checked)} />
                チェックしたファイルだけ
              </label>
            </div>
            {searching && (
              <div className="toolbar">
                <span className="sub">このファイルと同じ音声のファイルを探す：</span>
                <input
                  type="text"
                  placeholder="音声ファイルのパス"
                  value={searchPath}
                  onChange={(e) => setSearchPath(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && searchPath.trim() && searchByFile()}
                  aria-label="探す音声ファイルのパス"
                />
                <button onClick={browseSearchFile} disabled={busy}>
                  参照
                </button>
                <button onClick={searchByFile} disabled={busy || !searchPath.trim()}>
                  探す
                </button>
              </div>
            )}
            {checked.size > 0 && (
              <BulkBar
                checkedCount={checked.size}
                summary={checks.summary}
                tags={tags}
                sources={sources}
                licenses={licenses}
                licenseTypes={licenseTypes}
                busy={busy}
                onAddTag={bulkAddTag}
                onRemoveTag={bulkRemoveTag}
                onSetCredit={bulkSetCredit}
                onClearCredit={bulkClearCredit}
                onRelink={bulkRelink}
                onRemoveMissing={() => removeMissing(checks.ids(), checks.summary?.missing ?? 0)}
                onError={showError}
                playlists={playlists}
                onAddToPlaylist={bulkAddToPlaylist}
              />
            )}
            <FileList
              files={files}
              focusedId={focusedId}
              checked={checked}
              playingId={audio.previewId}
              onFocus={(f) => setFocusedId(f.id)}
              onCheck={checks.checkRow}
              onCheckShown={checks.checkShown}
              onPlay={audio.preview}
              showHash={filter.duplicatesOnly || filter.hash !== null}
          onDropToPlaylist={(ids, playlistId) => addToPlaylist(playlistId, ids)}
            />
          </>
        )}
      </main>

      <aside className="detail">
        <SelectionPanel
          file={focusedFile}
          tags={tags}
          busy={busy}
          onAddTag={addTag}
          onRemoveTag={removeTag}
          onRemoveMissing={() => removeMissing(focusedIds(), 1)}
          onRelink={() => relink(focusedIds())}
          onShowSameAudio={showSameAudio}
          playlists={playlists}
          onAddToPlaylist={(id) => addToPlaylist(id, focusedIds())}
          onOpenPlaylist={openPlaylist}
        >
          {creditKinds.map((kind) => (
            <CreditField
              key={kind}
              kind={kind}
              groups={focusedFile ? [{ id: kind === "source" ? focusedFile.sourceId : focusedFile.licenseId, count: 1 }] : []}
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

      <div className="status-bar">
        {audio.player && (
          <PlayerBar
            player={audio.player}
            time={audio.time}
            onSeek={audio.seek}
            onPrev={audio.prev}
            onNext={audio.next}
            onTogglePause={audio.togglePause}
            onStop={audio.stop}
          />
        )}
        <div className={`status${status.error ? " error" : ""}`} data-testid="status">
          {busy ? "処理中…" : status.text || " "}
        </div>
        {exportProgress && (
          <div className="hash-status" data-testid="export-status">
            {describeExport(exportProgress)}
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
      {managing && (
        <TagManager
          tags={tags}
          busy={busy}
          onCreate={createTag}
          onRename={renameTag}
          onDelete={deleteTag}
          onDeleteUnused={deleteUnusedTags}
          onClose={() => setManaging(false)}
        />
      )}
      {managingEffects && (
        <EffectManager
          chains={chains}
          busy={busy}
          previewFileName={focusedFile?.relPath ?? null}
          onCreate={createChain}
          onRename={renameChain}
          onDelete={deleteChain}
          onSave={saveChain}
          onPreview={previewChain}
          onClose={() => setManagingEffects(false)}
        />
      )}
      {managingCredit && (
        <CreditManager
          key={managingCredit}
          kind={managingCredit}
          credits={creditsOf(managingCredit)}
          licenseTypes={licenseTypes}
          busy={busy}
          onCreate={(input) => createCredit(managingCredit, input)}
          onUpdate={(credit, input) => updateCredit(managingCredit, credit, input)}
          onDelete={(credit) => deleteCredit(managingCredit, credit)}
          onClose={() => setManagingCredit(null)}
        />
      )}
    </div>
  );
}
