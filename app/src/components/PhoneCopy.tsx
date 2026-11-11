import { useState } from "react";
import { api, type PhoneDevice } from "../api";
import { confirmDialog } from "../confirm";
import { formatBytes, readScreen } from "../screenTransfer";

type Props = {
  onError: (e: unknown) => void;
};

/**
 * Windows の設定画面の「データ」：スマホへコピー。
 * USB でつないだスマホ（ファイル転送）の Music/cyanomelody に、ライブラリの全曲とデータを写す（2回目からは差分だけ）。
 * 進み具合と中止は、ほかの書き出しと同じく一番下の行に出す
 */
export function PhoneCopy({ onError }: Props) {
  const [devices, setDevices] = useState<PhoneDevice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /** 端末の中を調べ、写すものを確かめてから写す */
  const copyTo = async (device: PhoneDevice) => {
    setBusy(`${device.name} の中を調べています…（曲が多いと時間がかかります）`);
    try {
      const s = await api.phonePlan(device.id);
      setBusy(null);
      const ok = await confirmDialog(
        `${s.device} の Music/cyanomelody に写します。\n\n` +
          `・写す曲 ${s.copyFiles}件（${formatBytes(s.copyBytes)}）\n` +
          `・スマホから消す曲 ${s.deleteFiles}件（Windows のライブラリにないもの）\n` +
          `・そのままの曲 ${s.unchanged}件\n` +
          (s.missing ? `・見つからないので写さない曲 ${s.missing}件\n` : "") +
          "\nタグ・プレイリストなどのデータも一緒に写します。写し終えたら、スマホの cyanomelody を開いて取り込んでください。\n\nよろしいですか？",
      );
      if (!ok) return;
      const target = await api.phoneCopy(readScreen());
      setMessage(`${target} に写しています（進み具合は一番下の行に出ます。終わるまで USB を抜かないでください）`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  const find = async () => {
    setMessage(null);
    setBusy("スマホを探しています…");
    try {
      const found = await api.phoneDevices();
      setDevices(found);
      setBusy(null);
      if (found.length === 1) await copyTo(found[0]);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-testid="phone-copy">
      <h3>スマホへコピー</h3>
      <p className="sub">
        USB でつないだスマホの Music/cyanomelody に、ライブラリの全曲と、タグ・プレイリストなどのデータを写します。2回目からは、変わった曲だけを写し、ライブラリにない曲はスマホからも消します。スマホでは、cyanomelody を開くと取り込めます。
      </p>
      <div className="row">
        <button onClick={find} disabled={busy !== null} data-testid="phone-find">
          スマホへコピー…
        </button>
      </div>
      {devices && devices.length === 0 && (
        <p className="sub warn" data-testid="phone-none">
          スマホが見つかりません。USB でつなぎ、スマホのロックを解除して、通知の「USB の設定」で「ファイル転送」を選んでから、もう一度押してください。
        </p>
      )}
      {devices && devices.length > 1 && !busy && (
        <div className="row">
          写すスマホ：
          {devices.map((d) => (
            <button key={d.id} onClick={() => copyTo(d)}>
              {d.name}
            </button>
          ))}
        </div>
      )}
      {busy && <p className="sub">{busy}</p>}
      {message && (
        <p className="sub" data-testid="phone-message">
          {message}
        </p>
      )}
    </section>
  );
}
