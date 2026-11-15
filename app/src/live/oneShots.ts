/**
 * 単発の音（仮）：その場で作る短い音。段階3で中身を決め直す。
 * 曲の音には重ねるが、エフェクトは通さない（liveAudio の oneShotOutput へ鳴らす）
 */

export type OneShot = {
  id: string;
  /** ボタンに出す名前 */
  label: string;
  /** when（AudioContext の時刻）に、out へ鳴らす */
  play(ctx: AudioContext, out: AudioNode, when: number): void;
};

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

/** 音程が下がっていく音（キック・タム） */
function drop(ctx: AudioContext, out: AudioNode, when: number, from: number, to: number, peak: number, length: number) {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(from, when);
  o.frequency.exponentialRampToValueAtTime(to, when + length * 0.8);
  o.connect(envelope(ctx, out, when, peak, length));
  o.start(when);
  o.stop(when + length);
}

/** ライブの画面に並べる単発の音（2列×3段。並べた順に左上から） */
export const ONE_SHOTS: OneShot[] = [
  { id: "kick", label: "キック", play: (ctx, out, t) => drop(ctx, out, t, 150, 45, 1, 0.45) },
  { id: "snare", label: "スネア", play: (ctx, out, t) => (noiseHit(ctx, out, t, "highpass", 1200, 0.7, 0.2), drop(ctx, out, t, 220, 160, 0.4, 0.12)) },
  { id: "clap", label: "クラップ", play: (ctx, out, t) => [0, 0.012, 0.024].forEach((d) => noiseHit(ctx, out, t + d, "bandpass", 1500, 0.8, 0.12)) },
  { id: "hat", label: "ハイハット", play: (ctx, out, t) => noiseHit(ctx, out, t, "highpass", 7000, 0.5, 0.06) },
  { id: "tom", label: "タム", play: (ctx, out, t) => drop(ctx, out, t, 260, 110, 0.8, 0.35) },
  { id: "crash", label: "クラッシュ", play: (ctx, out, t) => noiseHit(ctx, out, t, "highpass", 4000, 0.5, 1.2) },
];
