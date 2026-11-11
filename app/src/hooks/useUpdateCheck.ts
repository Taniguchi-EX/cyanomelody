import { useEffect, useState } from "react";
import { api } from "../api";
import { useStoredString } from "../storage";
import { isAndroid } from "../platform";

/**
 * 起動したときに新しい版を調べる（「アップデート」の決まり）。
 * version は見つかった新しい版（なければ、「このバージョンをスキップ」した版なら null）
 */
export function useUpdateCheck(showError: (e: unknown) => void) {
  const [found, setFound] = useState<string | null>(null);
  const [skipped, setSkipped] = useStoredString("cyanomelody.skippedUpdate");
  const [updating, setUpdating] = useState(false);
  /** Android：インストールの画面を出した（「更新」はユーザーが押す） */
  const [installerOpened, setInstallerOpened] = useState(false);
  useEffect(() => {
    // 調べられなかったとき（オフラインなど）は、何も出さない
    api
      .checkUpdate()
      .then((v) => v && setFound(v))
      .catch(() => {});
  }, []);

  /**
   * 「はい」：ダウンロードして入れる。Windows はアプリが入れ直した版で起動し直す。
   * Android はダウンロードしてインストールの画面を出すところまで（ダウンロード済みなら画面を出し直す）
   */
  const install = () => {
    setUpdating(true);
    api
      .installUpdate()
      .then(() => {
        if (isAndroid) {
          setUpdating(false);
          setInstallerOpened(true);
        }
      })
      .catch((e) => {
        setUpdating(false);
        setFound(null);
        showError(e);
      });
  };

  return {
    version: found && found !== skipped ? found : null,
    updating,
    installerOpened,
    install,
    /** 「いいえ」：今回は出さない */
    later: () => setFound(null),
    /** 「このバージョンをスキップ」：この版は次から出さない */
    skip: () => {
      if (found) setSkipped(found);
      setFound(null);
    },
  };
}
