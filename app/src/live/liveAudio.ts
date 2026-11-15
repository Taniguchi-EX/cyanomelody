/**
 * ライブの画面（リアルタイムエフェクト）の音声処理の土台（Android）。
 *
 * 曲の audio 要素の音 → 入口 →（素通し｜エフェクト）→ 出口 → スピーカー
 * 単発の音 → 単発の音の出口 → スピーカー（エフェクトは通さない）
 *
 * 曲の音を AudioContext に通すのは、ライブの画面を初めて開いたとき（attach）。createMediaElementSource は取り消せないので、
 * 一度通したら、アプリを閉じるまで通したまま（ライブの画面を開かなければ、普段の再生には手を入れない）。
 * audio 要素は、CORS で読んでいる（crossOrigin。platform.ts の mediaSrc）。そうでないと、通した音が無音にされる
 */

/** エフェクトを切り替えるときに、音を滑らかにつなぐ時間（秒）。急に切り替えると「プツッ」と鳴る */
const FADE = 0.01;

/** XY パッドの位置（0〜1。x は左が 0、y は下が 0）と、今の BPM */
export type PadPoint = { x: number; y: number };

/** ライブのエフェクト1つ。入口と出口の間で音を変える */
export interface LiveEffect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** 指の位置が変わったとき（指を置いた瞬間も） */
  move(point: PadPoint, bpm: number): void;
  /** 指を置いたとき（繰り返しの始まりなどを決める）。move の前に呼ぶ */
  start?(point: PadPoint, bpm: number): void;
  /** 指を離したとき（素通しに戻した後） */
  stop?(): void;
  dispose(): void;
}

/** ライブのエフェクトの種類（選ぶボタンに出す名前と、作り方） */
export type LiveEffectKind = {
  id: string;
  /** ボタンに出す名前 */
  label: string;
  /** XY パッドの横と縦で何が変わるか（パッドの隅に小さく出す） */
  xLabel: string;
  yLabel: string;
  create(ctx: AudioContext): LiveEffect;
};

class LiveAudio {
  private ctx: AudioContext | null = null;
  private attached: HTMLAudioElement | null = null;
  private input: GainNode | null = null;
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  private output: GainNode | null = null;
  private oneShots: GainNode | null = null;
  /** 選んでいるエフェクト（指を置いていなくても、作っておく） */
  private effect: { kind: LiveEffectKind; node: LiveEffect } | null = null;
  /** 指を置いて、エフェクトをかけているか */
  private engaged = false;
  /** 最後の指の位置と BPM（指を置いたままエフェクトを切り替えたとき、新しいエフェクトに渡す） */
  private last: { point: PadPoint; bpm: number } = { point: { x: 0.5, y: 0.5 }, bpm: 120 };

  /** AudioContext（なければ作る）。単発の音を作るのにも使う */
  context(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.dry = ctx.createGain();
      this.wet = ctx.createGain();
      this.wet.gain.value = 0;
      this.output = ctx.createGain();
      this.oneShots = ctx.createGain();
      this.input.connect(this.dry);
      this.dry.connect(this.output);
      this.wet.connect(this.output);
      this.output.connect(ctx.destination);
      this.oneShots.connect(ctx.destination);
    }
    return this.ctx;
  }

  /** 曲の audio 要素の音を通す（2回目からは何もしない）。止まっていれば動かす */
  attach(audio: HTMLAudioElement) {
    const ctx = this.context();
    if (this.attached !== audio) {
      ctx.createMediaElementSource(audio).connect(this.input!);
      this.attached = audio;
    }
    void this.resume();
  }

  /** 端末の都合で止まっていたら動かす（指で触ったときに呼ぶ） */
  async resume() {
    if (this.ctx && this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
  }

  /** 選ぶエフェクトを変える。かけている最中なら、新しいエフェクトに切り替える */
  select(kind: LiveEffectKind | null) {
    if (this.effect?.kind.id === kind?.id) return;
    const ctx = this.context();
    const old = this.effect;
    this.effect = kind ? { kind, node: kind.create(ctx) } : null;
    if (this.effect) {
      this.input!.connect(this.effect.node.input);
      this.effect.node.output.connect(this.wet!);
      // 指を置いたまま切り替えたときは、新しいエフェクトを今の指の位置で始める
      if (this.engaged) {
        this.effect.node.start?.(this.last.point, this.last.bpm);
        this.effect.node.move(this.last.point, this.last.bpm);
      }
    }
    if (old) {
      // 切り替えのつなぎ目で音が切れないよう、少し待ってから外す
      window.setTimeout(() => {
        old.node.stop?.();
        try {
          this.input!.disconnect(old.node.input);
        } catch {
          /* もう外れている */
        }
        old.node.dispose();
      }, FADE * 3000);
    }
    if (this.engaged && !this.effect) this.release();
  }

  /** 指を置いた：選んでいるエフェクトをかける */
  press(point: PadPoint, bpm: number) {
    if (!this.effect) return;
    void this.resume();
    const t = this.context().currentTime;
    this.last = { point, bpm };
    this.effect.node.start?.(point, bpm);
    this.effect.node.move(point, bpm);
    this.dry!.gain.setTargetAtTime(0, t, FADE / 3);
    this.wet!.gain.setTargetAtTime(1, t, FADE / 3);
    this.engaged = true;
  }

  /** 指を動かした */
  move(point: PadPoint, bpm: number) {
    this.last = { point, bpm };
    if (this.engaged) this.effect?.node.move(point, bpm);
  }

  /** 指を離した：素通しに戻す */
  release() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.dry!.gain.setTargetAtTime(1, t, FADE / 3);
    this.wet!.gain.setTargetAtTime(0, t, FADE / 3);
    this.engaged = false;
    this.effect?.node.stop?.();
  }

  /**
   * 出口の音を測る（確かめ用。開発者ツールから window.__cmLiveAudio.probe() で使う）。
   * 返す関数は、そのときの音の大きさ（最大値）と、周波数ごとの大きさ（dB。低い方から）を返す
   */
  probe(): () => { peak: number; spectrum: number[] } {
    const ctx = this.context();
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    this.output!.connect(an);
    this.oneShots!.connect(an);
    return () => {
      const wave = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(wave);
      const freq = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(freq);
      return { peak: wave.reduce((m, v) => Math.max(m, Math.abs(v)), 0), spectrum: Array.from(freq) };
    };
  }

  /** 単発の音の出口（エフェクトを通さない） */
  oneShotOutput(): AudioNode {
    this.context();
    return this.oneShots!;
  }
}

/** アプリに1つだけの音声処理（ライブの画面を閉じても残す。曲の音は通したまま） */
export const liveAudio = new LiveAudio();
// 開発者ツールから確かめるための口（probe など）
(window as unknown as { __cmLiveAudio: LiveAudio }).__cmLiveAudio = liveAudio;
