// 木（タグ・プレイリスト）の行に共通の部品

type TwistyProps = {
  name: string;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
};

/** 開く・たたむの印。子のない節では空白になり、押すと行を押したことになる */
export function Twisty({ name, hasChildren, collapsed, onToggle }: TwistyProps) {
  return (
    <span
      className="twisty"
      onClick={(e) => {
        if (!hasChildren) return;
        e.stopPropagation();
        onToggle();
      }}
      role={hasChildren ? "button" : undefined}
      aria-label={hasChildren ? `${name}を${collapsed ? "開く" : "たたむ"}` : undefined}
      data-testid="tag-twisty"
    >
      {hasChildren ? (collapsed ? "▶" : "▼") : ""}
    </span>
  );
}

type HandleProps = {
  name: string;
  /** useTreeDrag の handleProps(id) */
  handlers: ReturnType<ReturnType<typeof import("../treeDrag").useTreeDrag>["handleProps"]>;
};

/** 並べ替えの取っ手 */
export function DragHandle({ name, handlers }: HandleProps) {
  return (
    <span
      className="drag-handle"
      title="ドラッグして並べ替え"
      aria-label={`${name}を移す`}
      data-testid="drag-handle"
      {...handlers}
    >
      ≡
    </span>
  );
}
