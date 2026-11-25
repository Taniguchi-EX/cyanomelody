import type { LiveEffect, LiveEffectKind, PadPoint } from "./liveAudio";
import { BeatClock } from "./beatClock";

/**
 * ライブの画面のエフェクト（12個。docs の 01-01_エフェクト.md）。SOUND VOLTEX の FX とつまみのフィルターを参考にしたもの。
 * 指を置いている間だけかかる（土台の liveAudio.ts が、素通しとエフェクトを切り替える）。
 * テンポに合わせるものは、指を置いた瞬間を拍の頭とみなし、BPM のボタンで測った BPM を使う
 */

/** 0〜1 を、lo〜hi の対数の目盛りに写す（周波数など） */
export const logScale = (t: number, lo: number, hi: number) => lo * Math.pow(hi / lo, Math.min(1, Math.max(0, t)));

/** 0〜1 を lo〜hi にまっすぐ写す */
const lerp = (t: number, lo: number, hi: number) => lo + (hi - lo) * Math.min(1, Math.max(0, t));

/** 値を滑らかに変える時間（秒）。指の動きに追いつき、かつ「ジリジリ」鳴らない程度 */
const SMOOTH = 0.015;

/** テンポに合わせる細かさの段階（beats は四分音符を1とした長さ） */
export const DIVISIONS = [
  { label: "1/4", beats: 1 },
  { label: "1/8", beats: 1 / 2 },
  { label: "1/12", beats: 1 / 3 },
  { label: "1/16", beats: 1 / 4 },
  { label: "1/24", beats: 1 / 6 },
  { label: "1/32", beats: 1 / 8 },
];

/** 横の位置から、細かさの段階を選ぶ（先頭の count 個の中から。左ほど長い） */
export function division(x: number, count = DIVISIONS.length) {
  return DIVISIONS[Math.min(count - 1, Math.max(0, Math.floor(x * count)))];
}

/** 段階の長さ（秒） */
const seconds = (beats: number, bpm: number) => (beats * 60) / bpm;

