/**
 * 単発の音のボタンに録った音（docs の 01-04_録音した音.md）：保存（IndexedDB）、速さだけを変える仕組み（WSOLA）、鳴らし方。
 * 録った音は、録ったときの BPM と一緒に、ボタンごとに1つ覚える。鳴らすときは、今の BPM との比で速さを変える（音の高さは変えない）
 */

/** 録った音1つ */
export type Sample = {
  /** 録ったときの BPM */
  bpm: number;
  sampleRate: number;
  /** 2チャンネルの音 */
  channels: Float32Array[];
};

/** 録れる長さの最大（秒） */
export const MAX_RECORD_SECONDS = 8;

const DB_NAME = "cyanomelody-live";
const STORE = "samples";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 保存してある録った音を、すべて読む（ボタンの id → 録った音） */
export async function loadSamples(): Promise<Map<string, Sample>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const map = new Map<string, Sample>();
    const req = db.transaction(STORE).objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        db.close();
        resolve(map);
        return;
      }
      map.set(String(cur.key), cur.value as Sample);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** 録った音を保存する（同じボタンの前の音は置き換わる） */
export async function saveSample(id: string, sample: Sample): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(sample, id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 速さだけを rate 倍にする（音の高さは変えない。WSOLA）。
 * 短い区切り（約40ミリ秒）を、窓をかけて半分ずつ重ねてつなぎ直す。元の音から読む位置は rate 倍の歩幅で進め、
 * 前の区切りの続きと形が一番似ている所を、少しずらして探す（つなぎ目で波がずれて「ブツブツ」鳴らないように）
 */
export function stretch(channels: Float32Array[], sampleRate: number, rate: number): Float32Array[] {
  const len = channels[0].length;
  if (Math.abs(rate - 1) < 0.001 || len === 0) return channels;
  const N = Math.max(256, Math.round(sampleRate * 0.04) & ~1);
  const hop = N / 2;
  const tol = Math.round(N / 8);
  const outLen = Math.max(1, Math.round(len / rate));
  const out = channels.map(() => new Float32Array(outLen + N));
  const win = new Float32Array(N);
  // 半分ずつ重ねたとき、和がいつも 1 になる窓（周期的なハン窓）
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const mono = (i: number) => (i >= 0 && i < len ? channels[0][i] + (channels[1]?.[i] ?? 0) : 0);
  let prev = 0;
  for (let o = 0; o < outLen; o += hop) {
    const nominal = Math.round((o * len) / outLen);
    let best = nominal;
    if (o > 0) {
      // 前の区切りの続き（prev + hop から N/2 の長さ）と、一番似ている位置を探す（計算を軽くするため、間引いて比べる）
      const target = prev + hop;
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const p = nominal + d;
        if (p < 0 || p >= len) continue;
        let score = 0;
        for (let k = 0; k < hop; k += 4) score += mono(target + k) * mono(p + k);
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
    }
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = out[c];
      for (let k = 0; k < N; k++) {
        const i = best + k;
        if (i >= len) break;
        // 最初の区切りの前半は、重ねる相手がいないので、窓をかけない（音の頭を小さくしない）
        dst[o + k] += src[i] * (o === 0 && k < hop ? 1 : win[k]);
      }
    }
    prev = best;
  }
  return out.map((d) => d.subarray(0, outLen));
}

/**
 * 録った音を、今の BPM に合わせた速さの AudioBuffer にする。作ったものは、録った音ごとに、最後に作った速さの分だけ覚えておく
 * （8秒の音は1つ数MBあるので、BPM を測り直すたびに増やさない）
 */
const cache = new WeakMap<Sample, { key: string; buffer: AudioBuffer }>();
export function bufferFor(ctx: AudioContext, sample: Sample, bpm: number): AudioBuffer {
  const key = (bpm / sample.bpm).toFixed(3);
  const hit = cache.get(sample);
  if (hit?.key === key) return hit.buffer;
  const chans = stretch(sample.channels, sample.sampleRate, bpm / sample.bpm);
  const buffer = ctx.createBuffer(chans.length, chans[0].length, sample.sampleRate);
  chans.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
  cache.set(sample, { key, buffer });
  return buffer;
}

/** ボタンごとの、今鳴らしている録った音（同じボタンを続けて押したら止める） */
const playing = new Map<string, { src: AudioBufferSourceNode; gain: GainNode }>();

/** 録った音を、頭から最後まで鳴らす。同じボタンの前の音は、ごく短く小さくして止める */
export function playSample(ctx: AudioContext, out: AudioNode, id: string, buffer: AudioBuffer) {
  const now = ctx.currentTime;
  stopSample(ctx, id);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  src.connect(gain).connect(out);
  src.start(now);
  const entry = { src, gain };
  playing.set(id, entry);
  src.onended = () => {
    gain.disconnect();
    if (playing.get(id) === entry) playing.delete(id);
  };
}

/** ボタンの録った音を止める（「プツッ」と鳴らないよう、5ミリ秒ほどで小さくしてから） */
export function stopSample(ctx: AudioContext, id: string) {
  const prev = playing.get(id);
  if (!prev) return;
  const now = ctx.currentTime;
  prev.gain.gain.setTargetAtTime(0, now, 0.002);
  prev.src.stop(now + 0.015);
  playing.delete(id);
}
