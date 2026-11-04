import { useState } from "react";
import type { Facets, FileFilter } from "../api";
import { DURATION_LIMITS, OTHER_ITEMS, type DurationKey, type OtherKey } from "../otherFilters";
import { Collapsible } from "./Collapsible";

type Props = {
  filter: FileFilter;
  onToggle: (key: OtherKey) => void;
  /** 長さの条件（以上・以下）を決める */
  onDuration: (key: DurationKey, seconds: number) => void;
  /** 各項目を選んだときの件数。まだ求めていなければ null（件数を出さない） */
  facets: Facets | null;
};

const DURATION_UNITS = [
  { key: "h", label: "時", seconds: 3600 },
  { key: "m", label: "分", seconds: 60 },
  { key: "s", label: "秒", seconds: 1 },
] as const;

/** 入力欄の文字を数にする（数字だけ。空は0） */
const digits = (text: string) => text.replace(/[^0-9]/g, "");

/** 左の欄の「その他」。重複・直近で再生・リンク切れ・長さで絞り込む（項目どうしとほかの条件はAND） */
export function OtherPanel({ filter, onToggle, onDuration, facets }: Props) {
  // 長さの入力欄（時・分・秒）。条件を加えた後も残す
  const [parts, setParts] = useState({ h: "", m: "", s: "" });
  const seconds = DURATION_UNITS.reduce((sum, u) => sum + Number(parts[u.key] || 0) * u.seconds, 0);
  const selectedCount =
    OTHER_ITEMS.filter((i) => filter[i.key]).length + DURATION_LIMITS.filter((l) => filter[l.key] !== null).length;
  return (
    <Collapsible id="other" title="その他" selectedCount={selectedCount}>
      <ul className="tag-list">
        {OTHER_ITEMS.map((item) => {
          const selected = filter[item.key];
          const count = facets ? facets[item.count] : null;
          // 選ぶと0件になる項目はグレーアウトし、選べないようにする（選んでいる項目は外せる）
          const disabled = count === 0 && !selected;
          return (
            <li
              key={item.key}
              className={(selected ? "active" : "") + (disabled ? " disabled" : "")}
              onClick={() => !disabled && onToggle(item.key)}
              aria-disabled={disabled}
              data-testid="other"
              data-other={item.key}
            >
              <span className="tag-name">
                <span className="chip-icon">{item.icon}</span> {item.label}
              </span>
              {count !== null && <span className="sub">{count}</span>}
            </li>
          );
        })}
      </ul>
      {/* 長さ：時・分・秒を入れて「以上」「以下」で条件を加える（それぞれ1つまで。押し直すと置き換わる） */}
      <div className="duration-filter" data-testid="duration-input">
        <span className="chip-icon">⏱</span>
        <span className="duration-label">長さ</span>
        {DURATION_UNITS.map((u) => (
          <label key={u.key} className="duration-part">
            <input
              type="text"
              inputMode="numeric"
              value={parts[u.key]}
              onChange={(e) => setParts((p) => ({ ...p, [u.key]: digits(e.target.value) }))}
              aria-label={`長さの${u.label}`}
            />
            {u.label}
          </label>
        ))}
        {DURATION_LIMITS.map((l) => (
          <button
            key={l.key}
            onClick={() => onDuration(l.key, seconds)}
            disabled={seconds === 0}
            title={`長さがこれ${l.label}のファイルに絞り込む`}
          >
            {l.label}
          </button>
        ))}
      </div>
    </Collapsible>
  );
}
