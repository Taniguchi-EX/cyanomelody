import { useEffect, useState } from "react";
import { api, type ChildSort, type TagSettings } from "../api";
import { useEscape } from "../hooks/useEscape";
import { useStoredString } from "../storage";
import { DEFAULT_BG, DEFAULT_FG, SORTS } from "../tagSettings";
import { ColorRow } from "./TagDetail";
import { LicenseTab } from "./LicenseTab";

type Props = {
  onClose: () => void;
  onError: (e: unknown) => void;
};

const TABS = [
  { key: "general", label: "一般" },
  { key: "license", label: "バージョンとライセンス" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** 設定画面。再生の欄の右端の歯車から開く。タブごとに中身を出す */
export function SettingsDialog({ onClose, onError }: Props) {
  // 前に開いていたタブ（最初は「一般」）
  const [stored, setStored] = useStoredString("cyanomelody.settingsTab");
  const tab: TabKey = TABS.find((t) => t.key === stored)?.key ?? "general";
  useEscape(onClose);
  return (
    <div className="overlay">
      <div className="dialog settings-dialog" role="dialog" aria-label="設定" data-testid="settings">
        <div className="dialog-head">
          <h2>設定</h2>
          <button onClick={onClose}>閉じる</button>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? "active" : undefined}
              onClick={() => setStored(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="tab-body" role="tabpanel">
          {tab === "general" ? <GeneralTab onError={onError} /> : <LicenseTab onError={onError} />}
        </div>
      </div>
    </div>
  );
}

/** 一般：新しく作るタグの既定値。変えるとすぐに保存する */
function GeneralTab({ onError }: { onError: (e: unknown) => void }) {
  const [settings, setSettings] = useState<TagSettings | null>(null);
  useEffect(() => {
    api.newTagSettings().then(setSettings).catch(onError);
  }, [onError]);
  if (!settings) return null;
  const update = (patch: Partial<TagSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    api.setNewTagSettings(next).catch(onError);
  };
  const fixedSort = settings.childSort === null || settings.childSort === "manual";
  return (
    <section>
      <h3>新しく作るタグ</h3>
      <p className="sub">タグを作ったときの、子のタグの並び順と色です。今あるタグは変わりません。</p>
      <div className="form-grid">
        <label htmlFor="new-tag-sort">子のタグの並び順</label>
        <span className="row">
          <select
            id="new-tag-sort"
            value={settings.childSort ?? ""}
            onChange={(e) => update({ childSort: (e.target.value || null) as ChildSort | null })}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            aria-label="昇順・降順"
            value={settings.childSortDesc ? "desc" : "asc"}
            disabled={fixedSort}
            onChange={(e) => update({ childSortDesc: e.target.value === "desc" })}
          >
            <option value="asc">昇順</option>
            <option value="desc">降順</option>
          </select>
        </span>
        <ColorRow
          id="new-tag-bg"
          label="背景色"
          value={settings.bgColor}
          fallback={DEFAULT_BG}
          onChange={(bgColor) => update({ bgColor })}
        />
        <ColorRow
          id="new-tag-fg"
          label="文字色"
          value={settings.fgColor}
          fallback={DEFAULT_FG}
          onChange={(fgColor) => update({ fgColor })}
        />
        <span>見本</span>
        <span>
          <span
            className="chip tag-sample"
            data-testid="new-tag-sample"
            style={{ background: settings.bgColor ?? undefined, color: settings.fgColor ?? undefined }}
          >
            新しいタグ
          </span>
        </span>
      </div>
    </section>
  );
}
