import { api, playlistApi, type AudioFile, type FileFilter, type PlayEntry, type PlaylistItem, type PlaylistNode } from "../api";
import { PLAYLIST_SORTS } from "../listOptions";
import type { PreviewTarget, useAudioPlayer } from "./useAudioPlayer";
import type { usePlaylistSelection } from "./usePlaylistSelection";

/** ファイルの一覧を再生するときの、再生の欄の名前 */
const LIST_NAME = "ファイルの一覧";

type Params = {
  audio: ReturnType<typeof useAudioPlayer>;
  /** 中央の一覧 */
  files: AudioFile[];
  selection: ReturnType<typeof usePlaylistSelection>;
  /** 中央の一覧を読む条件（今の絞り込みと並び順） */
  listRequest: () => FileFilter;
  /** プレイリストを選んでいるときの並び順（PLAYLIST_SORTS の value） */
  playlistSortValue: string;
  playlists: PlaylistNode[];
  playlistName: (id: number) => string;
  /** 開いている編集画面のプレイリスト（なければ null） */
  editorId: number | null;
  openEditor: (id: number, itemId?: number | null) => Promise<void>;
  /** 中央の一覧のその行までスクロールして、右の欄に出す */
  reveal: (key: number) => void;
  showInfo: (text: string) => void;
  showError: (e: unknown) => void;
};

