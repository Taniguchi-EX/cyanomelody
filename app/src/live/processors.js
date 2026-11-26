// ライブの画面のエフェクトのうち、ブラウザの部品では作れないもの（AudioWorklet の処理）。
// liveAudio.ts の ready で読み込み、effects.ts の各エフェクトが AudioWorkletNode で使う。
// 設定は port のメッセージで受け取る（{ type: "start" | "set" | "stop", ... }）。
// 入力が1チャンネル（モノラル）のときは、同じ音を両方のチャンネルに出す。
/* global sampleRate, registerProcessor, AudioWorkletProcessor */

/** 入力のチャンネル c（なければ最初のチャンネル。何もなければ null） */
function channel(input, c) {
  if (!input || input.length === 0) return null;
  return input[Math.min(c, input.length - 1)];
}

/**
 * Retrigger：指を置いた瞬間からの音を覚えて、決まった長さで繰り返す。
 * 1周目は、そのまま聞こえている音（覚えながら流す）。2周目からは、覚えた音を繰り返す。
 * 長さを変えても、繰り返しの始まり（指を置いた瞬間）は変えない。
 * つなぎ目で「プツッ」と鳴らないよう、区切りの頭と終わりを少しだけ小さくする
 */
class RetriggerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = Math.floor(sampleRate * 4);
    this.buf = [new Float32Array(this.cap), new Float32Array(this.cap)];
    this.active = false;
    this.i = 0;
    this.length = Math.floor(sampleRate / 4);
    this.mix = 1;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.length !== undefined) this.length = Math.max(64, Math.min(this.cap, Math.floor(m.length * sampleRate)));
      if (m.mix !== undefined) this.mix = m.mix;
      if (m.type === "start") {
        this.active = true;
        this.i = 0;
      } else if (m.type === "stop") {
        this.active = false;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    const L = this.length;
    const F = Math.min(128, Math.floor(L / 4));
    for (let c = 0; c < output.length; c++) {
      const src = channel(input, c);
      const out = output[c];
      const buf = this.buf[Math.min(c, 1)];
      let i = this.i;
      for (let s = 0; s < n; s++, i++) {
        const live = src ? src[s] : 0;
        if (!this.active) {
          out[s] = live;
          continue;
        }
        if (i < this.cap) buf[i] = live;
        const k = i % L;
        let loop;
        if (i < L) {
          loop = live * Math.min(1, (L - k) / F);
        } else {
          loop = buf[k] * Math.min(1, k / F, (L - k) / F);
        }
        out[s] = this.mix * loop + (1 - this.mix) * live;
      }
    }
    if (this.active) this.i += n;
    return true;
  }
}

/**
 * TapeStop：指を置いた瞬間からの音を覚えて、だんだん遅く読む（テープを止めたように、低く遅くなって止まる）。
 * 読む速さは、1 から 0 まで、決まった時間（秒）でまっすぐ下げる
 */
class TapeStopProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = Math.floor(sampleRate * 4);
    this.buf = [new Float32Array(this.cap), new Float32Array(this.cap)];
    this.active = false;
    this.i = 0;
    this.pos = 0;
    this.rate = 1;
    this.seconds = 1;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.seconds !== undefined) this.seconds = Math.max(0.05, m.seconds);
      if (m.type === "start") {
        this.active = true;
        this.i = 0;
        this.pos = 0;
        this.rate = 1;
      } else if (m.type === "stop") {
        this.active = false;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    if (!this.active) {
      for (let c = 0; c < output.length; c++) {
        const src = channel(input, c);
        if (src) output[c].set(src);
      }
      return true;
    }
    const step = 1 / (this.seconds * sampleRate);
    let i = this.i;
    let pos = this.pos;
    let rate = this.rate;
    for (let s = 0; s < n; s++, i++) {
      for (let c = 0; c < output.length; c++) {
        const src = channel(input, c);
        const buf = this.buf[Math.min(c, 1)];
        if (i < this.cap) buf[i] = src ? src[s] : 0;
        const p = Math.min(pos, this.cap - 2);
        const j = Math.floor(p);
        const f = p - j;
        // 止まる直前は、音量も少しずつ下げる（止まった瞬間に「プツッ」と鳴らないように）
        const fade = Math.min(1, rate * 20);
        output[c][s] = (buf[j] * (1 - f) + buf[j + 1] * f) * fade;
      }
      pos += rate;
      rate = Math.max(0, rate - step);
    }
    this.i = i;
    this.pos = pos;
    this.rate = rate;
    return true;
  }
}

