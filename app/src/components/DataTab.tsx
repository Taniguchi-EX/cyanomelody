import { useState } from "react";
import { api, type DataSections, type ImportPreview, type ImportResult } from "../api";
import { confirmDialog } from "../confirm";
import { pickJsonOpenPath, pickJsonSavePath, pickPath } from "../dialogs";
import { todayStamp } from "../paths";
import { formatBytes, readScreen, writeScreen } from "../screenTransfer";
import { dateText, replaceWarnings, resultLines, SECTIONS, sectionCount } from "../dataTransferText";

const ALL: DataSections = { library: true, tags: true, playlists: true, credits: true };
const NONE: DataSections = { library: false, tags: false, playlists: false, credits: false };

type Props = {
  onError: (e: unknown) => void;
  /** 取り込んだ後（データを読み直す。フォルダを登録したらハッシュ値の計算を始める） */
  onImported: (result: ImportResult) => void;
};

/** 設定画面の「データ」：エクスポートとインポート */
export function DataTab({ onError, onImported }: Props) {
  const [exportSections, setExportSections] = useState<DataSections>(ALL);
  /** 音声ファイルも入れる（Android の端末へ写すとき） */
  const [withAudio, setWithAudio] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importSections, setImportSections] = useState<DataSections>(NONE);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);

  /** データと音声ファイルを、選んだフォルダの中に作るフォルダへ書き出す（Android の端末へ写すため） */
  const exportPackage = async () => {
    const dest = await pickPath({ directory: true });
    if (!dest) return;
    setBusy(true);
    try {
      const est = await api.estimatePackage(exportSections);
      const ok = await confirmDialog(
        `データと一緒に、音声ファイル ${est.files}件（${formatBytes(est.bytes)}）を書き出します。` +
          (est.missing ? `見つからない曲 ${est.missing}件は入れません。` : "") +
          "\n\n書き出したフォルダを、USB や Google ドライブなどで Android の端末に写し、Android の設定画面の「データ」の「Windows からコピー」で取り込みます。\n\nよろしいですか？",
      );
      if (!ok) return;
      const folder = await api.exportPackage(
        dest,
        `cyanomelody-${todayStamp()}`,
        exportSections,
        exportSections.credits ? readScreen() : null,
      );
      setExported(`${folder} に書き出しています（進み具合は一番下の行に出ます）`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const exportData = async () => {
    if (withAudio) return exportPackage();
    const path = await pickJsonSavePath(`cyanomelody-${todayStamp()}`);
    if (!path) return;
    setBusy(true);
    try {
      const n = await api.exportData(path, exportSections, exportSections.credits ? readScreen() : null);
      setExported(
        `${path} に書き出しました（フォルダ ${n.folders}件、曲 ${n.files}件、タグ ${n.tags}件、プレイリスト ${n.playlists}件、` +
          `エフェクトセット ${n.effectChains}件、出典 ${n.sources}件、ライセンス ${n.licenses}件）`,
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async () => {
    const path = await pickJsonOpenPath();
    if (!path) return;
    setResult(null);
    try {
      const p = await api.inspectImport(path);
      setImportPath(path);
      setPreview(p);
      // ファイルに入っている項目を、最初はすべて選ぶ
      setImportSections(p.sections);
    } catch (e) {
      setImportPath(null);
      setPreview(null);
      onError(e);
    }
  };

  const importData = async () => {
    if (!importPath || !preview) return;
    if (replace) {
      const lost = replaceWarnings(preview, importSections);
      const ok = await confirmDialog(
        `選んだ項目の今のデータを消して、ファイルの内容に置き換えます。\n\n消えるもの：\n${lost.map((l) => `・${l}`).join("\n")}\n\nよろしいですか？`,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await api.importData(importPath, importSections, replace);
      if (r.screen) writeScreen(r.screen);
      setResult(resultLines(r, importSections));
      setPreview(null);
      setImportPath(null);
      onImported(r);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const anyExport = Object.values(exportSections).some(Boolean);
  const anyImport = Object.values(importSections).some(Boolean);
  const matched = preview ? preview.matchedByPath + preview.matchedByHash + preview.matchedByName : 0;
  return (
    <div className="data-tab" data-testid="data-tab">
      <section>
        <h3>エクスポート</h3>
        <p className="sub">選んだ項目を JSON のファイルに書き出します。曲を見分けるための曲の一覧も一緒に書き出します。</p>
        {SECTIONS.map((s) => (
          <label key={s.key} className="data-check">
            <input
              type="checkbox"
              checked={exportSections[s.key]}
              onChange={(e) => setExportSections((v) => ({ ...v, [s.key]: e.target.checked }))}
              aria-label={`エクスポート：${s.label}`}
            />
            {s.label}
          </label>
        ))}
        <label className="data-check">
          <input
            type="checkbox"
            checked={withAudio}
            onChange={(e) => setWithAudio(e.target.checked)}
            aria-label="音声ファイルも入れる"
            data-testid="export-with-audio"
          />
          音声ファイルも入れる（Android の端末へ写すとき。選んだフォルダの中に、データと音声ファイルをまとめたフォルダを作ります）
        </label>
        <div className="row">
          <button onClick={exportData} disabled={busy || !anyExport}>
            エクスポート…
          </button>
        </div>
        {exported && (
          <p className="sub" data-testid="export-result">
            {exported}
          </p>
        )}
      </section>

      <section>
        <h3>インポート</h3>
        <p className="sub">書き出したファイルを読み込みます。音声ファイルそのものは含まれないので、曲はこのPCのライブラリから探します。</p>
        <div className="row">
          <button onClick={chooseFile} disabled={busy}>
            ファイルを選ぶ…
          </button>
        </div>
        {preview && (
          <div className="import-preview" data-testid="import-preview">
            <p className="sub">
              {importPath}
              <br />
              書き出した日時：{dateText(preview.exportedAt)}（v{preview.appVersion}）
            </p>
            {SECTIONS.map((s) => (
              <label key={s.key} className={`data-check${preview.sections[s.key] ? "" : " disabled"}`}>
                <input
                  type="checkbox"
                  checked={importSections[s.key]}
                  disabled={!preview.sections[s.key]}
                  onChange={(e) => setImportSections((v) => ({ ...v, [s.key]: e.target.checked }))}
                  aria-label={`インポート：${s.label}`}
                />
                {s.label}
                <span className="sub">{preview.sections[s.key] ? `：${sectionCount(preview, s.key)}` : "：ファイルに入っていません"}</span>
              </label>
            ))}
            <p data-testid="import-match">
              曲 {preview.files}件のうち、このPCで見つかる曲 {matched}件（パス {preview.matchedByPath}・ハッシュ値{" "}
              {preview.matchedByHash}・名前と大きさ {preview.matchedByName}）
            </p>
            {importSections.library && preview.foldersFound > 0 && matched < preview.files && (
              <p className="sub">ライブラリを取り込むと、フォルダを登録してから曲を探すので、見つかる曲が増えることがあります。</p>
            )}
            {preview.pendingHashes > 0 && (
              <p className="sub warn">
                ハッシュ値の計算が終わっていない曲が {preview.pendingHashes}件あります。終わってから取り込むと、見つかる曲が増えることがあります。
              </p>
            )}
            <div className="row" role="radiogroup" aria-label="取り込み方">
              <label>
                <input type="radio" name="import-mode" checked={!replace} onChange={() => setReplace(false)} />
                今あるデータに足す
              </label>
              <label>
                <input type="radio" name="import-mode" checked={replace} onChange={() => setReplace(true)} />
                選んだ項目を置き換える
              </label>
            </div>
            <div className="row">
              <button onClick={importData} disabled={busy || !anyImport}>
                取り込む
              </button>
            </div>
          </div>
        )}
        {busy && <p className="sub">処理しています…</p>}
        {result && (
          <ul className="import-result" data-testid="import-result">
            {result.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
