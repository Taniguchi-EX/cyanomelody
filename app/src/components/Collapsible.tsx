import type { ReactNode } from "react";
import { useStoredFlag } from "../storage";

type Props = {
  /** たたんだ状態を覚えておくための名前 */
  id: string;
  title: string;
  /** 選んでいる絞り込みの条件の数。たたんでいても見出しに出す */
  selectedCount?: number;
  /** 中の項目の数（右の欄の、付いているタグなど）。たたんでいても見出しに出す */
  count?: number;
  /** 見出しの右に置くボタンなど。関数なら、欄を開く関数を受け取る（たたんでいるときに「＋」を押したら開くなど） */
  actions?: ReactNode | ((expand: () => void) => ReactNode);
  children: ReactNode;
};

/** 見出しを押すとたためる1つの欄（左の欄の各欄、右の欄のタグ・プレイリスト） */
export function Collapsible({ id, title, selectedCount = 0, count, actions, children }: Props) {
  const [collapsed, toggle] = useStoredFlag(`cyanomelody.collapsed.${id}`);
  const expand = () => {
    if (collapsed) toggle();
  };

  return (
    <section className="collapsible" data-testid={`section-${id}`} data-collapsed={collapsed}>
      <div className="row collapsible-head">
        <button className="collapse-toggle" onClick={toggle} aria-expanded={!collapsed}>
          <span className="caret">{collapsed ? "▶" : "▼"}</span>
          <h2>{title}</h2>
          {selectedCount > 0 && (
            <span className="chip" data-testid="selected-count" title={`${selectedCount}件を選択中`}>
              {selectedCount}
            </span>
          )}
          {count !== undefined && (
            <span className="sub" data-testid="section-count">
              {count}
            </span>
          )}
        </button>
        {typeof actions === "function" ? actions(expand) : actions}
      </div>
      {!collapsed && children}
    </section>
  );
}
