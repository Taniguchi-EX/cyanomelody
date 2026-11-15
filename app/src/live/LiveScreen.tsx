import { useEffect, useRef, useState } from "react";
import { stem } from "../paths";
import { PauseIcon, PlayIcon } from "../components/Icons";
import { useStoredNumber, useStoredString } from "../storage";
import type { AppController } from "../hooks/useAppController";
import { liveAudio, type PadPoint } from "./liveAudio";
import { LIVE_EFFECTS } from "./effects";
import { ONE_SHOTS } from "./oneShots";
import { addTap, DEFAULT_BPM, tapBpm } from "./bpm";

/**
 * ライブの画面（Android）：鳴らしている曲に、指の操作でその場でエフェクトをかけ、単発の音を重ねる。
 * 左半分：単発の音のボタン（2列×3段）と、左下の BPM のボタン。右半分：エフェクトを選ぶボタンと XY パッド。
 * 全画面の再生の右上のボタンで開き、「←」と端末の戻る操作で閉じる
 */
export function LiveScreen({ c, onClose }: { c: AppController; onClose: () => void }) {
  const { audio, files, playback } = c;
  const player = audio.player;
  const entry = player?.queue[player.index];
  const playing = entry ?? audio.previewFile;
  const name = entry?.alias ?? (playing ? stem(playing.relPath) : "再生していません");
  const main = player
    ? { label: player.paused ? "再開" : "一時停止", paused: player.paused, onClick: audio.togglePause, disabled: player.preparing }
    : { label: "再生を始める", paused: true, onClick: playback.playOpen, disabled: !files.some((f) => !f.missing) };

  // 開いたら、曲の音を AudioContext に通す（一度通したら通したまま。liveAudio.ts）。
  // 曲の audio 要素は、Android の画面（MobileApp）に1つだけある
  useEffect(() => {
    const el = document.querySelector<HTMLAudioElement>("[data-testid=m-app] > audio");
    if (el) liveAudio.attach(el);
    return () => liveAudio.release();
  }, []);

  /** 測った BPM（アプリを閉じても覚えておく） */
  const [bpm, , , saveBpm] = useStoredNumber("cyanomelody.liveBpm", DEFAULT_BPM);
  /** 選んでいるエフェクト（アプリを閉じても覚えておく） */
  const [storedEffect, setStoredEffect] = useStoredString("cyanomelody.liveEffect");
  const effect = LIVE_EFFECTS.find((e) => e.id === storedEffect) ?? LIVE_EFFECTS[0];
  // AudioWorklet の処理を読み込んでから、エフェクトを作る（読み込むまでは、XY パッドを押せない）
  const [ready, setReady] = useState(false);
  useEffect(() => {
    liveAudio
      .ready()
      .then(() => setReady(true))
      .catch(c.showError);
  }, [c.showError]);
  useEffect(() => {
    if (ready) liveAudio.select(effect);
  }, [ready, effect]);

  return (
    <div className="m-live" data-testid="m-live">
      <div className="m-header">
        <button className="icon m-back" onClick={onClose} aria-label="戻る" title="戻る">
          ←
        </button>
        <h2 className="m-title m-live-title">{name}</h2>
        <button className="icon" onClick={main.onClick} disabled={main.disabled} aria-label={main.label} title={main.label}>
          {main.paused ? <PlayIcon size={18} /> : <PauseIcon size={18} />}
        </button>
      </div>
      <div className="m-live-body">
        <div className="m-live-left">
          <div className="m-live-pads">
            {ONE_SHOTS.map((s) => (
              <button
                key={s.id}
                className="m-live-pad"
                // 指が触れた瞬間に鳴らす（click は離したときなので遅い）
                onPointerDown={(e) => {
                  e.preventDefault();
                  flash(e.currentTarget);
                  const ctx = liveAudio.context();
                  void liveAudio.resume();
                  s.play(ctx, liveAudio.oneShotOutput(), ctx.currentTime);
                }}
                data-testid="m-live-pad"
              >
                {s.label}
              </button>
            ))}
          </div>
          <BpmButton bpm={bpm} onBpm={saveBpm} />
        </div>
        <div className="m-live-right">
          <div className="m-live-effects" role="radiogroup" aria-label="エフェクト">
            {LIVE_EFFECTS.map((e) => (
              <button
                key={e.id}
                role="radio"
                aria-checked={e.id === effect.id}
                className={"m-live-effect" + (e.id === effect.id ? " selected" : "")}
                onClick={() => setStoredEffect(e.id)}
              >
                {e.label}
              </button>
            ))}
          </div>
          <XyPad bpm={bpm} xLabel={effect.xLabel} yLabel={effect.yLabel} disabled={!ready} />
        </div>
      </div>
    </div>
  );
}

