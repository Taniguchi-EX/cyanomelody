import { useState } from "react";
import { api, type DataSections, type ImportPreview, type ImportResult } from "../api";
import { confirmDialog } from "../confirm";
import { pickJsonOpenPath, pickJsonSavePath } from "../dialogs";
import { todayStamp } from "../paths";

/** 画面の設定のうち、エクスポートするもの（localStorage の key） */
const SCREEN_KEYS = [
  "cyanomelody.volume",
  "cyanomelody.playerMode",
  "cyanomelody.fileSort",
  "cyanomelody.fileSort.playlist",
  "cyanomelody.listView",
  "cyanomelody.width.side",
  "cyanomelody.width.detail",
];

const SECTIONS: { key: keyof DataSections; label: string }[] = [
  { key: "library", label: "ライブラリ（登録したフォルダ）" },
  { key: "tags", label: "タグ（階層・並び順・色と、曲へのタグ付け）" },
  { key: "playlists", label: "プレイリストとエフェクト" },
  { key: "credits", label: "出典・ライセンスと設定（新しく作るタグの既定値、音量などの画面の設定）" },
];

const ALL: DataSections = { library: true, tags: true, playlists: true, credits: true };
const NONE: DataSections = { library: false, tags: false, playlists: false, credits: false };

type Props = {
  onError: (e: unknown) => void;
  /** 取り込んだ後（データを読み直す。フォルダを登録したらハッシュ値の計算を始める） */
  onImported: (result: ImportResult) => void;
};

function readScreen(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SCREEN_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) out[key] = JSON.parse(raw);
    } catch {
      // 読めない値は書き出さない
    }
  }
  return out;
}

function writeScreen(screen: Record<string, unknown>) {
  for (const key of SCREEN_KEYS) {
    if (key in screen) localStorage.setItem(key, JSON.stringify(screen[key]));
  }
}

const dateText = (seconds: number) => new Date(seconds * 1000).toLocaleString("ja-JP");

/** 項目ごとの、ファイルに入っている件数 */
function sectionCount(p: ImportPreview, key: keyof DataSections): string {
  switch (key) {
    case "library":
      return `フォルダ ${p.folders}件（このPCにあるもの ${p.foldersFound}件）`;
    case "tags":
      return `タグ ${p.tags}件`;
    case "playlists":
      return `プレイリスト ${p.playlists}件、エフェクトセット ${p.effectChains}件`;
    case "credits":
      return `出典 ${p.sources}件、ライセンス ${p.licenses}件`;
  }
}

/** 「置き換える」で消えるもの */
function replaceWarnings(p: ImportPreview, s: DataSections): string[] {
  const c = p.current;
  const out: string[] = [];
  if (s.library && c.foldersNotInFile > 0) out.push(`登録を外すフォルダ ${c.foldersNotInFile}件（中の曲のタグなども消えます）`);
  if (s.tags) {
    out.push(
      `タグ ${c.tags}件（曲へのタグ付けも消えます` +
        (s.playlists ? "）" : "。プレイリストのタグの組み合わせの項目からも外れます）"),
    );
  }
  if (s.playlists) out.push(`プレイリスト ${c.playlists}件、エフェクトセット ${c.effectChains}件`);
  if (s.credits) out.push(`出典 ${c.sources}件、ライセンス ${c.licenses}件（曲への設定も消えます）`);
  return out;
}

function resultLines(r: ImportResult, s: DataSections): string[] {
  const lines: string[] = [];
  if (s.library) {
    lines.push(
      `フォルダ：登録 ${r.foldersAdded.length}件` +
        (r.foldersSkipped ? `、このPCにないため飛ばした ${r.foldersSkipped}件` : "") +
        (r.foldersRemoved ? `、登録を外した ${r.foldersRemoved}件` : ""),
    );
  }
  lines.push(`曲：見つかった ${r.filesMatched}件、見つからなかった ${r.filesUnmatched}件`);
  if (s.tags) lines.push(`タグ：作った ${r.tagsAdded}件、タグ付け ${r.fileTagsAdded}件`);
  if (s.playlists) {
    lines.push(
      `プレイリスト：作った ${r.playlistsAdded}件、エフェクトセット ${r.effectChainsAdded}件` +
        (r.itemsSkipped ? `、取り込まなかった項目 ${r.itemsSkipped}件（曲が見つからないなど）` : ""),
    );
  }
  if (s.credits) {
    lines.push(`出典・ライセンス：作った 出典 ${r.sourcesAdded}件・ライセンス ${r.licensesAdded}件、曲への設定 ${r.creditsSet}件`);
    if (r.screen) lines.push("画面の設定（音量など）は、次にアプリを起動したときに反映されます。");
  }
  return lines;
}

/** 設定画面の「データ」：エクスポートとインポート */
export function DataTab({ onError, onImported }: Props) {
  const [exportSections, setExportSections] = useState<DataSections>(ALL);
  const [exported, setExported] = useState<string | null>(null);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importSections, setImportSections] = useState<DataSections>(NONE);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);

  const exportData = async () => {
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
