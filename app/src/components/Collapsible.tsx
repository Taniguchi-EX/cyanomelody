import { useState, type ReactNode } from "react";

type Props = {
  /** たたんだ状態を覚えておくための名前 */
  id: string;
  title: string;
  /** 選んでいる絞り込みの条件の数。たたんでいても見出しに出す */
  selectedCount: number;
  /** 見出しの右に置くボタンなど */
  actions?: ReactNode;
  children: ReactNode;
};

const storageKey = (id: string) => `cyanomelody.collapsed.${id}`;

function loadCollapsed(id: string): boolean {
  try {
    return localStorage.getItem(storageKey(id)) === "1";
  } catch {
    return false;
  }
}

function saveCollapsed(id: string, collapsed: boolean) {
  try {
    localStorage.setItem(storageKey(id), collapsed ? "1" : "0");
  } catch {
    // 覚えておけなくても動作には困らない
  }
}

/** 見出しを押すとたためる、左の欄の1つの欄 */
export function Collapsible({ id, title, selectedCount, actions, children }: Props) {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(id));

  const toggle = () => {
    setCollapsed((c) => {
      saveCollapsed(id, !c);
      return !c;
    });
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
        </button>
        {actions}
      </div>
      {!collapsed && children}
    </section>
  );
}