/**
 * 押したボタンを短く光らせる（CSS の .hit のアニメーション）。:active は、素早いタップだと光る前に指が離れて光らないので使わない。
 * 続けて押したときも最初から光らせ直す
 */
function flash(el: HTMLElement) {
  el.classList.remove("hit");
  void el.offsetWidth; // アニメーションを最初からやり直させる
  el.classList.add("hit");
}

/** BPM のボタン：曲に合わせて何回か押すと、間隔から BPM を出して覚える（bpm.ts） */
function BpmButton({ bpm, onBpm }: { bpm: number; onBpm: (bpm: number) => void }) {
  const taps = useRef<number[]>([]);
  /** 測っている途中の押した回数（0 なら測っていない） */
  const [count, setCount] = useState(0);
  return (
    <button
      className={"m-live-bpm" + (count > 0 ? " measuring" : "")}
      onPointerDown={(e) => {
        e.preventDefault();
        flash(e.currentTarget);
        taps.current = addTap(taps.current, e.timeStamp);
        const next = tapBpm(taps.current);
        if (next !== null) onBpm(next);
        setCount(taps.current.length);
      }}
      aria-label={`BPM ${Math.round(bpm)}（曲に合わせて押すと測る）`}
      data-testid="m-live-bpm"
    >
      <span className="m-live-bpm-value">BPM {Math.round(bpm)}</span>
      <span className="sub">{count > 0 && count < 4 ? `あと${4 - count}回` : "曲に合わせてタップ"}</span>
    </button>
  );
}

/** XY パッド：指を置いている間だけ、選んでいるエフェクトをかける。位置で効き方を変える */
function XyPad({ bpm, xLabel, yLabel, disabled }: { bpm: number; xLabel: string; yLabel: string; disabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  /** 指の位置（置いていなければ null）。最初に置いた指だけを追う */
  const [point, setPoint] = useState<PadPoint | null>(null);
  /** 指を置いている間に出す、今の値（「1/16」など） */
  const [value, setValue] = useState("");
  const pointerId = useRef<number | null>(null);
  const toPoint = (e: React.PointerEvent): PadPoint => {
    const r = ref.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp(1 - (e.clientY - r.top) / r.height) };
  };
  const end = (e: React.PointerEvent) => {
    if (e.pointerId !== pointerId.current) return;
    pointerId.current = null;
    setPoint(null);
    setValue("");
    liveAudio.release();
  };
  return (
    <div
      ref={ref}
      className={"m-live-xy" + (point ? " active" : "")}
      data-testid="m-live-xy"
      onPointerDown={(e) => {
        if (pointerId.current !== null || disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        pointerId.current = e.pointerId;
        const p = toPoint(e);
        setPoint(p);
        setValue(liveAudio.press(p, bpm));
      }}
      onPointerMove={(e) => {
        if (e.pointerId !== pointerId.current) return;
        const p = toPoint(e);
        setPoint(p);
        setValue(liveAudio.move(p, bpm));
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span className="m-live-xy-label x">← {xLabel} →</span>
      {yLabel && <span className="m-live-xy-label y">↑ {yLabel}</span>}
      {value && (
        <span className="m-live-xy-value" data-testid="m-live-xy-value">
          {value}
        </span>
      )}
      {point && <span className="m-live-xy-dot" style={{ left: `${point.x * 100}%`, top: `${(1 - point.y) * 100}%` }} />}
    </div>
  );
}
