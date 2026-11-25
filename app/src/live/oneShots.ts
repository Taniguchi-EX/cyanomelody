/**
 * 単発の音（6個。docs の 01-02_単発の音.md）：音のファイルを使わず、その場で作る短い音。
 * 押した瞬間に1回鳴らし、押したままにすると BPM に合わせて連打する（押した瞬間を拍の頭とみなす）。
 * 曲の音には重ねるが、エフェクトは通さない（liveAudio の oneShotOutput へ鳴らす）
 */
import { BeatClock } from "./beatClock";

export type OneShot = {
  id: string;
  /** ボタンに出す名前 */
  label: string;
  /** 押したままにしたときの連打の間隔（拍。四分音符が1）。なければ連打しない */
  roll?: number;
  /** when（AudioContext の時刻）に、out へ1回鳴らす */
  play?(ctx: AudioContext, out: AudioNode, when: number): void;
  /** 押している間だけ鳴らす音（Riser）。when から鳴らし始め、離したときに呼ぶ関数を返す */
  hold?(ctx: AudioContext, out: AudioNode, when: number, bpm: number): () => void;
};

/** 拍の数を秒にする */
const seconds = (beats: number, bpm: number) => (beats * 60) / bpm;

/** 白い雑音（使い回す。1秒分） */
let noiseBuffer: AudioBuffer | null = null;
function noise(ctx: AudioContext): AudioBuffer {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

/** 音量の形（すぐ立ち上がり、length 秒で消える） */
function envelope(ctx: AudioContext, out: AudioNode, when: number, peak: number, length: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, when);
  g.gain.exponentialRampToValueAtTime(0.001, when + length);
  g.connect(out);
  return g;
}

/** 雑音をフィルターに通して鳴らす */
function noiseHit(ctx: AudioContext, out: AudioNode, when: number, type: BiquadFilterType, freq: number, peak: number, length: number) {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  src.connect(f);
  f.connect(envelope(ctx, out, when, peak, length));
  src.start(when);
  src.stop(when + length);
}

/** 音程が下がっていく音（キック・Impact の低音） */
function drop(ctx: AudioContext, out: AudioNode, when: number, from: number, to: number, peak: number, length: number) {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(from, when);
  o.frequency.exponentialRampToValueAtTime(to, when + length * 0.8);
  o.connect(envelope(ctx, out, when, peak, length));
  o.start(when);
  o.stop(when + length);
}

/**
 * Riser：雑音と、のこぎり波の音を、1小節（4拍）かけて高く大きくする。上がりきったら、そのまま鳴らし続ける。
 * 離すと、すぐ（約0.05秒で）消す
 */
function riser(ctx: AudioContext, out: AudioNode, when: number, bpm: number): () => void {
  const length = seconds(4, bpm);
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 1.5;
  band.frequency.setValueAtTime(400, when);
  band.frequency.exponentialRampToValueAtTime(9000, when + length);
  const saw = ctx.createOscillator();
  saw.type = "sawtooth";
  saw.frequency.setValueAtTime(110, when);
  saw.frequency.exponentialRampToValueAtTime(880, when + length);
  const sawGain = ctx.createGain();
  sawGain.gain.value = 0.12;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.02, when);
  g.gain.exponentialRampToValueAtTime(0.6, when + length);
  src.connect(band).connect(g);
  saw.connect(sawGain).connect(g);
  g.connect(out);
  src.start(when);
  saw.start(when);
  return () => {
    const t = ctx.currentTime;
    // 上がっている途中の値のまま止めてから、消す（cancelScheduledValues だけだと、値が最初に戻ることがある）
    g.gain.cancelAndHoldAtTime(t);
    g.gain.setTargetAtTime(0, t, 0.015);
    src.stop(t + 0.1);
    saw.stop(t + 0.1);
    window.setTimeout(() => g.disconnect(), 300);
  };
}

/** ライブの画面に並べる単発の音（2列×3段。並べた順に左上から） */
export const ONE_SHOTS: OneShot[] = [
  {
    id: "kick",
    label: "Kick",
    roll: 1,
    play: (ctx, out, t) => (drop(ctx, out, t, 160, 45, 0.9, 0.5), noiseHit(ctx, out, t, "highpass", 4000, 0.25, 0.015)),
  },
  {
    id: "snare",
    label: "Snare",
    roll: 1 / 4,
    play: (ctx, out, t) => (noiseHit(ctx, out, t, "highpass", 1200, 0.6, 0.2), drop(ctx, out, t, 220, 160, 0.35, 0.12)),
  },
  {
    id: "clap",
    label: "Clap",
    roll: 1 / 2,
    play: (ctx, out, t) => [0, 0.012, 0.024].forEach((d) => noiseHit(ctx, out, t + d, "bandpass", 1500, 1.8, 0.12)),
  },
  { id: "hat", label: "Hat", roll: 1 / 4, play: (ctx, out, t) => noiseHit(ctx, out, t, "highpass", 7000, 0.6, 0.06) },
  { id: "riser", label: "Riser", hold: riser },
  {
    id: "impact",
    label: "Impact",
    play: (ctx, out, t) => {
      drop(ctx, out, t, 90, 30, 0.6, 1.5);
      noiseHit(ctx, out, t, "lowpass", 300, 0.35, 0.4);
      noiseHit(ctx, out, t, "highpass", 2500, 0.3, 1.8);
    },
  },
];

/**
 * ボタンを押した：音を鳴らし始める。離したときに呼ぶ関数を返す。
 * 連打は、拍に合わせて少し先まで予定を組むので、離したときに、まだ鳴り始めていない分を取り消す
 * （短く押したときに、2回目が鳴らないように）
 */
export function pressOneShot(shot: OneShot, ctx: AudioContext, out: AudioNode, bpm: number): () => void {
  const now = ctx.currentTime;
  if (shot.hold) return shot.hold(ctx, out, now, bpm);
  if (!shot.play) return () => {};
  if (!shot.roll) {
    shot.play(ctx, out, now);
    return () => {};
  }
  const play = shot.play;
  /** 予定を組んだ音（鳴り始めの時刻と、その音だけの出口） */
  let hits: { time: number; gain: GainNode }[] = [];
  const clock = new BeatClock(ctx, (time) => {
    const gain = ctx.createGain();
    gain.connect(out);
    play(ctx, gain, time);
    // 鳴り始めてから時間がたったものは、もう取り消さないので覚えておかない
    hits = hits.filter((h) => h.time > ctx.currentTime);
    hits.push({ time, gain });
  });
  clock.start(seconds(shot.roll, bpm));
  return () => {
    clock.stop();
    const t = ctx.currentTime;
    for (const h of hits) if (h.time > t) h.gain.disconnect();
    hits = [];
  };
}
