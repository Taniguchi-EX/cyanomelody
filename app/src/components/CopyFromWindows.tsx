import { useState } from "react";
import { api, type CopyPreview, type DataSections, type ImportResult } from "../api";
import { confirmDialog } from "../confirm";
import { writeScreen } from "../screenTransfer";
import { dateText, replaceWarnings, resultLines, SECTIONS, sectionCount } from "../dataTransferText";

type Props = {
  onError: (e: unknown) => void;
  /** 写した後（データを読み直す。フォルダをスキャンしたらハッシュ値の計算を始める） */
  onImported: (result: ImportResult) => void;
};

/** 写せる項目（ライブラリ（フォルダの登録）は、書き出したフォルダを選んだときに、その中のフォルダを登録する） */
const COPY_SECTIONS = SECTIONS.filter((s) => s.key !== "library");
const NONE: DataSections = { library: false, tags: false, playlists: false, credits: false };

/**
 * Android の設定画面の「データ」：Windows からのコピー。
 * Windows で書き出したフォルダ（音声ファイルごと）か、データのファイルだけを選び、選んだ項目を Windows のとおりに置き換える
 */
export function CopyFromWindows({ onError, onImported }: Props) {
  const [preview, setPreview] = useState<CopyPreview | null>(null);
  const [sections, setSections] = useState<DataSections>(NONE);
  const [removeOld, setRemoveOld] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);

  const choose = async (kind: "dir" | "file") => {
    setResult(null);
    setBusy(true);
    try {
      const p = await api.pickCopySource(kind);
      if (!p) return;
      setPreview(p);
      // ファイルに入っている項目を、最初はすべて選ぶ
      setSections({ ...p.import.sections, library: false });
      setRemoveOld(true);
    } catch (e) {
      setPreview(null);
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
          Windows の設定画面の「データ」で書き出したものを、USB や Google ドライブなどでこの端末に写してから選びます。選んだ項目は、Windows
          のとおりに置き換わります（この端末で変えた分は消えます）。
        </p>
        <div className="row">
          <button onClick={() => choose("dir")} disabled={busy} data-testid="copy-pick-dir">
            フォルダを選ぶ…
          </button>
          <button onClick={() => choose("file")} disabled={busy} data-testid="copy-pick-file">
            ファイルを選ぶ…
          </button>
        </div>
        <ul className="sub">
          <li>フォルダ：「音声ファイルも入れる」で書き出したフォルダ。中のフォルダを、置いた場所のままライブラリに登録します。</li>
          <li>ファイル：データ（JSON）だけ。音声ファイルが既にこの端末にあり、フォルダを登録してあるとき。</li>
        </ul>
        {preview && p && (
          <div className="import-preview" data-testid="copy-preview">
            <p className="sub">書き出した日時：{dateText(p.exportedAt)}（v{p.appVersion}）</p>
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
            {preview.source.kind === "dir" && preview.folders.length === 0 && (
              <p className="sub warn">選んだフォルダの中にフォルダがありません（音声ファイルは写されません）。</p>
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
                コピーする
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
    </div>
  );
}
