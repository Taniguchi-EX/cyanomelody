import { useCallback, useEffect, useState } from "react";
import { api, type CopyFolderStatus, type CopyPreview, type DataSections, type ImportResult } from "../api";
import { confirmDialog } from "../confirm";
import { writeScreen } from "../screenTransfer";
import { dateText, hasNewCopy, replaceWarnings, resultLines, SECTIONS, sectionCount } from "../dataTransferText";

type Props = {
  onError: (e: unknown) => void;
  /** 取り込んだ後（データを読み直す。フォルダをスキャンしたらハッシュ値の計算を始める） */
  onImported: (result: ImportResult) => void;
};

/** 取り込める項目（ライブラリ（フォルダの登録）は、cyanomelody 用のフォルダの中のフォルダで行う） */
const COPY_SECTIONS = SECTIONS.filter((s) => s.key !== "library");
const NONE: DataSections = { library: false, tags: false, playlists: false, credits: false };

/**
 * Android の設定画面の「データ」：Windows からのコピー。
 * Windows が「スマホへコピー」で写した cyanomelody 用のフォルダ（Music/cyanomelody）から取り込む。フォルダは最初に1回だけ設定する。
 * データのファイル（JSON）だけを選んで取り込むこともできる。選んだ項目を Windows のとおりに置き換える
 */
