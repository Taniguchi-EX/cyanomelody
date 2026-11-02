import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
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
  type FileSummary,
  type HashProgress,
  type LibraryFolder,
  type LicenseType,
  type MoveTarget,
  type Tag,
} from "./api";
import { CREDIT_LABEL } from "./credits";
import { confirmDialog } from "./confirm";
import { AUDIO_EXTENSIONS } from "./audio";
import { FolderPanel } from "./components/FolderPanel";
import { TagPanel } from "./components/TagPanel";
import { FileList } from "./components/FileList";
import { BulkBar } from "./components/BulkBar";
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
  /** チェックしたファイル。絞り込みを変えても外れない */
  const [checked, setChecked] = useState<Set<number>>(new Set());
  /** Shift+クリックでの範囲のチェックの起点（ファイルのid。絞り込みを変えても同じファイルを指す） */
  const [checkAnchor, setCheckAnchor] = useState<number | null>(null);
  const [checkedOnly, setCheckedOnly] = useState(false);
  const [summary, setSummary] = useState<FileSummary | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ text: "", error: false });
  const [managing, setManaging] = useState(false);
  const [sources, setSources] = useState<Credit[]>([]);
  const [licenses, setLicenses] = useState<Credit[]>([]);
  const [licenseTypes, setLicenseTypes] = useState<LicenseType[]>([]);
  const [managingCredit, setManagingCredit] = useState<CreditKind | null>(null);
  const [hashProgress, setHashProgress] = useState<HashProgress | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchPath, setSearchPath] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  const showError = (e: unknown) => setStatus({ text: String(e), error: true });
  const showInfo = (text: string) => setStatus({ text, error: false });

  // 「チェックしたファイルだけ」のときだけ、チェックが変わったら読み直す
  const checkedFilter = checkedOnly ? checked : null;
  const reloadFiles = useCallback(async () => {
    const list = await api.listFiles({ ...filter, fileIds: checkedFilter ? [...checkedFilter] : null });
    setFiles(list);
    // 絞り込みで消えたファイルは、右の欄からも消す
    setFocusedId((prev) => (prev !== null && list.some((f) => f.id === prev) ? prev : null));
  }, [filter, checkedFilter]);

  const reloadAll = useCallback(async () => {
    const [fs, ts, ss, ls] = await Promise.all([
      api.listFolders(),
      api.listTags(),
      api.listCredits("source"),
      api.listCredits("license"),
    ]);
    setFolders(fs);
    setTags(ts);
    setSources(ss);
    setLicenses(ls);
    await reloadFiles();
  }, [reloadFiles]);

  useEffect(() => {
    reloadAll().catch(showError);
  }, [reloadAll]);

  useEffect(() => {
    api.licenseTypes().then(setLicenseTypes).catch(showError);
  }, []);

  // ハッシュ値の計算の進み具合。終わったら一覧を読み直す（重複や、選んだファイルのハッシュ値が変わるため）
  const reloadAllRef = useRef(reloadAll);
  reloadAllRef.current = reloadAll;
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

  // チェックしたファイルの内訳。データが変わると一覧も読み直されるので、一覧が変わるたびに求め直す。
  // ライブラリから消えたファイル（登録解除など）は、チェックから外す
  useEffect(() => {
    if (checked.size === 0) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    api
      .summarizeFiles([...checked])
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
        if (s.ids.length !== checked.size) setChecked(new Set(s.ids));
      })
      .catch(showError);
    return () => {
      cancelled = true;
    };
  }, [checked, files]);

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
  const shownChecked = useMemo(() => files.reduce((n, f) => n + (checked.has(f.id) ? 1 : 0), 0), [files, checked]);

  /** 行のチェックボックス。range なら起点との間をまとめて、押した行の新しい状態にそろえる */
  const checkRow = (index: number, range: boolean) => {
    const on = !checked.has(files[index].id);
    // 起点のファイルが今の一覧にないときは、押した行だけ
    const anchorIndex = range && checkAnchor !== null ? files.findIndex((f) => f.id === checkAnchor) : -1;
    const [from, to] = anchorIndex >= 0 ? [Math.min(anchorIndex, index), Math.max(anchorIndex, index)] : [index, index];
    setChecked((prev) => {
      const next = new Set(prev);
      for (const f of files.slice(from, to + 1)) {
        if (on) next.add(f.id);
        else next.delete(f.id);
      }
      return next;
    });
    setCheckAnchor(files[index].id);
  };

  const checkShown = (on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const f of files) {
        if (on) next.add(f.id);
        else next.delete(f.id);
      }
      return next;
    });

  const clearChecks = () => {
    setChecked(new Set());
    setCheckAnchor(null);
  };

  const play = (file: AudioFile) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingId === file.id) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    audio.src = convertFileSrc(file.path);
    setPlayingId(file.id);
    audio.play().catch((e) => {
      setPlayingId(null);
      showError(`再生できませんでした: ${file.relPath}（${e}）`);
    });
  };

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
  const checkedIds = () => [...checked];

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
      await api.addTag(checkedIds(), name);
      showInfo(`チェックした${checked.size}件にタグ「${name.trim()}」を付けました`);
    });

  const bulkRemoveTag = (tag: Tag) =>
    bulk(`チェックした${checked.size}件からタグ「${tag.name}」を外しますか？`, async () => {
      await api.removeTag(checkedIds(), tag.id);
      showInfo(`チェックした${checked.size}件からタグ「${tag.name}」を外しました`);
    });

  const bulkSetCredit = (kind: CreditKind, name: string) => {
    const label = CREDIT_LABEL[kind];
    return bulk(`チェックした${checked.size}件に${label}「${name.trim()}」を設定しますか？`, async () => {
      await api.setFileCredit(kind, checkedIds(), name);
      showInfo(`チェックした${checked.size}件に${label}「${name.trim()}」を設定しました`);
    });
  };

  const bulkClearCredit = (kind: CreditKind) => {
    const label = CREDIT_LABEL[kind];
    return bulk(`チェックした${checked.size}件の${label}を外しますか？`, async () => {
      await api.setFileCredit(kind, checkedIds(), null);
      showInfo(`チェックした${checked.size}件の${label}を外しました`);
    });
  };

  const bulkRelink = async () => {
    const message = `チェックしたうち、見つからないファイル${summary?.missing ?? 0}件をひも付け直しますか？`;
    if (!(await confirmDialog(message))) return;
    relink(checkedIds());
  };

  const creditKinds: CreditKind[] = ["source", "license"];

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
            onToggle={(id) => toggleCredit(kind, id)}
            onToggleNone={() => toggleCreditNone(kind)}
            onManage={() => setManagingCredit(kind)}
          />
        ))}
      </aside>

      <main className="main">
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
          {(filter.tagIds.length > 0 ||
            filter.untaggedOnly ||
            filter.missingOnly ||
            filter.duplicatesOnly ||
            filter.hash ||
            filter.sourceIds.length > 0 ||
            filter.noSource ||
            filter.licenseIds.length > 0 ||
            filter.noLicense ||
            checkedOnly ||
            text) && (
            <button
              onClick={() => {
                setText("");
                setCheckedOnly(false);
                setFilter(EMPTY_FILTER);
              }}
            >
              絞り込みを解除
            </button>
          )}
          <span className="sub" data-testid="file-count">
            {files.length}件
          </span>
          <span className="checked-count" data-testid="checked-count">
            チェック {checked.size}件（表示中 {shownChecked}件）
          </span>
          <button onClick={clearChecks} disabled={checked.size === 0}>
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
            summary={summary}
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
            onRemoveMissing={() => removeMissing(checkedIds(), summary?.missing ?? 0)}
            onError={showError}
          />
        )}
        <FileList
          files={files}
          focusedId={focusedId}
          checked={checked}
          playingId={playingId}
          onFocus={(f) => setFocusedId(f.id)}
          onCheck={checkRow}
          onCheckShown={checkShown}
          onPlay={play}
          showHash={filter.duplicatesOnly || filter.hash !== null}
        />
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
        <div className={`status${status.error ? " error" : ""}`} data-testid="status">
          {busy ? "処理中…" : status.text || " "}
        </div>
        {hashProgress && (
          <div className="hash-status" data-testid="hash-status">
            {describeHashing(hashProgress)}
            {hashProgress.running && <button onClick={() => api.cancelHashing().catch(showError)}>中止</button>}
          </div>
        )}
      </div>
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} />
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
