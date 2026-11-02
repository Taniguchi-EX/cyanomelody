import type { FileFilter, Tag } from "../api";

type Props = {
  tags: Tag[];
  filter: FileFilter;
  onToggleTag: (tagId: number) => void;
  onToggleUntagged: () => void;
  onManage: () => void;
};

export function TagPanel({ tags, filter, onToggleTag, onToggleUntagged, onManage }: Props) {
  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>タグで絞り込む</h2>
        <button onClick={onManage}>タグを管理</button>
      </div>
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
    </section>
  );
}
