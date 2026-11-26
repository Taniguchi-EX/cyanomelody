import { useEffect, useEffectEvent, useRef, useState } from "react";
import { stem } from "../paths";
import { PauseIcon, PlayIcon } from "../components/Icons";
import { useStoredNumber, useStoredString } from "../storage";
import type { AppController } from "../hooks/useAppController";
import { liveAudio, type PadPoint } from "./liveAudio";
import { LIVE_EFFECTS } from "./effects";
import { ONE_SHOTS, pressOneShot, type OneShot } from "./oneShots";
import { addTap, DEFAULT_BPM, tapBpm } from "./bpm";
import { bufferFor, loadSamples, MAX_RECORD_SECONDS, playSample, saveSample, type Sample } from "./samples";

/** 録る音（曲：ライブの出口の音、マイク：端末のマイク） */
type RecSource = "song" | "mic";

/**
 * ライブの画面（Android）：鳴らしている曲に、指の操作でその場でエフェクトをかけ、単発の音を重ねる。
 * 左半分：単発の音のボタン（2列×3段）と、左下の REC と BPM のボタン。右半分：エフェクトを選ぶボタンと XY パッド。
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

  const { showError } = c;
  /** REC モード（単発の音のボタンを押している間、録る）。画面を開くたびに切から */
  const [recMode, setRecMode] = useState(false);
  /** 録る音（アプリを閉じても覚えておく） */
  const [storedSource, setRecSource] = useStoredString("cyanomelody.liveRecSource");
  const recSource: RecSource = storedSource === "mic" ? "mic" : "song";
  /** マイクを開けたか（REC モードでマイクを選んでいる間だけ開く。開くまでは録れない） */
  const [micOpen, setMicOpen] = useState(false);
  // マイクを使えなければ、曲に戻す（useEffectEvent：描き直しのたびに、マイクを閉じて開き直さないように）
  const onMicDenied = useEffectEvent(() => {
    showError("マイクを使えません（端末の設定で、マイクの使用が許可されていません）");
    setRecSource("song");
  });
  useEffect(() => {
    if (!recMode || recSource !== "mic" || !ready) return;
    let alive = true;
    liveAudio
      .openMic()
      .then(() => alive && setMicOpen(true))
      .catch(() => alive && onMicDenied());
    return () => {
      alive = false;
      setMicOpen(false);
      liveAudio.closeMic();
    };
  }, [recMode, recSource, ready]);

  /** ボタンに録った音（ボタンの id → 録った音。開いたときに読み込む） */
  const [samples, setSamples] = useState<Map<string, Sample>>(new Map());
  useEffect(() => {
    loadSamples()
      .then(setSamples)
      .catch(c.showError);
  }, [c.showError]);
  const onRecorded = (id: string, sample: Sample) => {
    setSamples((prev) => new Map(prev).set(id, sample));
    saveSample(id, sample).catch(c.showError);
  };
  // 今の BPM に合わせた速さの音を、押す前に作っておく（押した瞬間に重い計算をしないように）。1つずつ、間を空けて作る
  useEffect(() => {
    const list = [...samples.values()];
    let i = 0;
    let timer = 0;
    const next = () => {
      if (i >= list.length) return;
      bufferFor(liveAudio.context(), list[i++], bpm);
      timer = window.setTimeout(next, 0);
    };
    timer = window.setTimeout(next, 0);
    return () => window.clearTimeout(timer);
  }, [samples, bpm]);
  const canRecord = ready && (recSource === "song" || micOpen);

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
              <OneShotPad
                key={s.id}
                shot={s}
                bpm={bpm}
                sample={samples.get(s.id)}
                rec={recMode ? { source: recSource, enabled: canRecord, onRecorded } : null}
              />
            ))}
          </div>
          {recMode && (
            <div className="m-live-rec-source" role="radiogroup" aria-label="録る音">
              {(
                [
                  ["song", "曲"],
                  ["mic", "マイク"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} role="radio" aria-checked={recSource === id} className={recSource === id ? "selected" : ""} onClick={() => setRecSource(id)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="m-live-bottom">
            <button
              className={"m-live-rec" + (recMode ? " on" : "")}
              aria-pressed={recMode}
              onClick={() => setRecMode((v) => !v)}
              aria-label="REC（単発の音のボタンに録る）"
              data-testid="m-live-rec"
            >
              <span className="m-live-rec-dot" />
              REC
            </button>
            <BpmButton bpm={bpm} onBpm={saveBpm} />
          </div>
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

/**
 * 単発の音のボタン：触れた瞬間に鳴らす（録った音があれば録った音を最後まで、なければその場で作る音。oneShots.ts・samples.ts）。
 * REC モード（rec がある）のときは、押している間だけ録る（最大 MAX_RECORD_SECONDS 秒）。
 * 指ごとに別々に扱う。指がボタンの外に出ても、離すまで続ける
 */
function OneShotPad({
  shot,
  bpm,
  sample,
  rec,
}: {
  shot: OneShot;
  bpm: number;
  sample: Sample | undefined;
  rec: { source: RecSource; enabled: boolean; onRecorded: (id: string, sample: Sample) => void } | null;
}) {
  /** 押している指ごとの、離したときに呼ぶ関数 */
  const holds = useRef(new Map<number, () => void>());
  /** 録っている間の、録り始めた時刻（performance.now）と、今の長さ（秒） */
  const [recording, setRecording] = useState<{ since: number; seconds: number } | null>(null);
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(
      () => setRecording((r) => r && { ...r, seconds: Math.min(MAX_RECORD_SECONDS, (performance.now() - r.since) / 1000) }),
      100,
    );
    return () => window.clearInterval(id);
  }, [recording?.since]); // eslint-disable-line react-hooks/exhaustive-deps
  const end = (e: React.PointerEvent) => {
    holds.current.get(e.pointerId)?.();
    holds.current.delete(e.pointerId);
  };
  // 画面を閉じたときは、押したままの音と録音を止める
  useEffect(() => {
    const map = holds.current;
    return () => {
      map.forEach((stop) => stop());
      map.clear();
    };
  }, []);
  const press = (pointerId: number) => {
    const ctx = liveAudio.context();
    void liveAudio.resume();
    holds.current.get(pointerId)?.();
    if (rec) {
      // REC モード：押している間だけ録る（鳴らさない）
      if (!rec.enabled) return;
      const take = liveAudio.record(rec.source, MAX_RECORD_SECONDS);
      const recBpm = bpm;
      setRecording({ since: performance.now(), seconds: 0 });
      holds.current.set(pointerId, take.stop);
      void take.result.then((channels) => {
        setRecording(null);
        // ごく短い（0.05秒未満）のは、触れてしまっただけとみなして、前の音を残す
        if (channels[0].length < ctx.sampleRate * 0.05) return;
        rec.onRecorded(shot.id, { bpm: recBpm, sampleRate: ctx.sampleRate, channels });
      });
      return;
    }
    if (sample) {
      playSample(ctx, liveAudio.oneShotOutput(), shot.id, bufferFor(ctx, sample, bpm));
      return;
    }
    holds.current.set(pointerId, pressOneShot(shot, ctx, liveAudio.oneShotOutput(), bpm));
  };
  return (
    <button
      className={"m-live-pad" + (rec ? " rec-mode" : "") + (recording ? " recording" : "")}
      // 指が触れた瞬間に鳴らす（click は離したときなので遅い）
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        flash(e.currentTarget);
        press(e.pointerId);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      // 長押しで端末のメニューが出ないように
      onContextMenu={(e) => e.preventDefault()}
      data-testid="m-live-pad"
    >
      <span>{shot.label}</span>
      {recording ? (
        <span className="m-live-pad-sub recording">● {recording.seconds.toFixed(1)}秒</span>
      ) : (
        sample && <span className="m-live-pad-sub">REC</span>
      )}
    </button>
  );
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
