import type { Facets, FileFilter } from "../api";
import { OTHER_ITEMS, type OtherKey } from "../otherFilters";
import { Collapsible } from "./Collapsible";

type Props = {
  filter: FileFilter;
  onToggle: (key: OtherKey) => void;
  /** 各項目を選んだときの件数。まだ求めていなければ null（件数を出さない） */
  facets: Facets | null;
};

/** 左の欄の「その他」。重複・直近で再生・リンク切れで絞り込む（項目どうしとほかの条件はAND） */
export function OtherPanel({ filter, onToggle, facets }: Props) {
  return (
    <Collapsible id="other" title="その他" selectedCount={OTHER_ITEMS.filter((i) => filter[i.key]).length}>
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
    </Collapsible>
  );
}