/** 中央の一覧・プレイリスト・編集画面の項目を再生する操作と、鳴らしている曲の位置（一覧の行の印・曲名から飛ぶ先） */
export function usePlayback({
  audio,
  files,
  selection,
  listRequest,
  playlistSortValue,
  playlists,
  playlistName,
  editorId,
  openEditor,
  reveal,
  showInfo,
  showError,
}: Params) {
  const selectedPlaylistId = selection.selectedId;
  /** 鳴らしている曲（プレイリスト・一覧の再生。試聴なら null） */
  const playingEntry = audio.player?.queue[audio.player.index] ?? null;
  /** 鳴らしているファイル（再生の曲か、試聴中のファイル） */
  const playingTarget: PreviewTarget | null = playingEntry
    ? { id: playingEntry.fileId, relPath: playingEntry.relPath, path: playingEntry.path }
    : audio.previewFile;
  /** 鳴らしているファイル（一覧の再生・プレイリストの再生・エフェクトの試聴） */
  const playingFileId = audio.previewId ?? playingEntry?.fileId ?? null;
  /**
   * 一覧で鳴らしている印を付ける行。一覧から鳴らしているならその行。
   * 試聴や、選んでいないプレイリストの再生では、ライブラリの一覧ならそのファイルの行（プレイリストを選んでいるときは付けない）
   */
  const playingRowKey = playingEntry?.rowKey ?? (selectedPlaylistId === null ? playingFileId : null);

  /**
   * 再生の順番を作って鳴らす。鳴らすファイルがなければ、そのことを出す。
   * name は再生の欄に出す名前、sourceId は再生しているプレイリスト（編集画面で再生中の項目を示し、曲名から編集画面を開くのに使う）。
   * 読み込んだ並び（中の項目の再生方法は当てはめたもの）に、再生の欄で選んだ再生方法を当てはめて鳴らす
   */
  const startQueue = async (name: string, load: () => Promise<PlayEntry[]>, sourceId: number | null, empty: string) => {
    try {
      const source = await load();
      if (source.length === 0) showInfo(empty);
      else audio.playSource(name, source, null, sourceId);
    } catch (e) {
      showError(e);
    }
  };

  /**
   * 中央の一覧（rows）を、再生の欄で選んだ再生方法で再生する。見つからないファイルは除く。
   * 再生を始めたときの一覧で再生し、途中で絞り込みを変えても順番は変わらない。start があればその行から（再生方法に従う）。
   * プレイリストを選んでいるときは、プレイリストとして再生する（各行の項目のエフェクトをかけ、プレイリスト上での名前を使う）
   */
  const playRows = (rows: AudioFile[], start?: AudioFile, playlistId: number | null = selectedPlaylistId) => {
    const source: PlayEntry[] = rows
      .filter((f) => !f.missing)
      .map((f) => ({
        fileId: f.id,
        relPath: f.relPath,
        path: f.path,
        alias: f.alias,
        chains: f.chains,
        itemId: f.itemId,
        rowKey: f.key,
        drawn: f.drawn,
      }));
    if (source.length === 0) {
      showInfo("再生するファイルがありません");
      return;
    }
    const index = start ? source.findIndex((e) => e.rowKey === start.key) : -1;
    const name = playlistId !== null ? playlistName(playlistId) : LIST_NAME;
    audio.playSource(name, source, index >= 0 ? index : null, playlistId);
  };

  /** 表示中の一覧を再生する（start の行から） */
  const playList = (start?: AudioFile) => playRows(files, start);

  /**
   * 再生の欄の「▶」（何も再生していないとき）：表示中の一覧を再生する。
   * 選んでいるプレイリストを最後まで再生した後なら、抽選し直してから
   */
  const playOpen = async () => {
    const id = selectedPlaylistId;
    if (id !== null && audio.finished && audio.finished.sourceId === id) {
      try {
        await selection.redraw();
        playRows(await api.listFiles(listRequest()), undefined, id);
      } catch (e) {
        showError(e);
      }
      return;
    }
    playList();
  };

  /**
   * 選んだ状態のプレイリストの、中央の一覧に出ている行（絞り込みと並び順のとおり）を読む。
   * 選んでいなければ、選んで（抽選して）から
   */
  const selectedRows = async (id: number) => {
    if (selectedPlaylistId === id) return api.listFiles(listRequest());
    await selection.select(id);
    // 選んだばかりなので、並び順はプレイリストのもの
    const sort = PLAYLIST_SORTS.find((x) => x.value === playlistSortValue) ?? PLAYLIST_SORTS[0];
    return api.listFiles({ ...listRequest(), draw: true, sort: sort.sort, sortDesc: sort.desc });
  };

  /** 編集画面の「▶ 再生」：そのプレイリストを選んだ状態にして（選んでいなければ選んで抽選し）、一覧を頭から再生する */
  const playFromEditor = async (id: number) => {
    try {
      playRows(await selectedRows(id), undefined, id);
    } catch (e) {
      showError(e);
    }
  };

  /** 一覧の行の「▶」：その行から一覧を再生する。鳴らしている行なら止める */
  const toggleRowPlay = (file: AudioFile) => {
    if (playingRowKey === file.key) audio.stop();
    else playList(file);
  };

  /** 編集画面の項目の「▶」：その項目だけを再生する */
  const playPlaylistItem = (item: PlaylistItem) =>
    editorId !== null &&
    startQueue(playlistName(editorId), () => playlistApi.expandItem(item.id), editorId, "再生するファイルがありません");

  /**
   * 再生の欄の曲名を押したとき：鳴らしている曲を出す。
   * 中央の一覧から鳴らしている曲なら、その行へスクロールして右の欄に出す（一覧になければ、そのことを出す）。
   * 選んでいないプレイリストの曲（編集画面の項目の再生など）なら、そのプレイリストの編集画面を開いてその項目の行を選ぶ
   */
  const jumpToPlaying = () => {
    const sourceId = audio.player?.sourceId ?? null;
    if (sourceId !== null && sourceId !== selectedPlaylistId && playlists.some((p) => p.id === sourceId)) {
      openEditor(sourceId, playingEntry?.itemId ?? null);
      return;
    }
    if (!playingTarget) return;
    // 一覧から鳴らしている曲はその行、試聴（エフェクトの管理画面）はそのファイルの行
    const key =
      playingEntry?.rowKey ?? (selectedPlaylistId === null ? playingTarget.id : files.find((f) => f.id === playingTarget.id)?.key);
    if (key === undefined || !files.some((f) => f.key === key)) {
      showInfo("鳴らしている曲は、今の絞り込みでは一覧に出ていません");
      return;
    }
    reveal(key);
  };

  return {
    playingTarget,
    playingFileId,
    playingRowKey,
    playList,
    playOpen,
    playFromEditor,
    toggleRowPlay,
    playPlaylistItem,
    jumpToPlaying,
  };
}
