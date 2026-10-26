// フォルダをたどって 1 つ選ぶ部品。Drive の指定フォルダと、Android の端末のフォルダで使う。

import { useCallback, useEffect, useState } from "react";
import { useShared } from "../state";

export interface FolderNode {
  /** Drive はフォルダ ID、端末はフルパス */
  id: string;
  name: string;
}

interface Props {
  /** 一番上の表示（例：`マイドライブ`、`/storage/emulated/0`） */
  rootLabel: string;
  /** `path`（一番上からたどったフォルダ）の直下のフォルダを読む。失敗したら undefined */
  loadChildren: (path: FolderNode[]) => Promise<FolderNode[] | undefined>;
  /** 一番上のフォルダそのものを選べるか */
  allowRoot: boolean;
  onChoose: (path: FolderNode[]) => void;
  onCancel: () => void;
}

export default function FolderPicker({ rootLabel, loadChildren, allowRoot, onChoose, onCancel }: Props) {
  const { busy } = useShared();
  const [path, setPath] = useState<FolderNode[]>([]);
  const [children, setChildren] = useState<FolderNode[] | null>(null);

  const open = useCallback(
    async (next: FolderNode[]) => {
      setChildren(null);
      const loaded = await loadChildren(next);
      if (loaded) {
        setPath(next);
        setChildren(loaded);
      }
    },
    [loadChildren],
  );
  useEffect(() => {
    open([]);
  }, [open]);

  // 読み込み中は操作させない（読み込む前の親のフォルダを選んでしまわないため）
  const loading = busy !== null || children === null;
  const label = [rootLabel, ...path.map((f) => f.name)].join("/");

  return (
    <div className="picker">
      <div className="row path">
        <button className="icon" disabled={loading || path.length === 0} onClick={() => open(path.slice(0, -1))}>
          ↑
        </button>
        <span className="grow">{label}</span>
        <button className="primary" disabled={loading || (!allowRoot && path.length === 0)} onClick={() => onChoose(path)}>
          このフォルダにする
        </button>
        <button onClick={onCancel}>やめる</button>
      </div>
      <ul className="list">
        {children?.map((f) => (
          <li key={f.id} className="clickable" onClick={() => !loading && open([...path, f])}>
            📁 {f.name}
          </li>
        ))}
        {children?.length === 0 && <li className="dim">サブフォルダはありません</li>}
        {children === null && <li className="dim">読み込んでいます…</li>}
      </ul>
    </div>
  );
}
