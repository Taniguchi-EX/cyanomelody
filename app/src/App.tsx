import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, describeScan, type AudioFile, type FileFilter, type LibraryFolder, type Tag } from "./api";
import { FolderPanel } from "./components/FolderPanel";
import { TagPanel } from "./components/TagPanel";
import { FileList, type SelectMode } from "./components/FileList";
import { SelectionPanel } from "./components/SelectionPanel";

type Status = { text: string; error: boolean };

const EMPTY_FILTER: FileFilter = { text: "", tagIds: [], untaggedOnly: false, missingOnly: false };

export default function App() {
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [filter, setFilter] = useState<FileFilter>(EMPTY_FILTER);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ text: "", error: false });
  const audioRef = useRef<HTMLAudioElement>(null);

  const showError = (e: unknown) => setStatus({ text: String(e), error: true });
  const showInfo = (text: string) => setStatus({ text, error: false });

  const reloadFiles = useCallback(async () => {
    const list = await api.listFiles(filter);
    setFiles(list);
    // 絞り込みで消えたファイルは選択から外す
    const ids = new Set(list.map((f) => f.id));
    setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
  }, [filter]);

  const reloadAll = useCallback(async () => {
    const [fs, ts] = await Promise.all([api.listFolders(), api.listTags()]);
    setFolders(fs);
    setTags(ts);
    await reloadFiles();
  }, [reloadFiles]);

  useEffect(() => {
    reloadAll().catch(showError);
  }, [reloadAll]);

  // ファイル名の入力は少し待ってから絞り込む
  useEffect(() => {
    const timer = setTimeout(() => setFilter((f) => (f.text === text ? f : { ...f, text })), 200);
    return () => clearTimeout(timer);
  }, [text]);

  /** 処理中は操作できないようにし、終わったら一覧を読み直す */
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
      await reloadAll().catch(showError);
    }
  };

  const selectedFiles = useMemo(() => files.filter((f) => selected.has(f.id)), [files, selected]);
  const selectedIds = () => selectedFiles.map((f) => f.id);

  const select = (index: number, mode: SelectMode) => {
    const id = files[index].id;
    if (mode === "range" && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      setSelected(new Set(files.slice(from, to + 1).map((f) => f.id)));
      return;
    }
    if (mode === "toggle") {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      setSelected(new Set([id]));
    }
    setAnchor(index);
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
    });
    return ok;
  };

  const removeFolder = (folder: LibraryFolder) => {
    const message =
      `「${folder.path}」の登録を解除しますか？\n` +
      `このフォルダのファイル${folder.fileCount}件の情報と、付けたタグがアプリから消えます。\n` +
      "実際のファイルは消えません。";
    if (!window.confirm(message)) return;
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
    });

  const addTag = async (name: string) => {
    let ok = false;
    await run(async () => {
      await api.addTag(selectedIds(), name);
      showInfo(`${selectedFiles.length}件にタグ「${name.trim()}」を付けました`);
      ok = true;
    });
    return ok;
  };

  const removeTag = (tagId: number) =>
    run(async () => {
      await api.removeTag(selectedIds(), tagId);
      showInfo("タグを外しました");
    });

  const removeMissing = () => {
    const targets = selectedFiles.filter((f) => f.missing);
    if (!window.confirm(`見つからないファイル${targets.length}件をライブラリから外しますか？\n付けたタグも消えます。`)) return;
    run(async () => {
      const n = await api.removeMissingFiles(targets.map((f) => f.id));
      showInfo(`${n}件をライブラリから外しました`);
    });
  };

  const toggleTag = (tagId: number) =>
    setFilter((f) => ({
      ...f,
      untaggedOnly: false,
      tagIds: f.tagIds.includes(tagId) ? f.tagIds.filter((id) => id !== tagId) : [...f.tagIds, tagId],
    }));

  const toggleUntagged = () => setFilter((f) => ({ ...f, tagIds: [], untaggedOnly: !f.untaggedOnly }));

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
        <TagPanel tags={tags} filter={filter} onToggleTag={toggleTag} onToggleUntagged={toggleUntagged} />
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
          {(filter.tagIds.length > 0 || filter.untaggedOnly || filter.missingOnly || text) && (
            <button
              onClick={() => {
                setText("");
                setFilter(EMPTY_FILTER);
              }}
            >
              絞り込みを解除
            </button>
          )}
          <span className="sub" data-testid="file-count">
            {files.length}件{selected.size > 0 && `（${selected.size}件を選択中）`}
          </span>
        </div>
        <FileList
          files={files}
          selected={selected}
          playingId={playingId}
          onSelect={select}
          onSelectAll={() => setSelected(new Set(files.map((f) => f.id)))}
          onPlay={play}
        />
      </main>

      <aside className="detail">
        <SelectionPanel
          files={selectedFiles}
          tags={tags}
          busy={busy}
          onAddTag={addTag}
          onRemoveTag={removeTag}
          onRemoveMissing={removeMissing}
        />
      </aside>

      <div className={`status${status.error ? " error" : ""}`} data-testid="status">
        {busy ? "処理中…" : status.text || " "}
      </div>
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} />
    </div>
  );
}
