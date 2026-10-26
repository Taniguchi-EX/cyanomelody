import { useCallback, useEffect, useState } from "react";
import { api, type AppInfo } from "./api";
import { SharedProvider, useShared } from "./state";
import PlaylistList from "./components/PlaylistList";
import PlaylistView from "./components/PlaylistView";
import PlayerBar from "./components/PlayerBar";
import SettingsView from "./components/SettingsView";
import "./App.css";

type Tab = "playlists" | "settings";

function Shell() {
  const { offline, busy, notice, notify } = useShared();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tab, setTab] = useState<Tab>("playlists");
  const [openId, setOpenId] = useState<string | null>(null);

  const reloadInfo = useCallback(() => {
    api.appInfo().then(setInfo).catch(() => setInfo(null));
  }, []);
  useEffect(reloadInfo, [reloadInfo]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>cyanomelody</h1>
        <nav>
          <button
            className={tab === "playlists" ? "tab active" : "tab"}
            onClick={() => {
              // タブを押したら、プレイリストの一覧に戻る
              setTab("playlists");
              setOpenId(null);
            }}
          >
            プレイリスト
          </button>
          <button className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>
            設定
          </button>
        </nav>
      </header>
      {offline && <div className="banner offline">オフライン：プレイリストは編集できません</div>}
      {notice && (
        <div className="banner notice" onClick={() => notify(null)}>
          {notice}
          <span className="close">×</span>
        </div>
      )}
      {busy && <div className="banner busy">{busy}中…</div>}
      <main className="content">
        {tab === "settings" ? (
          <SettingsView info={info} onLoginChanged={reloadInfo} />
        ) : !info?.logged_in ? (
          <p className="empty">設定のタブで Google Drive にログインしてください。</p>
        ) : openId ? (
          <PlaylistView id={openId} onBack={() => setOpenId(null)} />
        ) : (
          <PlaylistList onOpen={setOpenId} />
        )}
      </main>
      <PlayerBar onOpenPlaylist={(id) => {
        setTab("playlists");
        setOpenId(id);
      }} />
    </div>
  );
}

export default function App() {
  return (
    <SharedProvider>
      <Shell />
    </SharedProvider>
  );
}
