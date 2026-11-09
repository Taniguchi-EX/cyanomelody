import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEscape } from "../hooks/useEscape";

/** その版の Release のページ（リリースノート） */
const releaseUrl = (version: string) => `https://github.com/Taniguchi-EX/cyanomelody/releases/tag/v${version}`;

type Props = {
  /** 見つかった新しい版（"1.0.1" など） */
  version: string;
  busy: boolean;
  /** 「はい」：ダウンロードしてインストールし、アプリを再起動する */
  onUpdate: () => void;
  /** 「いいえ」（Esc でも）：何もしない。次に起動したときにまた聞く */
  onLater: () => void;
  /** 「このバージョンをスキップ」：この版では、もう聞かない */
  onSkip: () => void;
  /** リンクを開けなかったとき */
  onError: (e: unknown) => void;
};

/** 版の番号。押すと、その版のリリースノートをブラウザで開く */
function VersionLink({ version, onError }: { version: string; onError: (e: unknown) => void }) {
  const url = releaseUrl(version);
  return (
    <a
      href={url}
      title="リリースノートを開く"
      onClick={(e) => {
        e.preventDefault();
        openUrl(url).catch(onError);
      }}
    >
      {version}
    </a>
  );
}

/** 起動したときに新しい版が見つかったら出す、アップデートの確認。今の版と新しい版を、リリースノートへのリンクで出す */
export function UpdateDialog({ version, busy, onUpdate, onLater, onSkip, onError }: Props) {
  useEscape(() => !busy && onLater());
  const [current, setCurrent] = useState("");
  useEffect(() => {
    getVersion().then(setCurrent).catch(onError);
  }, [onError]);
  return (
    <div className="overlay">
      <div className="dialog update-dialog" role="dialog" aria-label="アップデート" data-testid="update-dialog">
        <p>
          新たなバージョンが公開されました。
          <br />
          アプリをアップデートしますか？
        </p>
        <p className="update-versions" data-testid="update-versions">
          現在：{current && <VersionLink version={current} onError={onError} />}
          <br />
          最新：<VersionLink version={version} onError={onError} />
        </p>
        {busy && <p className="sub">ダウンロードしています。終わるとアプリが再起動します…</p>}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
          <button onClick={onUpdate} disabled={busy} autoFocus>
            はい
          </button>
          <button onClick={onLater} disabled={busy}>
            いいえ
          </button>
          <button onClick={onSkip} disabled={busy}>
            このバージョンをスキップ
          </button>
        </div>
      </div>
    </div>
  );
}
