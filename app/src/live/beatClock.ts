/**
 * 拍に合わせて、音の動きを先に予定しておく仕組み（エフェクトの Gate・SideChain で使う）。
 * 画面の描き直しやタイマーの遅れに影響されないよう、少し先（LOOKAHEAD 秒）までの拍の時刻を
 * AudioContext の時刻で決め、onBeat に渡す。最初の拍は start を呼んだ瞬間
 */
export class BeatClock {
  private static readonly LOOKAHEAD = 0.15;
  private timer: number | null = null;
  private next = 0;
  private period = 0.5;
  private ctx: AudioContext;
  private onBeat: (time: number, period: number) => void;
  constructor(ctx: AudioContext, onBeat: (time: number, period: number) => void) {
    this.ctx = ctx;
    this.onBeat = onBeat;
  }
  start(period: number) {
    this.stop();
    this.period = period;
    this.next = this.ctx.currentTime;
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 25);
  }
  /** 間隔を変える（次の拍から） */
  setPeriod(period: number) {
    this.period = period;
  }
  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
  private tick() {
    const until = this.ctx.currentTime + BeatClock.LOOKAHEAD;
    while (this.next < until) {
      this.onBeat(this.next, this.period);
      this.next += this.period;
    }
  }
}
