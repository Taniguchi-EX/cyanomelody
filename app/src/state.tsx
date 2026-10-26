// 画面全体で共有する状態（オフラインかどうか、保存中かどうか、知らせ）。

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { errorMessage, isUiError } from "./api";

interface Shared {
  offline: boolean;
  busy: string | null;
  notice: string | null;
  /**
   * 通信を伴う操作を行う。保存中の表示を出し、オフラインになったら知らせる。
   * オフラインで端末に保存した内容があればそれを返し、ほかの失敗では undefined を返す
   */
  run: <T>(label: string, action: () => Promise<T>) => Promise<T | undefined>;
  setOffline: (offline: boolean) => void;
  notify: (message: string | null) => void;
}

const SharedContext = createContext<Shared | null>(null);

export function SharedProvider({ children }: { children: ReactNode }) {
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, notify] = useState<string | null>(null);

  const run = useCallback(async <T,>(label: string, action: () => Promise<T>) => {
    setBusy(label);
    try {
      const result = await action();
      setOffline(false);
      return result;
    } catch (e) {
      if (isUiError(e) && e.kind === "offline") {
        setOffline(true);
        notify("通信できません。キャッシュ済みの曲とローカルの曲だけ再生でき、プレイリストは編集できません");
        if (e.cached !== undefined && e.cached !== null) return e.cached as T;
      } else {
        notify(`${label}できませんでした: ${errorMessage(e)}`);
      }
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  const value = useMemo(() => ({ offline, busy, notice, run, setOffline, notify }), [offline, busy, notice, run]);
  return <SharedContext.Provider value={value}>{children}</SharedContext.Provider>;
}

export function useShared(): Shared {
  const shared = useContext(SharedContext);
  if (!shared) throw new Error("SharedProvider の外では使えない");
  return shared;
}
