import { useState } from "react";
import type { ChildSort, Tag, TagSettings } from "../api";
import { DEFAULT_BG, DEFAULT_FG, SORTS } from "../tagSettings";
import { useEscape } from "../hooks/useEscape";

type Props = {
  tag: Tag;
  /** 親のタグ（色の引き継ぎの見本に使う）。最上位なら null */
  parent: Tag | null;
  busy: boolean;
  /** 保存する。終わったら true（画面を閉じる） */
  onSubmit: (name: string, settings: TagSettings) => Promise<boolean>;
  onClose: () => void;
};



type ColorRowProps = {
  id: string;
  label: string;
  value: string | null;
  /** 付けていないときに出す色（引き継ぐ色か、決まった色） */
  fallback: string;
  onChange: (value: string | null) => void;
};

/** 「色を付ける」のチェックと、色の選択 */
export function ColorRow({ id, label, value, fallback, onChange }: ColorRowProps) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <span className="row">
        <label>
          <input
            type="checkbox"
            checked={value !== null}
            onChange={(e) => onChange(e.target.checked ? fallback : null)}
            aria-label={`${label}を付ける`}
          />
          色を付ける
        </label>
        <input
          id={id}
          type="color"
          value={value ?? fallback}
          disabled={value === null}
          onChange={(e) => onChange(e.target.value)}
        />
        {value === null && <span className="sub">親の色を引き継ぐ</span>}
      </span>
    </>
  );
}

/** タグの詳細画面。名前、子のタグの並び順、背景色・文字色を決める */
export function TagDetail({ tag, parent, busy, onSubmit, onClose }: Props) {
  const [name, setName] = useState(tag.name);
  const [settings, setSettings] = useState<TagSettings>({
    childSort: tag.childSort,
    childSortDesc: tag.childSortDesc,
    bgColor: tag.bgColor,
    fgColor: tag.fgColor,
  });
  const update = (patch: Partial<TagSettings>) => setSettings((s) => ({ ...s, ...patch }));

  useEscape(onClose);

  const submit = async () => {
    if (await onSubmit(name, settings)) onClose();
  };

  // 引き継ぐときに、実際に並べる順（親が実際に並べる順）
  const inherited = parent ? { sort: parent.shownChildSort, desc: parent.shownChildSortDesc } : { sort: "manual", desc: false };
  const sortLabel = (sort: ChildSort, desc: boolean) =>
    SORTS.find((s) => s.value === sort)!.label + (sort === "manual" ? "" : desc ? "・降順" : "・昇順");
  // 見本の色。自分の色がなければ、親の表示の色を引き継ぐ
  const bg = settings.bgColor ?? parent?.shownBgColor ?? null;
  const fg = settings.fgColor ?? parent?.shownFgColor ?? null;
  const title = `タグ「${tag.name}」の詳細`;
  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-label={title} data-testid="tag-detail">
        <div className="dialog-head">
          <h2>{title}</h2>
        </div>
        <div className="form-grid">
          <label htmlFor="tag-detail-name">タグ名</label>
          <input
            id="tag-detail-name"
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && name.trim() && submit()}
          />
          <label htmlFor="tag-detail-sort">子のタグの並び順</label>
          <span className="row">
            <select
              id="tag-detail-sort"
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
              // 引き継ぐときは、引き継いだ昇順・降順を出す（選べない）
              value={(settings.childSort === null ? inherited.desc : settings.childSortDesc) ? "desc" : "asc"}
              disabled={settings.childSort === null || settings.childSort === "manual"}
              onChange={(e) => update({ childSortDesc: e.target.value === "desc" })}
            >
              <option value="asc">昇順</option>
              <option value="desc">降順</option>
            </select>
            {settings.childSort === null && (
              <span className="sub" data-testid="inherited-sort">
                今は{sortLabel(inherited.sort as ChildSort, inherited.desc)}
              </span>
            )}
          </span>
          <ColorRow
            id="tag-detail-bg"
            label="背景色"
            value={settings.bgColor}
            fallback={parent?.shownBgColor ?? DEFAULT_BG}
            onChange={(bgColor) => update({ bgColor })}
          />
          <ColorRow
            id="tag-detail-fg"
            label="文字色"
            value={settings.fgColor}
            fallback={parent?.shownFgColor ?? DEFAULT_FG}
            onChange={(fgColor) => update({ fgColor })}
          />
          <span>見本</span>
          <span>
            <span
              className="chip tag-sample"
              data-testid="tag-sample"
              style={{ background: bg ?? undefined, color: fg ?? undefined }}
            >
              {name.trim() || tag.name}
            </span>
          </span>
        </div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
          <button onClick={onClose}>やめる</button>
          <button onClick={submit} disabled={busy || !name.trim()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