/**
 * Pitch：速さを変えずに、音の高さだけを変える（遅れの長さを動かして読む方法。2つの読み口を、窓をかけて交互に使う）。
 * 高さは比（2 で1オクターブ上）。mix は元の音と混ぜる割合（1 で変えた音だけ）
 */
class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 8192;
    this.window = 2048;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0;
    this.phase = 0;
    this.ratio = 1;
    this.mix = 1;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.ratio !== undefined) this.ratio = m.ratio;
      if (m.mix !== undefined) this.mix = m.mix;
    };
  }

  read(buf, delay) {
    const p = this.w - delay;
    const j = Math.floor(p);
    const f = p - j;
    const a = buf[(j + this.size) % this.size];
    const b = buf[(j + 1 + this.size) % this.size];
    return a * (1 - f) + b * f;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    const W = this.window;
    const step = (1 - this.ratio) / W;
    let phase = this.phase;
    for (let s = 0; s < n; s++) {
      const p2 = (phase + 0.5) % 1;
      // sin² の窓。2つの読み口の窓の和は、いつも 1
      const g1 = Math.sin(Math.PI * phase) ** 2;
      const g2 = Math.sin(Math.PI * p2) ** 2;
      for (let c = 0; c < output.length; c++) {
        const src = channel(input, c);
        const buf = this.buf[Math.min(c, 1)];
        const live = src ? src[s] : 0;
        buf[this.w % this.size] = live;
        const shifted = this.read(buf, phase * W + 1) * g1 + this.read(buf, p2 * W + 1) * g2;
        output[c][s] = this.mix * shifted + (1 - this.mix) * live;
      }
      this.w = (this.w + 1) % (this.size * 1024);
      phase += step;
      phase -= Math.floor(phase);
    }
    this.phase = phase;
    return true;
  }
}

/**
 * BitCrush：音を粗くする。hold 個の点ごとに同じ値を続け（細かさを落とす）、bits ビットの段に丸める（粗さ）
 */
class BitCrushProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hold = 1;
    this.bits = 16;
    this.count = 0;
    this.held = [0, 0];
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.hold !== undefined) this.hold = Math.max(1, Math.round(m.hold));
      if (m.bits !== undefined) this.bits = Math.max(1, m.bits);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    const levels = Math.pow(2, this.bits - 1);
    for (let s = 0; s < n; s++) {
      if (this.count === 0) {
        for (let c = 0; c < output.length; c++) {
          const src = channel(input, c);
          const v = src ? src[s] : 0;
          this.held[Math.min(c, 1)] = Math.round(v * levels) / levels;
        }
      }
      for (let c = 0; c < output.length; c++) output[c][s] = this.held[Math.min(c, 1)];
      this.count = (this.count + 1) % this.hold;
    }
    return true;
  }
}

/**
 * 録音：作られた瞬間から、入ってきた音を覚える（2チャンネル）。{ type: "stop" } を受け取るか、
 * 最大の長さ（processorOptions.max 秒）に達したら止め、覚えた音を { type: "done", channels } で返す。出口は無音
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.max = Math.floor(sampleRate * (options?.processorOptions?.max ?? 8));
    this.buf = [new Float32Array(this.max), new Float32Array(this.max)];
    this.n = 0;
    this.done = false;
    this.port.onmessage = (e) => {
      if (e.data?.type === "stop") this.finish();
    };
  }

  finish() {
    if (this.done) return;
    this.done = true;
    const channels = this.buf.map((b) => b.slice(0, this.n));
    this.port.postMessage({ type: "done", channels }, channels.map((c) => c.buffer));
  }

  process(inputs) {
    if (this.done) return false;
    const input = inputs[0];
    const len = input && input.length > 0 ? input[0].length : 128;
    const take = Math.min(len, this.max - this.n);
    for (let c = 0; c < 2; c++) {
      const src = channel(input, c);
      if (src) this.buf[c].set(src.subarray(0, take), this.n);
    }
    this.n += take;
    if (this.n >= this.max) this.finish();
    return !this.done;
  }
}

registerProcessor("cm-recorder", RecorderProcessor);
registerProcessor("cm-retrigger", RetriggerProcessor);
registerProcessor("cm-tapestop", TapeStopProcessor);
registerProcessor("cm-pitch", PitchProcessor);
registerProcessor("cm-bitcrush", BitCrushProcessor);