/** 周波数を「850Hz」「2.4kHz」の形にする */
const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)}kHz` : `${Math.round(f)}Hz`);

/** AudioWorklet の処理（processors.js）を使うノード。2チャンネルで出す */
const workletNode = (ctx: AudioContext, name: string) =>
  new AudioWorkletNode(ctx, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });

/** フィルター1つだけのエフェクト（LPF・HPF） */
function filterEffect(id: string, label: string, type: BiquadFilterType, lo: number, hi: number): LiveEffectKind {
  return {
    id,
    label,
    xLabel: "周波数",
    yLabel: "強さ",
    create(ctx): LiveEffect {
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      return {
        input: filter,
        output: filter,
        move({ x, y }: PadPoint) {
          const t = ctx.currentTime;
          const f = logScale(x, lo, hi);
          filter.frequency.setTargetAtTime(f, t, SMOOTH);
          filter.Q.setTargetAtTime(0.7 + y * 14, t, SMOOTH);
          return hz(f);
        },
        dispose() {
          filter.disconnect();
        },
      };
    },
  };
}

/** Retrigger：指を置いた瞬間からの音を、決まった長さで繰り返す（processors.js の cm-retrigger） */
const retrigger: LiveEffectKind = {
  id: "retrigger",
  label: "Retrigger",
  xLabel: "長さ",
  yLabel: "繰り返しの割合",
  create(ctx): LiveEffect {
    const node = workletNode(ctx, "cm-retrigger");
    const params = ({ x, y }: PadPoint, bpm: number) => {
      const d = division(x);
      return { d, length: seconds(d.beats, bpm), mix: lerp(y, 0.3, 1) };
    };
    return {
      input: node,
      output: node,
      start(p, bpm) {
        const { length, mix } = params(p, bpm);
        node.port.postMessage({ type: "start", length, mix });
      },
      move(p, bpm) {
        const { d, length, mix } = params(p, bpm);
        node.port.postMessage({ type: "set", length, mix });
        return d.label;
      },
      stop() {
        node.port.postMessage({ type: "stop" });
      },
      dispose() {
        node.disconnect();
      },
    };
  },
};

/** Gate：拍に合わせて音を細かく切る（前半は鳴らし、後半を切る） */
const gate: LiveEffectKind = {
  id: "gate",
  label: "Gate",
  xLabel: "刻み",
  yLabel: "切る深さ",
  create(ctx): LiveEffect {
    const g = ctx.createGain();
    let depth = 1;
    const clock = new BeatClock(ctx, (t, period) => {
      g.gain.setTargetAtTime(1, t, 0.002);
      g.gain.setTargetAtTime(1 - depth, t + period / 2, 0.002);
    });
    return {
      input: g,
      output: g,
      start({ x, y }, bpm) {
        depth = lerp(y, 0.5, 1);
        g.gain.cancelScheduledValues(ctx.currentTime);
        clock.start(seconds(division(x).beats, bpm));
      },
      move({ x, y }, bpm) {
        const d = division(x);
        depth = lerp(y, 0.5, 1);
        clock.setPeriod(seconds(d.beats, bpm));
        return d.label;
      },
      stop() {
        clock.stop();
        g.gain.cancelScheduledValues(ctx.currentTime);
        g.gain.setTargetAtTime(1, ctx.currentTime, 0.005);
      },
      dispose() {
        clock.stop();
        g.disconnect();
      },
    };
  },
};

/** Echo：拍に合わせた遅れで、音が繰り返しながら小さくなる。指を離した後も、残りの響きは鳴らす */
const echo: LiveEffectKind = {
  id: "echo",
  label: "Echo",
  xLabel: "遅れ",
  yLabel: "残る長さ",
  tail: true,
  create(ctx): LiveEffect {
    const input = ctx.createGain();
    const out = ctx.createGain();
    /** エフェクトの中の素通し（指を置いている間だけ開ける。離したら土台の素通しに戻る） */
    const through = ctx.createGain();
    /** 遅れへ送る音（指を置いている間だけ開ける） */
    const send = ctx.createGain();
    const delay = ctx.createDelay(2);
    const feedback = ctx.createGain();
    through.gain.value = 0;
    send.gain.value = 0;
    input.connect(through).connect(out);
    input.connect(send).connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(out);
    return {
      input,
      output: out,
      start() {
        const t = ctx.currentTime;
        through.gain.setTargetAtTime(1, t, 0.003);
        send.gain.setTargetAtTime(1, t, 0.003);
      },
      move({ x, y }, bpm) {
        const d = division(x, 4);
        const t = ctx.currentTime;
        delay.delayTime.setTargetAtTime(Math.min(2, seconds(d.beats, bpm)), t, SMOOTH);
        feedback.gain.setTargetAtTime(lerp(y, 0.3, 0.85), t, SMOOTH);
        return d.label;
      },
      stop() {
        const t = ctx.currentTime;
        through.gain.setTargetAtTime(0, t, 0.003);
        send.gain.setTargetAtTime(0, t, 0.003);
      },
      dispose() {
        input.disconnect();
        delay.disconnect();
        feedback.disconnect();
        out.disconnect();
      },
    };
  },
};

/** Wobble：こもった音（ローパス）の周波数を、拍に合わせて揺らす */
const wobble: LiveEffectKind = {
  id: "wobble",
  label: "Wobble",
  xLabel: "速さ",
  yLabel: "揺れの幅",
  create(ctx): LiveEffect {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 8;
    const amount = ctx.createGain();
    amount.connect(filter.detune);
    let lfo: OscillatorNode | null = null;
    const stopLfo = () => {
      lfo?.stop();
      lfo?.disconnect();
      lfo = null;
    };
    return {
      input: filter,
      output: filter,
      start({ x }, bpm) {
        // 揺れの始まりを、指を置いた瞬間にそろえる（作り直す）
        stopLfo();
        lfo = ctx.createOscillator();
        lfo.frequency.value = 1 / seconds(division(x).beats, bpm);
        lfo.connect(amount);
        lfo.start();
      },
      move({ x, y }, bpm) {
        const d = division(x);
        const t = ctx.currentTime;
        const octaves = lerp(y, 1, 6);
        // 周波数は、200Hz から 200Hz×2^octaves の間で揺れる（真ん中を基準に、上下に半分ずつ）
        filter.frequency.setTargetAtTime(200 * Math.pow(2, octaves / 2), t, SMOOTH);
        amount.gain.setTargetAtTime((octaves * 1200) / 2, t, SMOOTH);
        lfo?.frequency.setTargetAtTime(1 / seconds(d.beats, bpm), t, SMOOTH);
        return d.label;
      },
      stop: stopLfo,
      dispose() {
        stopLfo();
        filter.disconnect();
        amount.disconnect();
      },
    };
  },
};

/** SideChain：拍の頭ごとに音量を沈めて、なめらかに戻す */
const sideChain: LiveEffectKind = {
  id: "sidechain",
  label: "SideChain",
  xLabel: "刻み",
  yLabel: "沈む深さ",
  create(ctx): LiveEffect {
    const g = ctx.createGain();
    let depth = 0.8;
    const clock = new BeatClock(ctx, (t, period) => {
      g.gain.setTargetAtTime(1 - depth, t, 0.003);
      g.gain.setTargetAtTime(1, t + 0.015, period * 0.3);
    });
    return {
      input: g,
      output: g,
      start({ x, y }, bpm) {
        depth = lerp(y, 0.4, 0.95);
        g.gain.cancelScheduledValues(ctx.currentTime);
        clock.start(seconds(division(x, 4).beats, bpm));
      },
      move({ x, y }, bpm) {
        const d = division(x, 4);
        depth = lerp(y, 0.4, 0.95);
        clock.setPeriod(seconds(d.beats, bpm));
        return d.label;
      },
      stop() {
        clock.stop();
        g.gain.cancelScheduledValues(ctx.currentTime);
        g.gain.setTargetAtTime(1, ctx.currentTime, 0.005);
      },
      dispose() {
        clock.stop();
        g.disconnect();
      },
    };
  },
};

/** TapeStop：テープを止めたように、音が低く遅くなって止まる（processors.js の cm-tapestop） */
const tapeStop: LiveEffectKind = {
  id: "tapestop",
  label: "TapeStop",
  xLabel: "止まるまでの時間",
  yLabel: "",
  create(ctx): LiveEffect {
    const node = workletNode(ctx, "cm-tapestop");
    const time = (x: number) => logScale(x, 0.2, 2);
    return {
      input: node,
      output: node,
      start({ x }) {
        node.port.postMessage({ type: "start", seconds: time(x) });
      },
      move({ x }) {
        const s = time(x);
        node.port.postMessage({ type: "set", seconds: s });
        return `${s.toFixed(1)}秒`;
      },
      stop() {
        node.port.postMessage({ type: "stop" });
      },
      dispose() {
        node.disconnect();
      },
    };
  },
};

/** Pitch：速さを変えずに、音の高さだけを変える（processors.js の cm-pitch） */
const pitch: LiveEffectKind = {
  id: "pitch",
  label: "Pitch",
  xLabel: "高さ",
  yLabel: "変えた音の割合",
  create(ctx): LiveEffect {
    const node = workletNode(ctx, "cm-pitch");
    return {
      input: node,
      output: node,
      move({ x, y }) {
        const semitones = Math.round(lerp(x, -12, 12));
        node.port.postMessage({ ratio: Math.pow(2, semitones / 12), mix: lerp(y, 0.3, 1) });
        return `${semitones > 0 ? "+" : ""}${semitones}半音`;
      },
      dispose() {
        node.disconnect();
      },
    };
  },
};

/** Flanger：とても短い遅れを揺らして、元の音と重ねる（「シュワー」とうねる） */
const flanger: LiveEffectKind = {
  id: "flanger",
  label: "Flanger",
  xLabel: "うねりの速さ",
  yLabel: "深さ",
  create(ctx): LiveEffect {
    const input = ctx.createGain();
    const out = ctx.createGain();
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.004;
    const feedback = ctx.createGain();
    const wet = ctx.createGain();
    wet.gain.value = 0.7;
    const dry = ctx.createGain();
    dry.gain.value = 0.7;
    const lfo = ctx.createOscillator();
    const amount = ctx.createGain();
    input.connect(dry).connect(out);
    input.connect(delay);
    delay.connect(wet).connect(out);
    delay.connect(feedback).connect(delay);
    lfo.connect(amount).connect(delay.delayTime);
    lfo.start();
    return {
      input,
      output: out,
      move({ x, y }) {
        const t = ctx.currentTime;
        const rate = logScale(x, 0.1, 4);
        lfo.frequency.setTargetAtTime(rate, t, SMOOTH);
        amount.gain.setTargetAtTime(lerp(y, 0.0005, 0.003), t, SMOOTH);
        feedback.gain.setTargetAtTime(lerp(y, 0, 0.7), t, SMOOTH);
        return `${rate.toFixed(1)}Hz`;
      },
      dispose() {
        lfo.stop();
        input.disconnect();
        delay.disconnect();
        lfo.disconnect();
        out.disconnect();
      },
    };
  },
};

/** Phaser：オールパスのフィルターを並べて周波数を揺らし、元の音と重ねる（「フワフワ」とうねる） */
const phaser: LiveEffectKind = {
  id: "phaser",
  label: "Phaser",
  xLabel: "うねりの速さ",
  yLabel: "深さ",
  create(ctx): LiveEffect {
    const input = ctx.createGain();
    const out = ctx.createGain();
    const dry = ctx.createGain();
    dry.gain.value = 0.6;
    const wet = ctx.createGain();
    wet.gain.value = 0.6;
    const lfo = ctx.createOscillator();
    const amount = ctx.createGain();
    lfo.connect(amount);
    input.connect(dry).connect(out);
    let last: AudioNode = input;
    const stages = [400, 800, 1600, 3200].map((f) => {
      const ap = ctx.createBiquadFilter();
      ap.type = "allpass";
      ap.frequency.value = f;
      ap.Q.value = 0.8;
      amount.connect(ap.detune);
      last.connect(ap);
      last = ap;
      return ap;
    });
    last.connect(wet).connect(out);
    lfo.start();
    return {
      input,
      output: out,
      move({ x, y }) {
        const t = ctx.currentTime;
        const rate = logScale(x, 0.1, 3);
        lfo.frequency.setTargetAtTime(rate, t, SMOOTH);
        amount.gain.setTargetAtTime(lerp(y, 400, 2400), t, SMOOTH);
        return `${rate.toFixed(1)}Hz`;
      },
      dispose() {
        lfo.stop();
        input.disconnect();
        stages.forEach((s) => s.disconnect());
        lfo.disconnect();
        amount.disconnect();
        out.disconnect();
      },
    };
  },
};

/** BitCrush：古いゲーム機のような、ざらついた音（processors.js の cm-bitcrush） */
const bitCrush: LiveEffectKind = {
  id: "bitcrush",
  label: "BitCrush",
  xLabel: "細かさ",
  yLabel: "粗さ",
  create(ctx): LiveEffect {
    const node = workletNode(ctx, "cm-bitcrush");
    return {
      input: node,
      output: node,
      move({ x, y }) {
        // 左ほど荒い（同じ値を長く続ける）。上ほどビットが少ない（4ビットより少ないと、小さな音が丸めで消えてしまう）
        const hold = Math.round(Math.pow(40, 1 - x));
        const bits = Math.round(lerp(y, 12, 4));
        node.port.postMessage({ hold, bits });
        return `${bits}bit`;
      },
      dispose() {
        node.disconnect();
      },
    };
  },
};

/** ライブの画面に並べるエフェクト（2列×6段。並べた順に左上から） */
export const LIVE_EFFECTS: LiveEffectKind[] = [
  retrigger,
  gate,
  echo,
  wobble,
  sideChain,
  tapeStop,
  pitch,
  flanger,
  phaser,
  bitCrush,
  filterEffect("lpf", "LPF", "lowpass", 150, 12000),
  filterEffect("hpf", "HPF", "highpass", 30, 8000),
];
