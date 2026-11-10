/** 画面と Rust のあいだでやりとりするデータの形（Rust の構造体と同じ形） */

export type LibraryFolder = {
  id: number;
  path: string;
  fileCount: number;
  missingCount: number;
};

export type ScanResult = {
  folderId: number;
  found: number;
  added: number;
  missing: number;
  restored: number;
};

export type AudioFile = {
  id: number;
  relPath: string;
  /** 絶対パス（再生に使う） */
  path: string;
  missing: boolean;
  /** 付いているタグ（タグの一覧の順） */
  tags: { id: number; name: string }[];
  hash: string | null;
  hashError: string | null;
  sourceId: number | null;
  licenseId: number | null;
  /** 一覧の中で行を見分ける値。ライブラリの一覧ではファイルの id、抽選した並びでは行の番号（同じファイルが2行出ることがある） */
  key: number;
  /** 抽選した並びの行だけ：ファイルの項目の別名（プレイリスト上での名前） */
  alias: string | null;
  /** 抽選した並びの行だけ：この曲を出した、選んだプレイリストの直下の項目（ファイルの項目から来た曲は null） */
  origin: RowOrigin | null;
  /** 抽選した並びの行だけ：選んだプレイリストの直下の項目の id（ファイルの項目も含む） */
  itemId: number | null;
  /** 抽選した並びの行だけ：かけるエフェクトセット（内側から外側の順） */
  chains: number[];
  /** 抽選した並びの行だけ：🎲・🔀の項目を通った曲（抽選し直すと変わりうる） */
  drawn: boolean;
};

/** 抽選した並びの行が、どの項目から来たか（行のアイコンと説明に使う） */
export type RowOrigin = {
  itemId: number;
  kind: "tags" | "playlist";
  mode: PlayMode;
  /** タグの組み合わせは「雨 ＋ 風」、プレイリストは別名かその名前 */
  label: string;
};

export type FileFilter = {
  text: string;
  tagIds: number[];
  untaggedOnly: boolean;
  missingOnly: boolean;
  duplicatesOnly: boolean;
  hash: string | null;
  /** どれかの出典が設定されたファイル（OR） */
  sourceIds: number[];
  noSource: boolean;
  /** どれかのライセンスが設定されたファイル（OR） */
  licenseIds: number[];
  noLicense: boolean;
  /** 指定したidのファイルだけ（チェックしたファイルだけの表示）。null なら絞り込まない */
  fileIds: number[] | null;
  /** このライブラリフォルダのファイルだけ。null なら絞り込まない */
  folderId: number | null;
  /** 直近で再生したファイルだけ（新しく再生した順に並ぶ） */
  recentOnly: boolean;
  /** 長さ（秒）がこれ以上・以下のファイルだけ（長さのないファイルは出ない）。null なら絞り込まない */
  minDuration: number | null;
  maxDuration: number | null;
  /** リリース年がこれ以上・以下のファイルだけ（年のないファイルは出ない）。null なら絞り込まない */
  minYear: number | null;
  maxYear: number | null;
  /** 抽選した並び（プレイリストを選んでいるとき）の中で絞り込む。行ごとに返る */
  draw: boolean;
  /** 一覧の並び順（絞り込みには使わない）。なければパス順 */
  sort?: FileSort;
  sortDesc?: boolean;
};

/** ファイルの一覧の並び順 */
export type FileSort = "path" | "name" | "added" | "modified" | "duration" | "playlist";

/** ひも付けた結果。ライブラリに登録したフォルダがあれば、そのパス */
export type LinkOutcome = { path: string; addedFolder: string | null };

/** 絞り込みの各項目を選んだときの件数。0件の項目は入らない */
export type Facets = {
  tags: CountItem[];
  untagged: number;
  /** id が null は「（出典なし）」 */
  sources: CountItem[];
  licenses: CountItem[];
  /** 「その他」の各項目を選んだときの件数 */
  duplicates: number;
  recent: number;
  missing: number;
};

/** 件数の内訳の1項目。id が null は「なし」 */
export type CountItem = { id: number | null; count: number };

/** タグと、そのタグが付いているファイルの数（チェックしたファイルのうち） */
export type TagCount = { id: number; name: string; count: number };

