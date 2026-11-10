import type { ListView } from "./FileList";
import { GridIcon, ListIcon } from "./Icons";
import { SearchBox } from "./SearchBox";

type Props = {
  /** 見出し：プレイリストを選んでいればその名前、選んでいなければ null（「ライブラリ」と出す） */
  playlistName: string | null;
  /** ファイル名の検索の文字 */
  text: string;
  onText: (text: string) => void;
  /** 並び順の選び肢と、選んでいるもの */
  sorts: { value: string; label: string }[];
  sortValue: string;
  onSort: (value: string) => void;
  /** 直近で再生したもので絞り込んでいる（再生した順に並べるので、並び順は選べない） */
  recentOnly: boolean;
  view: ListView;
  onView: (view: ListView) => void;
};

/** 中央の一覧の見出しの行：見出し、ファイル名の検索、並び順、見せ方（一覧・グリッド）の切り替え */
export function LibraryHead({ playlistName, text, onText, sorts, sortValue, onSort, recentOnly, view, onView }: Props) {
  return (
    <div className="toolbar editor-head library-head">
      <h2 className="editor-title" data-testid="list-title" title={playlistName ?? undefined}>
        {playlistName ?? "ライブラリ"}
      </h2>
      {/* ファイル名（相対パス）で一覧を絞り込む */}
      <SearchBox value={text} onChange={onText} label="ファイル名で検索" testId="file-search" />
      {/* 直近で再生したものは、再生した順に並べる（選べない） */}
      <select
        className="file-sort"
        value={sortValue}
        onChange={(e) => onSort(e.target.value)}
        disabled={recentOnly}
        aria-label="並び順"
        title={recentOnly ? "直近で再生したものは、新しく再生した順に並べます" : "一覧の並び順"}
        data-testid="file-sort"
      >
        {sorts.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      {/* 見せ方の切り替え（押すたびに一覧・グリッドが入れ替わる）。出す記号は、押すと切り替わる先 */}
      <button
        className="icon view-switch"
        title={view === "grid" ? "一覧で見る" : "グリッドで見る"}
        aria-label={view === "grid" ? "一覧で見る" : "グリッドで見る"}
        data-view={view}
        data-testid="view-switch"
        onClick={() => onView(view === "grid" ? "list" : "grid")}
      >
        {view === "grid" ? <ListIcon /> : <GridIcon />}
      </button>
    </div>
  );
}
