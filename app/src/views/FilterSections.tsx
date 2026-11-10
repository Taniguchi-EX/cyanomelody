import { FolderPanel } from "../components/FolderPanel";
import { FilterChips } from "../components/FilterChips";
import { TagPanel } from "../components/TagPanel";
import { PlaylistPanel } from "../components/PlaylistPanel";
import { FILTER_KEYS } from "../hooks/useFileFilter";
import { CreditPanel } from "../components/CreditPanel";
import { OtherPanel } from "../components/OtherPanel";
import { SearchBox } from "../components/SearchBox";
import type { AppController } from "../hooks/useAppController";
import { CREDIT_KINDS } from "../credits";

/** 絞り込みの欄の中身：左の欄の検索、ライブラリ・タグ・プレイリスト・出典・ライセンス・その他の欄、選んでいる条件のチップ（Windows の左の欄、Android の絞り込みの画面） */
export function FilterSections({ c }: { c: AppController }) {
  const {
    folders,
    tags,
    fileFilter,
    filter,
    toggleTag,
    toggleUntagged,
    toggleCredit,
    toggleCreditNone,
    toggleOther,
    selectedPlaylistId,
    sideQuery,
    setSideQuery,
    facets,
    busy,
    setCreditForm,
    setTagDetailId,
    playlists,
    playlistEditor,
    resetFilter,
    tagActions,
    creditActions,
    creditsOf,
    library,
    playlistActions,
    togglePlaylist,
    filterChips,
  } = c;
  return (
    <>
        {/* 絞り込みの操作。左の欄をスクロールしても一番上に残す */}
        <div className="filter-bar" data-testid="filter-bar">
          <div className="row">
            {/* 左の欄のタグ・プレイリスト・出典・ライセンスを名前で絞り込む（ファイルの一覧は絞り込まない） */}
            <SearchBox value={sideQuery} onChange={setSideQuery} label="検索" testId="side-search" />
          </div>
        </div>
        <FolderPanel
          folders={folders}
          busy={busy}
          onAdd={library.browseAndAddFolder}
          onRemove={library.removeFolder}
          onScan={(f) => library.scan([f])}
          selectedId={filter.folderId}
          onSelect={fileFilter.toggleFolder}
        />
        <TagPanel
          tags={tags}
          filter={filter}
          onToggleTag={toggleTag}
          onToggleUntagged={toggleUntagged}
          onCreate={tagActions.createTag}
          onEdit={(tag) => setTagDetailId(tag.id)}
          onDelete={tagActions.deleteTag}
          facets={facets}
          busy={busy}
          onMove={tagActions.moveTag}
          query={sideQuery}
        />
        <PlaylistPanel
          playlists={playlists}
          selectedId={selectedPlaylistId}
          busy={busy}
          onSelect={togglePlaylist}
          onEdit={(id) => playlistEditor.open(id)}
          onCreate={(name) => playlistActions.createPlaylist(name)}
          onDelete={playlistActions.deletePlaylist}
          onMove={playlistActions.movePlaylist}
          query={sideQuery}
        />
        {CREDIT_KINDS.map((kind) => (
          <CreditPanel
            key={kind}
            kind={kind}
            credits={creditsOf(kind)}
            selectedIds={filter[FILTER_KEYS[kind].ids]}
            noneSelected={filter[FILTER_KEYS[kind].none]}
            counts={facets ? (kind === "source" ? facets.sources : facets.licenses) : null}
            onToggle={(id) => toggleCredit(kind, id)}
            onToggleNone={() => toggleCreditNone(kind)}
            busy={busy}
            onEdit={(credit) => setCreditForm({ kind, credit })}
            onDelete={(credit) => creditActions.deleteCredit(kind, credit)}
            onMove={(credit, target) => creditActions.moveCredit(kind, credit, target)}
            query={sideQuery}
          />
        ))}
        <OtherPanel filter={filter} onToggle={toggleOther} onDuration={fileFilter.setDuration} onYear={fileFilter.setYear} facets={facets} />
        {/*
          選んでいる絞り込みの条件。左の欄の一番下に残す（出たり消えたりしても、上の行の位置が変わらないように）
        */}
        {filterChips.length > 0 && (
          <div className="filter-dock" data-testid="filter-dock">
            <FilterChips chips={filterChips} onClearAll={() => resetFilter()} />
          </div>
        )}
    </>
  );
}