/** 一括操作の欄に出す、対象のファイルの内訳 */
export type BulkSummary = {
  /** 付いているタグと件数（タグの一覧の順） */
  tags: TagCount[];
  /** 入っているプレイリスト（ファイルの項目として）と件数 */
  playlists: TagCount[];
  /** 出典・ライセンスごとの件数（id が null は設定なし） */
  sources: { id: number | null; count: number }[];
  licenses: { id: number | null; count: number }[];
  /** リンク切れのファイル */
  missingIds: number[];
};

export type Tag = {
  id: number;
  name: string;
  /** 親のタグのid。最上位なら null */
  parentId: number | null;
  /** 階層の深さ。最上位は0 */
  depth: number;
  /** そのタグか子孫のタグが付いたファイルの数 */
  fileCount: number;
  /** 表示に使う色。自分の色がなければ、親（その親…）の色を引き継いだもの */
  shownBgColor: string | null;
  shownFgColor: string | null;
  /** 子のタグを実際に並べる順。親の設定を引き継ぐなら、引き継いだもの */
  shownChildSort: ChildSort;
  shownChildSortDesc: boolean;
  /** シノニム（別の名前）。決めた順 */
  synonyms: string[];
} & TagSettings;

/** 子のタグの並び順。manual はドラッグで決めた順 */
export type ChildSort = "manual" | "created" | "files" | "romaji";

/** タグの詳細画面で決めるもの（名前を除く） */
export type TagSettings = {
  /** null は親の設定を引き継ぐ（最上位までたどって決まっていなければ、ドラッグで決めた順） */
  childSort: ChildSort | null;
  childSortDesc: boolean;
  /** 背景色・文字色（#rrggbb）。null は親の色を引き継ぐ */
  bgColor: string | null;
  fgColor: string | null;
};

/** 木（タグ・プレイリスト）の並べ替えで、移す先 */
export type MoveTarget =
  | { kind: "before"; id: number }
  | { kind: "after"; id: number }
  | { kind: "child"; id: number }
  | { kind: "root" };

/** 出典かライセンスか */
export type CreditKind = "source" | "license";

/** ライセンスの条項。null は「不明」 */
export type Terms = {
  commercial: boolean | null;
  credit: boolean | null;
  modify: boolean | null;
  redistribute: boolean | null;
  shareAlike: boolean | null;
};

export type LicenseType = {
  key: string;
  name: string;
  terms: Terms;
};

/** 出典またはライセンス。出典では licenseType は null、terms はすべて不明 */
export type Credit = {
  id: number;
  name: string;
  url: string;
  note: string;
  /** 一般的なライセンスの種類。「独自」のときは null */
  licenseType: string | null;
  terms: Terms;
  fileCount: number;
};

export type CreditInput = {
  name: string;
  url: string;
  note: string;
  licenseType: string | null;
  terms: Terms;
};

export type RenameResult = {
  tagId: number;
  merged: boolean;
};

export type HashProgress = {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  cancelled: boolean;
};

export type RelinkResult = {
  relinked: number;
  notFound: number;
  ambiguous: number;
  noHash: number;
};

/** 抽象的な項目の再生方法 */
export type PlayMode = "order" | "shuffle" | "random";

/** 左の欄に出すプレイリスト（階層の順） */
export type PlaylistNode = {
  id: number;
  name: string;
  /** 親（このプレイリストを子として持つプレイリスト）。最上位なら null */
  parentId: number | null;
  depth: number;
  /** 通しで流したときに鳴る曲の数（🎲の項目は1曲）。左の欄の行の件数 */
  trackCount: number;
  /** 項目として直接入れているプレイリスト（子と参照） */
  refs: number[];
};

export type PlaylistItem = {
  id: number;
  kind: "file" | "tags" | "playlist";
  mode: PlayMode;
  /** 子のプレイリストの項目か（参照なら false） */
  owned: boolean;
  file: { id: number; relPath: string; missing: boolean } | null;
  tags: { id: number; name: string }[];
  playlist: { id: number; name: string } | null;
  /** 再生したときのファイル数 */
  fileCount: number;
  /** 別名（このプレイリストの中でだけ使う名前） */
  alias: string | null;
  /** 結び付けたエフェクトセット */
  effectChain: { id: number; name: string } | null;
};

