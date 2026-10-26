// 設定。Google Drive へのログイン、指定フォルダ（Drive は全端末共通、ローカルは端末ごと）、
// 曲の一覧の手動更新、キャッシュの最大容量。

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { api, formatBytes, type AppInfo, type Folder, type LibraryProgress, type Report, type Settings } from "../api";
import { useShared } from "../state";

const CACHE_CHOICES = [512, 1024, 2048, 4096, 8192].map((mb) => mb * 1024 * 1024);

export default function SettingsView({ info, onLoginChanged }: { info: AppInfo | null; onLoginChanged: () => void }) {
  const { run, offline, busy } = useShared();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ path: Folder[]; folders: Folder[] } | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [progress, setProgress] = useState<LibraryProgress | null>(null);
  const [reports, setReports] = useState<Report[] | null>(null);

  const loggedIn = info?.logged_in ?? false;

  useEffect(() => {
    if (!loggedIn) return;
    run("設定の読み込み", api.settings).then((s) => {
      if (s) {
        setSettings(s);
        setLocalPath(s.local_folder?.path ?? "");
      }
    });
    api.account().then(setAccount).catch(() => setAccount(null));
  }, [loggedIn, run]);

  useEffect(() => {
    const unlisten = listen<LibraryProgress>("library-progress", (e) => setProgress(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const login = async () => {
    await run("ログイン（ブラウザで同意してください）", api.login);
    onLoginChanged();
  };
  const logout = async () => {
    await api.logout();
    setSettings(null);
    setAccount(null);
    onLoginChanged();
  };

  const openPicker = async (path: Folder[]) => {
    const parent = path.length ? path[path.length - 1].id : "root";
    const folders = await run("フォルダの読み込み", () => api.driveFolders(parent));
    if (folders) setPicker({ path, folders });
  };
  const chooseDriveFolder = async () => {
    if (!picker || picker.path.length === 0) return;
    const last = picker.path[picker.path.length - 1];
    const s = await run("指定フォルダの保存", () => api.setDriveFolder(last.id, picker.path.map((f) => f.name).join("/")));
    if (s) {
      setSettings(s);
      setPicker(null);
    }
  };

  const chooseLocalFolder = async () => {
    // Windows と Ubuntu はフォルダを選ぶ画面を出す。Android は入力欄に書いたパスを使う
    let path = localPath.trim();
    if (info?.platform === "desktop") {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      path = picked;
    }
    if (!path) return;
    const s = await run("指定フォルダの保存", () => api.setLocalFolder(path));
    if (s) {
      setSettings(s);
      setLocalPath(path);
    }
  };

  const refresh = async () => {
    setReports(null);
    const r = await run("曲の一覧の更新", api.refreshLibrary);
    setProgress(null);
    if (r) setReports(r);
  };

  const setCacheMax = async (bytes: number) => {
    await run("キャッシュの設定", () => api.setCacheMax(bytes));
    setSettings((s) => (s ? { ...s, cache_max_bytes: bytes } : s));
  };

  return (
    <section className="settings">
      <h2>Google Drive</h2>
      {!info?.can_login ? (
        <p className="dim">この端末では、まだ Google Drive にログインできません。</p>
      ) : loggedIn ? (
        <div className="row">
          <span className="grow">{account ? `${account} でログイン中` : "ログイン中"}</span>
          <button onClick={logout}>ログアウト</button>
        </div>
      ) : (
        <div className="row">
          <span className="grow">ログインしていません。</span>
          <button className="primary" onClick={login} disabled={busy !== null}>
            ブラウザでログイン
          </button>
        </div>
      )}

      {loggedIn && settings && (
        <>
          <h2>指定フォルダ</h2>
          <div className="field">
            <div className="label">Google Drive（全端末で共通）</div>
            <div className="row">
              <span className="grow">{settings.drive_folder ? `/${settings.drive_folder.path}` : "未設定"}</span>
              <button disabled={offline} onClick={() => openPicker([])}>
                選ぶ
              </button>
            </div>
            {picker && (
              <div className="picker">
                <div className="row path">
                  <button
                    className="icon"
                    disabled={busy !== null || picker.path.length === 0}
                    onClick={() => openPicker(picker.path.slice(0, -1))}
                  >
                    ↑
                  </button>
                  <span className="grow">/{picker.path.map((f) => f.name).join("/")}</span>
                  <button className="primary" disabled={busy !== null || picker.path.length === 0} onClick={chooseDriveFolder}>
                    このフォルダにする
                  </button>
                  <button onClick={() => setPicker(null)}>やめる</button>
                </div>
                <ul className="list">
                  {picker.folders.map((f) => (
                    <li key={f.id} className="clickable" onClick={() => busy === null && openPicker([...picker.path, f])}>
                      📁 {f.name}
                    </li>
                  ))}
                  {picker.folders.length === 0 && <li className="dim">サブフォルダはありません</li>}
                </ul>
              </div>
            )}
          </div>
          <div className="field">
            <div className="label">この端末のフォルダ（端末ごと）</div>
            <div className="row">
              {info?.platform === "desktop" ? (
                <span className="grow">{settings.local_folder?.path ?? "未設定"}</span>
              ) : (
                <input className="grow" value={localPath} placeholder="/storage/emulated/0/Music" onChange={(e) => setLocalPath(e.target.value)} />
              )}
              <button disabled={offline} onClick={chooseLocalFolder}>
                {info?.platform === "desktop" ? "選ぶ" : "保存"}
              </button>
            </div>
          </div>

          <h2>曲の一覧</h2>
          <div className="row">
            <span className="grow dim">指定フォルダの中身が変わったら更新してください。</span>
            <button className="primary" disabled={busy !== null} onClick={refresh}>
              曲の一覧を更新
            </button>
          </div>
          {progress && (
            <p className="dim">
              {progress.source === "drive" ? "Google Drive" : "この端末"}のタグを読んでいます：{progress.done} / {progress.total}
            </p>
          )}
          {reports && (
            <ul className="list">
              {reports.map((r) => (
                <li key={r.source}>
                  {r.source === "drive" ? "Google Drive" : "この端末"}：追加 {r.added}、変更 {r.updated}、変わらず {r.unchanged}、見つからない {r.missing}
                </li>
              ))}
            </ul>
          )}

          <h2>キャッシュ</h2>
          <div className="row">
            <span className="grow">
              使用中 {formatBytes(settings.cache_used_bytes)} / 最大
            </span>
            <select value={settings.cache_max_bytes} onChange={(e) => setCacheMax(Number(e.target.value))}>
              {CACHE_CHOICES.map((b) => (
                <option key={b} value={b}>
                  {formatBytes(b)}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      <p className="dim small">
        cyanomelody {info?.core_version} / 端末 ID {info?.device_id.slice(0, 8)}
      </p>
    </section>
  );
}
