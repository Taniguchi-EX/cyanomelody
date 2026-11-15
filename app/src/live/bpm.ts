/** BPM を測るボタンの計算（ライブの画面の左下） */

/** 前に押してから、これ（ミリ秒）より空いたら数え直す */
export const TAP_RESET_MS = 2000;
/** BPM を出し始める押した回数 */
export const TAP_MIN = 4;
/** 平均に使う、直近の押した回数 */
export const TAP_MAX = 8;
/** 一度も測っていないときの BPM */
export const DEFAULT_BPM = 120;

/**
 * 押した時刻（ミリ秒）を足す。数え直しのときは、その1回だけにする。直近の TAP_MAX 回だけ残す
 */
export function addTap(taps: number[], now: number): number[] {
  const last = taps[taps.length - 1];
  const next = last !== undefined && now - last <= TAP_RESET_MS ? [...taps, now] : [now];
  return next.slice(-TAP_MAX);
}

/** 押した時刻から BPM を出す（TAP_MIN 回に満たなければ null）。間隔の平均から、小数第1位で丸める */
export function tapBpm(taps: number[]): number | null {
  if (taps.length < TAP_MIN) return null;
  const span = taps[taps.length - 1] - taps[0];
  const interval = span / (taps.length - 1);
  if (interval <= 0) return null;
  return Math.round((60000 / interval) * 10) / 10;
}
