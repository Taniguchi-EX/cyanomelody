import type { LiveEffect, LiveEffectKind, PadPoint } from "./liveAudio";

/** 0〜1 を、lo〜hi の対数の目盛りに写す（周波数など） */
export const logScale = (t: number, lo: number, hi: number) => lo * Math.pow(hi / lo, Math.min(1, Math.max(0, t)));

/** 値を滑らかに変える時間（秒）。指の動きに追いつき、かつ「ジリジリ」鳴らない程度 */
const SMOOTH = 0.015;

/** ローパスフィルター（仮）：横で効く周波数（左ほどこもる）、縦で強さ（上ほどクセが強い） */
const lowpass: LiveEffectKind = {
  id: "lpf",
  label: "LPF",
  xLabel: "周波数",
  yLabel: "強さ",
  create(ctx): LiveEffect {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    return {
      input: filter,
      output: filter,
      move({ x, y }: PadPoint) {
        const t = ctx.currentTime;
        filter.frequency.setTargetAtTime(logScale(x, 150, 12000), t, SMOOTH);
        filter.Q.setTargetAtTime(0.7 + y * 14, t, SMOOTH);
      },
      dispose() {
        filter.disconnect();
      },
    };
  },
};

/** ライブの画面に並べるエフェクト（並べた順にボタンを出す）。段階2で増やす */
export const LIVE_EFFECTS: LiveEffectKind[] = [lowpass];
