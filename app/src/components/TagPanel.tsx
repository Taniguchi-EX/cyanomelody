import type { FileFilter, Tag } from "../api";
import { Collapsible } from "./Collapsible";

type Props = {
  tags: Tag[];
  filter: FileFilter;
  onToggleTag: (tagId: number) => void;
  onToggleUntagged: () => void;
  onManage: () => void;
};

export function TagPanel({ tags, filter, onToggleTag, onToggleUntagged, onManage }: Props) {
  return (
    <Collapsible
      id="tags"
      title="タグで絞り込む"
      selectedCount={filter.tagIds.length + (filter.untaggedOnly ? 1 : 0)}
      actions={
        <button onClick={onManage} aria-label="タグを管理">
          管理
        </button>
      }
    >
      <ul className="tag-list">
        <li className={filter.untaggedOnly ? "active" : ""} onClick={onToggleUntagged} data-testid="untagged">
          <span>（タグなし）</span>
        </li>
        {tags.map((t) => (
          <li
            key={t.id}
            className={filter.tagIds.includes(t.id) ? "active" : ""}
            onClick={() => onToggleTag(t.id)}
            data-testid="tag"
          >
            <span>{t.name}</span>
            <span className="sub">{t.fileCount}</span>
          </li>
        ))}
      </ul>
      {tags.length === 0 && <div className="sub">タグはまだありません</div>}
    </Collapsible>
  );
}
