// 設定。Google Drive へのログイン、指定フォルダ（Drive は全端末共通、端末のフォルダは端末ごと）、
// 曲の一覧の手動更新、キャッシュの最大容量。

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { api, formatBytes, type AppInfo, type LibraryProgress, type Report, type Settings } from "../api";
import { useShared } from "../state";
import FolderPicker, { type FolderNode } from "./FolderPicker";

const CACHE_CHOICES = [512, 1024, 2048, 4096, 8192].map((mb) => mb * 1024 * 1024);
/** Android の端末のフォルダをたどるときの一番上（内部ストレージ） */
const ANDROID_STORAGE = "/storage/emulated/0";

const sourceLabel = (source: string) => (source === "drive" ? "Google Drive" : "この端末");

export default function SettingsView({ info, onLoginChanged }: { info: AppInfo | null; onLoginChanged: () => void }) {
  const { run } = useShared();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const loggedIn = info?.logged_in ?? false;

  useEffect(() => {
    if (!loggedIn) return;
    run("設定の読み込み", api.settings).then((s) => s && setSettings(s));
    api.account().then(setAccount).catch(() => setAccount(null));
  }, [loggedIn, run]);

  const login = async () => {
    await run("ログイン", api.login);
    onLoginChanged();
  };
  const logout = async () => {
    await api.logout();
    setSettings(null);
    setAccount(null);
    onLoginChanged();
  };

  return (
    <section className="settings">
      <AccountSection info={info} account={account} onLogin={login} onLogout={logout} />
      {loggedIn && settings && (
        <>
          <FolderSection info={info} settings={settings} onChange={setSettings} />
          <LibrarySection />
          <CacheSection settings={settings} onChange={setSettings} />
        </>
      )}
      <p className="dim small">
        cyanomelody {info?.core_version} / 端末 ID {info?.device_id.slice(0, 8)}
      </p>
    </section>
  );
}

function AccountSection(props: { info: AppInfo | null; account: string | null; onLogin: () => void; onLogout: () => void }) {
  const { busy } = useShared();
  const { info, account } = props;
  let body;
  if (!info?.can_login) {
    body = <p className="dim">この端末では Google Drive にログインできません。</p>;
  } else if (info.logged_in) {
    body = (
      <div className="row">
        <span className="grow">{account ? `${account} でログイン中` : "ログイン中"}</span>
        <button onClick={props.onLogout}>ログアウト</button>
      </div>
    );
  } else {
    body = (
      <div className="row">
        <span className="grow">ログインしていません。</span>
        <button className="primary" onClick={props.onLogin} disabled={busy !== null}>
          {info.platform === "desktop" ? "ブラウザでログイン" : "ログイン"}
        </button>
      </div>
    );
  }
  return (
    <>
      <h2>Google Drive</h2>
      {body}
    </>
  );
}

function FolderSection(props: { info: AppInfo | null; settings: Settings; onChange: (s: Settings) => void }) {
  const { run, offline } = useShared();
  const { info, settings, onChange } = props;
  const [picking, setPicking] = useState<"drive" | "local" | null>(null);
  const desktop = info?.platform === "desktop";

  const loadDrive = useCallback(
    (path: FolderNode[]) => run("フォルダの読み込み", () => api.driveFolders(path.at(-1)?.id ?? "root")),
    [run],
  );
  const loadLocal = useCallback(async (path: FolderNode[]) => {
    const parent = path.at(-1)?.id ?? ANDROID_STORAGE;
    const names = await run("フォルダの読み込み", () => api.localFolders(parent));
    return names?.map((name) => ({ id: `${parent}/${name}`, name }));
  }, [run]);

  const save = async (action: () => Promise<Settings>) => {
    const s = await run("指定フォルダの保存", action);
    if (s) {
      onChange(s);
      setPicking(null);
    }
  };
  const chooseDrive = (path: FolderNode[]) =>
    save(() => api.setDriveFolder(path.at(-1)!.id, path.map((f) => f.name).join("/")));
  const chooseLocal = (path: FolderNode[]) => save(() => api.setLocalFolder(path.at(-1)?.id ?? ANDROID_STORAGE));
  // Windows と Ubuntu は OS のフォルダを選ぶ画面、Android はアプリの中でたどって選ぶ
  const pickLocal = async () => {
    if (!desktop) return setPicking("local");
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") await save(() => api.setLocalFolder(picked));
  };

  return (
    <>
      <h2>指定フォルダ</h2>
      <div className="field">
        <div className="label">Google Drive（全端末で共通）</div>
        <div className="row">
          <span className="grow">{settings.drive_folder ? `/${settings.drive_folder.path}` : "未設定"}</span>
          <button disabled={offline} onClick={() => setPicking("drive")}>
            選ぶ
          </button>
        </div>
        {picking === "drive" && (
          <FolderPicker rootLabel="マイドライブ" allowRoot={false} loadChildren={loadDrive} onChoose={chooseDrive} onCancel={() => setPicking(null)} />
        )}
      </div>
      <div className="field">
        <div className="label">この端末のフォルダ（端末ごと）</div>
        <div className="row">
          <span className="grow">{settings.local_folder?.path ?? "未設定"}</span>
          <button disabled={offline} onClick={pickLocal}>
            選ぶ
          </button>
        </div>
        {picking === "local" && (
          <FolderPicker rootLabel={ANDROID_STORAGE} allowRoot loadChildren={loadLocal} onChoose={chooseLocal} onCancel={() => setPicking(null)} />
        )}
      </div>
    </>
  );
}

function LibrarySection() {
  const { run, busy } = useShared();
  const [progress, setProgress] = useState<LibraryProgress | null>(null);
  const [reports, setReports] = useState<Report[] | null>(null);

  useEffect(() => {
    const unlisten = listen<LibraryProgress>("library-progress", (e) => setProgress(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const refresh = async () => {
    setReports(null);
    const r = await run("曲の一覧の更新", api.refreshLibrary);
    setProgress(null);
    if (r) setReports(r);
  };

  return (
    <>
      <h2>曲の一覧</h2>
      <div className="row">
        <span className="grow dim">指定フォルダの中身が変わったら更新してください。</span>
        <button className="primary" disabled={busy !== null} onClick={refresh}>
          曲の一覧を更新
        </button>
      </div>
      {progress && (
        <p className="dim">
          {sourceLabel(progress.source)}のタグを読んでいます：{progress.done} / {progress.total}
        </p>
      )}
      {reports && (
        <ul className="list">
          {reports.map((r) => (
            <li key={r.source}>
              {sourceLabel(r.source)}：追加 {r.added}、変更 {r.updated}、変わらず {r.unchanged}、見つからない {r.missing}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CacheSection({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const { run } = useShared();
  const setMax = async (bytes: number) => {
    const done = await run("キャッシュの設定", () => api.setCacheMax(bytes));
    if (done !== undefined) onChange({ ...settings, cache_max_bytes: bytes });
  };
  return (
    <>
      <h2>キャッシュ</h2>
      <div className="row">
        <span className="grow">使用中 {formatBytes(settings.cache_used_bytes)} / 最大</span>
        <select value={settings.cache_max_bytes} onChange={(e) => setMax(Number(e.target.value))}>
          {CACHE_CHOICES.map((b) => (
            <option key={b} value={b}>
              {formatBytes(b)}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
