import { useEscape } from "../hooks/useEscape";

/** 一覧に出すファイルの数（多いときは「ほか N件」） */
const SHOWN = 10;

type Props = {
  /** ごみ箱に移す確認か、ごみ箱に移せなかったファイルを完全に消す確認か */
  permanent: boolean;
  /** 対象のファイル（相対パスと、ごみ箱に移せなかった理由） */
  files: { relPath: string; reason?: string }[];
  onConfirm: () => void;
  onClose: () => void;
};

/**
 * ファイルの削除の確認のダイアログ。最初は「やめる」を選んだ状態にする（Enter で消さないように）。
 * permanent のときは、ごみ箱に移せなかったファイルについて、完全に消すかを聞く
 */
export function DeleteDialog({ permanent, files, onConfirm, onClose }: Props) {
  useEscape(onClose);
  const n = files.length;
  return (
    <div className="overlay">
      <div className="dialog delete-dialog" role="dialog" aria-label="ファイルの削除" data-testid="delete-dialog">
        <div className="dialog-head">
          <h2>{permanent ? "ごみ箱に移せなかったファイル" : "ファイルを削除する"}</h2>
        </div>
        {permanent ? (
          <p>
            {n}件のファイルは、ごみ箱に移せませんでした。完全に削除しますか？
            <br />
            <span className="warn">完全に削除すると、元に戻せません。</span>Google ドライブの上のファイルは、Google ドライブのごみ箱に残ります。
          </p>
        ) : (
          <p>
            {n}件のファイルをごみ箱に移し、ライブラリから外します。付けたタグ・出典・ライセンスの設定、プレイリストの項目も消えます。
          </p>
        )}
        <ul className="delete-files" data-testid="delete-files">
          {files.slice(0, SHOWN).map((f, i) => (
            <li key={`${i}:${f.relPath}`}>
              {f.relPath}
              {f.reason && <span className="sub">（{f.reason}）</span>}
            </li>
          ))}
          {n > SHOWN && <li className="sub">ほか {n - SHOWN}件</li>}
        </ul>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
          <button onClick={onClose} autoFocus>
            やめる
          </button>
          <button className="danger" onClick={onConfirm}>
            {permanent ? "完全に削除する" : "削除する"}
          </button>
        </div>
      </div>
    </div>
  );
}
