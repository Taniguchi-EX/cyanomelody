import { useState } from "react";
import type { Facets, FileFilter } from "../api";
import {
  DURATION_LIMITS,
  OTHER_ITEMS,
  parseDuration,
  parseYear,
  YEAR_LIMITS,
  type DurationKey,
  type OtherKey,
  type YearKey,
} from "../otherFilters";
import { Collapsible } from "./Collapsible";

type Props = {
  filter: FileFilter;
  onToggle: (key: OtherKey) => void;
  /** 長さの条件（以上・以下）を決める */
  onDuration: (key: DurationKey, seconds: number) => void;
  /** リリース年の条件（以上・以下）を決める */
  onYear: (key: YearKey, year: number) => void;
  /** 各項目を選んだときの件数。まだ求めていなければ null（件数を出さない） */
  facets: Facets | null;
};

/** 左の欄の「その他」。重複・直近で再生・リンク切れ・長さ・リリース年で絞り込む（項目どうしとほかの条件はAND） */
export function OtherPanel({ filter, onToggle, onDuration, onYear, facets }: Props) {
  // 長さの入力欄（時:分:秒）。条件を加えた後も残す
  const [durationText, setDurationText] = useState("00:00:00");
  const seconds = parseDuration(durationText);
  // リリース年の入力欄（4桁）。最初は空。条件を加えた後も残す
  const [yearText, setYearText] = useState("");
  const year = parseYear(yearText);
  const selectedCount =
    OTHER_ITEMS.filter((i) => filter[i.key]).length +
    DURATION_LIMITS.filter((l) => filter[l.key] !== null).length +
    YEAR_LIMITS.filter((l) => filter[l.key] !== null).length;
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
      {/* 長さ：「時:分:秒」を入れて「以上」「以下」で条件を加える（それぞれ1つまで。押し直すと置き換わる） */}
      <div className="duration-filter" data-testid="duration-input">
        <span className="chip-icon">⏱</span>
        <span className="duration-label">長さ</span>
        <input
          type="text"
          className={seconds === null ? "invalid" : undefined}
          value={durationText}
          onChange={(e) => setDurationText(e.target.value)}
          onFocus={(e) => e.target.select()}
          aria-label="長さ"
          title="時:分:秒（「分:秒」「秒」でもよい）"
        />
        {DURATION_LIMITS.map((l) => (
          <button
            key={l.key}
            onClick={() => seconds && onDuration(l.key, seconds)}
            disabled={!seconds}
            title={`長さがこれ${l.label}のファイルに絞り込む`}
          >
            {l.label}
          </button>
        ))}
      </div>
      {/* リリース年：4桁の年を入れて「以上」「以下」（その年を含む）で条件を加える（それぞれ1つまで。押し直すと置き換わる） */}
      <div className="duration-filter" data-testid="year-input">
        <span className="chip-icon">📅</span>
        <span className="duration-label">リリース年</span>
        <input
          type="text"
          inputMode="numeric"
          className={yearText.trim() !== "" && year === null ? "invalid" : undefined}
          value={yearText}
          onChange={(e) => setYearText(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder="2010"
          aria-label="リリース年"
          title="4桁の年（例：2010）"
        />
        {YEAR_LIMITS.map((l) => (
          <button
            key={l.key}
            onClick={() => year && onYear(l.key, year)}
            disabled={!year}
            title={`リリース年がこの年${l.label}（この年を含む）のファイルに絞り込む`}
          >
            {l.label}
          </button>
        ))}
      </div>
    </Collapsible>
  );
}
