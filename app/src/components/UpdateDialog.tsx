import { useEscape } from "../hooks/useEscape";

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
};

/** 起動したときに新しい版が見つかったら出す、アップデートの確認 */
export function UpdateDialog({ version, busy, onUpdate, onLater, onSkip }: Props) {
  useEscape(() => !busy && onLater());
  return (
    <div className="overlay">
      <div className="dialog update-dialog" role="dialog" aria-label="アップデート" data-testid="update-dialog">
        <p>
          新たなバージョンが公開されました。
          <br />
          アプリをアップデートしますか？
        </p>
        <p className="sub">v{version}</p>
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