export type PlaylistDetail = {
  id: number;
  name: string;
  items: PlaylistItem[];
};

/** 再生順の1曲 */
export type PlayEntry = {
  fileId: number;
  relPath: string;
  path: string;
  /** ファイルの項目の別名 */
  alias: string | null;
  /** かけるエフェクトセットの id（内側から外側の順）。空ならエフェクトなし */
  chains: number[];
  /** この曲を出した、再生したプレイリストの（いちばん外側の）項目。ファイルの一覧の再生では null */
  itemId: number | null;
  /** 中央の一覧から再生したとき：その行（AudioFile.key）。鳴らしている行の印と、曲名から一覧へ移るのに使う */
  rowKey?: number;
  /** 抽選し直すと変わりうる曲（🎲・🔀の項目を通った曲） */
  drawn?: boolean;
};

/** プレイリストの出力の進み具合 */
export type ExportProgress = {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  cancelled: boolean;
  /** 書き出し先（作ったフォルダ） */
  folder: string;
};

/** エクスポート・インポートする項目 */
export type DataSections = {
  /** ライブラリ（登録したフォルダ） */
  library: boolean;
  /** タグと曲へのタグ付け */
  tags: boolean;
  /** プレイリストとエフェクトセット */
  playlists: boolean;
  /** 出典・ライセンスと曲への設定、新しく作るタグの既定値、画面の設定 */
  credits: boolean;
};

/** エクスポートで書き出した件数 */
export type ExportSummary = {
  folders: number;
  files: number;
  tags: number;
  playlists: number;
  effectChains: number;
  sources: number;
  licenses: number;
};

/** インポートの見込み */
export type ImportPreview = {
  sections: DataSections;
  appVersion: string;
  /** 書き出した日時（UNIX 時間の秒） */
  exportedAt: number;
  folders: number;
  /** このPCにあるフォルダの数 */
  foldersFound: number;
  files: number;
  tags: number;
  playlists: number;
  effectChains: number;
  sources: number;
  licenses: number;
  /** 今のライブラリで見つかる曲 */
  matchedByPath: number;
  matchedByHash: number;
  matchedByName: number;
  /** ハッシュ値をまだ計算していない曲の数 */
  pendingHashes: number;
  /** 「置き換える」で消える、今のデータの数 */
  current: {
    foldersNotInFile: number;
    tags: number;
    playlists: number;
    effectChains: number;
    sources: number;
    licenses: number;
  };
};

/** インポートの結果 */
export type ImportResult = {
  foldersAdded: number[];
  foldersSkipped: number;
  foldersRemoved: number;
  filesMatched: number;
  filesUnmatched: number;
  tagsAdded: number;
  fileTagsAdded: number;
  sourcesAdded: number;
  licensesAdded: number;
  creditsSet: number;
  effectChainsAdded: number;
  playlistsAdded: number;
  itemsSkipped: number;
  /** 取り込んだ画面の設定 */
  screen: Record<string, unknown> | null;
};

/** ファイル1件の自動タグ付けの結果 */
export type AutotagFileResult = {
  /** ファイルを読めたか */
  readable: boolean;
  /** 新しく付けたタグ（項目の名前とタグの名前） */
  added: { field: string; name: string }[];
  /** 新しく作ったタグの数 */
  created: number;
  /** 使える値があったか */
  hasInfo: boolean;
};

/** 裏で行う自動タグ付けの進み具合 */
export type AutotagProgress = {
  running: boolean;
  done: number;
  total: number;
  /** タグを新しく付けたファイルの数 */
  tagged: number;
  /** 新しく作ったタグの数 */
  created: number;
  /** 使える情報がなかったファイルの数 */
  noInfo: number;
  /** 読めなかったファイルの数 */
  failed: number;
  cancelled: boolean;
};

/** ファイルの削除の結果 */
export type DeleteResult = {
  /** 削除して、ライブラリから外したファイルの数 */
  deleted: number;
  /** 削除できなかったファイル（ライブラリに残る） */
  failed: { id: number; relPath: string; reason: string }[];
};