export function CopyFromWindows({ onError, onImported }: Props) {
  const [status, setStatus] = useState<CopyFolderStatus | null>(null);
  const [preview, setPreview] = useState<CopyPreview | null>(null);
  const [sections, setSections] = useState<DataSections>(NONE);
  const [removeOld, setRemoveOld] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);

  const show = (p: CopyPreview) => {
    setPreview(p);
    // ファイルに入っている項目を、最初はすべて選ぶ
    setSections({ ...p.import.sections, library: false });
    setRemoveOld(true);
  };

  /** フォルダの状態を読み、データがあれば見込みを出す */
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const s = await api.copyFolderStatus();
      setStatus(s);
      if (s.readable && s.exportedAt !== null) show(await api.inspectCopyFolder());
      else setPreview(null);
    } catch (e) {
      setPreview(null);
      onError(e);
    } finally {
      setBusy(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const setFolder = async () => {
    setResult(null);
    try {
      if (await api.setCopyFolder()) await load();
    } catch (e) {
      onError(e);
    }
  };

  const chooseFile = async () => {
    setResult(null);
    setBusy(true);
    try {
      const p = await api.pickCopyFile();
      if (p) show(p);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!preview) return;
    const lost = replaceWarnings(preview.import, sections);
    if (removeOld && preview.oldFolders.length > 0) {
      lost.push(`登録を外すフォルダ ${preview.oldFolders.length}件（前に別の場所から写したもの）`);
    }
    const ok = await confirmDialog(
      `選んだ項目を、Windows のとおりに置き換えます。この端末で変えた分は消えます。\n\n消えるもの：\n${lost.map((l) => `・${l}`).join("\n")}\n\nよろしいですか？`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.copyFromWindows(preview.source, sections, removeOld);
      if (r.screen) writeScreen(r.screen, true);
      const lines = resultLines(r, sections);
      if (r.foldersAdded.length || r.foldersScanned || r.foldersRemoved) {
        lines.unshift(
          `フォルダ：登録 ${r.foldersAdded.length}件、スキャン ${r.foldersScanned}件` +
            (r.foldersRemoved ? `、登録を外した ${r.foldersRemoved}件` : ""),
        );
      }
      setResult([...lines, ...r.messages]);
      setPreview(null);
      setStatus(await api.copyFolderStatus());
      onImported(r);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const p = preview?.import;
  const matched = p ? p.matchedByPath + p.matchedByFolder + p.matchedByHash + p.matchedByName : 0;
  const any = sections.tags || sections.playlists || sections.credits;
  return (
    <div className="data-tab" data-testid="copy-from-windows">
      <section>
        <h3>Windows からコピー</h3>
        <p className="sub">
          Windows の設定画面の「データ」の「スマホへコピー」で、USB でつないだこのスマホに曲とデータを写してから、ここで取り込みます。選んだ項目は
          Windows のとおりに置き換わります（この端末で変えた分は消えます）。
        </p>
        <div className="copy-folder" data-testid="copy-folder">
          <div>
            cyanomelody 用のフォルダ：{status?.label ?? "まだ設定していません"}
            {status?.label && !status.readable && <span className="warn">（読めません。設定し直してください）</span>}
          </div>
          {status?.readable && (
            <div className="sub" data-testid="copy-folder-state">
              {status.exportedAt === null
                ? "まだ Windows から写したデータがありません。"
                : `Windows で写した日時：${dateText(status.exportedAt)}` + (hasNewCopy(status) ? "（新しいデータがあります）" : "（取り込み済み）")}
            </div>
          )}
          <div className="row">
            <button onClick={setFolder} disabled={busy} data-testid="copy-set-folder">
              {status?.label ? "フォルダを設定し直す…" : "フォルダを設定する…"}
            </button>
            {status?.readable && status.exportedAt !== null && !preview && (
              <button onClick={() => void load()} disabled={busy}>
                見込みを出す
              </button>
            )}
          </div>
          {!status?.label && (
            <p className="sub">内部ストレージの Music/cyanomelody を選んで「このフォルダを使用」を押します（最初の1回だけ）。</p>
          )}
        </div>
        {preview && p && (
          <div className="import-preview" data-testid="copy-preview">
            <p className="sub">
              {preview.source.kind === "file" ? "選んだデータのファイル" : "cyanomelody 用のフォルダのデータ"}：書き出した日時 {dateText(p.exportedAt)}（v
              {p.appVersion}）
            </p>
            {preview.folders.length > 0 && (
              <div>
                ライブラリに登録するフォルダ
                <ul className="sub" data-testid="copy-folders">
                  {preview.folders.map((f) => (
                    <li key={f.name}>
                      {f.name}（{f.files}件）{f.registered ? "：登録済み。スキャンし直します" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.oldFolders.length > 0 && (
              <label className="data-check">
                <input type="checkbox" checked={removeOld} onChange={(e) => setRemoveOld(e.target.checked)} data-testid="copy-remove-old" />
                前に別の場所から写したフォルダの登録を外す（{preview.oldFolders.map((f) => f.label).join("、")}）
              </label>
            )}
            {COPY_SECTIONS.map((s) => (
              <label key={s.key} className={`data-check${p.sections[s.key] ? "" : " disabled"}`}>
                <input
                  type="checkbox"
                  checked={sections[s.key]}
                  disabled={!p.sections[s.key]}
                  onChange={(e) => setSections((v) => ({ ...v, [s.key]: e.target.checked }))}
                  aria-label={`コピー：${s.label}`}
                />
                {s.label}
                <span className="sub">{p.sections[s.key] ? `：${sectionCount(p, s.key)}` : "：ファイルに入っていません"}</span>
              </label>
            ))}
            <p data-testid="copy-match">
              曲 {p.files}件のうち、この端末で見つかる曲 {matched}件
              {matched < p.files && `（見つからない ${p.files - matched}件のタグなどは写しません）`}
            </p>
            <div className="row">
              <button onClick={copy} disabled={busy || !any} data-testid="copy-run">
                取り込む
              </button>
            </div>
          </div>
        )}
        {busy && <p className="sub">処理しています…（フォルダのスキャンに時間がかかることがあります）</p>}
        {result && (
          <ul className="import-result" data-testid="copy-result">
            {result.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>データのファイルだけを取り込む</h3>
        <p className="sub">Windows のエクスポートで書き出した JSON を選びます。曲は、この端末のライブラリから探します。</p>
        <div className="row">
          <button onClick={chooseFile} disabled={busy} data-testid="copy-pick-file">
            ファイルを選ぶ…
          </button>
        </div>
      </section>
    </div>
  );
}
