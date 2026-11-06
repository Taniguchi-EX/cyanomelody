import { invoke } from "@tauri-apps/api/core";

/** エフェクト1つと、その設定（内部処理の Effect と同じ形） */
export type Effect =
  | { kind: "gain"; db: number }
  | { kind: "normalize"; method: "peak" | "rms"; targetDb: number }
  | { kind: "speedPitch"; speed: number; semitones: number }
  | { kind: "reverb"; seconds: number; mix: number }
  | { kind: "echo"; delay: number; feedback: number; mix: number }
  | { kind: "fadeIn"; seconds: number }
  | { kind: "fadeOut"; seconds: number }
  | { kind: "offVocal"; strength: number; lowHz: number; highHz: number };

export type EffectKind = Effect["kind"];

export type EffectChain = {
  id: number;
  name: string;
  /** 中のエフェクト（かける順） */
  effects: Effect[];
  /** 結び付けているプレイリストの項目の数 */
  itemCount: number;
};

/** 数で入れる設定の項目。割合（0〜1）は画面では % で見せる */
type NumberParam = { key: string; label: string; unit: string; min: number; max: number; step: number; percent?: boolean };

type EffectDef = {
  kind: EffectKind;
  label: string;
  /** エフェクトの名前にマウスを乗せたときの説明 */
  note?: string;
  params: NumberParam[];
  defaults: Effect;
};

/** エフェクトの種類と設定（範囲は docs の「エフェクトの種類と設定」） */
export const EFFECT_DEFS: EffectDef[] = [
  {
    kind: "gain",
    label: "音量調整",
    params: [{ key: "db", label: "増減", unit: "dB", min: -30, max: 12, step: 0.5 }],
    defaults: { kind: "gain", db: 0 },
  },
  {
    kind: "normalize",
    label: "ノーマライズ",
    params: [{ key: "targetDb", label: "目標", unit: "dBFS", min: -40, max: 0, step: 0.5 }],
    defaults: { kind: "normalize", method: "peak", targetDb: -1 },
  },
  {
    kind: "speedPitch",
    label: "再生速度・音程調整",
    params: [
      { key: "speed", label: "速度", unit: "倍", min: 0.5, max: 2, step: 0.05 },
      { key: "semitones", label: "音程", unit: "半音", min: -12, max: 12, step: 1 },
    ],
    defaults: { kind: "speedPitch", speed: 1, semitones: 0 },
  },
  {
    kind: "reverb",
    label: "リバーブ",
    params: [
      { key: "seconds", label: "残響の長さ", unit: "秒", min: 0.1, max: 5, step: 0.1 },
      { key: "mix", label: "混ぜる割合", unit: "%", min: 0, max: 1, step: 0.05, percent: true },
    ],
    defaults: { kind: "reverb", seconds: 1.5, mix: 0.3 },
  },
  {
    kind: "echo",
    label: "エコー",
    params: [
      { key: "delay", label: "遅れ", unit: "秒", min: 0.05, max: 2, step: 0.05 },
      { key: "feedback", label: "繰り返しの強さ", unit: "%", min: 0, max: 0.9, step: 0.05, percent: true },
      { key: "mix", label: "混ぜる割合", unit: "%", min: 0, max: 1, step: 0.05, percent: true },
    ],
    defaults: { kind: "echo", delay: 0.3, feedback: 0.4, mix: 0.3 },
  },
  {
    kind: "fadeIn",
    label: "フェードイン",
    params: [{ key: "seconds", label: "長さ", unit: "秒", min: 0, max: 600, step: 0.1 }],
    defaults: { kind: "fadeIn", seconds: 1 },
  },
  {
    kind: "fadeOut",
    label: "フェードアウト",
    params: [{ key: "seconds", label: "長さ", unit: "秒", min: 0, max: 600, step: 0.1 }],
    defaults: { kind: "fadeOut", seconds: 1 },
  },
  {
    kind: "offVocal",
    label: "簡易オフボーカル",
    note: "真ん中から聞こえる音のうち、下〜上の周波数の音（ボーカルの音域）を弱めます。モノラルの音にはかかりません",
    params: [
      { key: "strength", label: "消す強さ", unit: "%", min: 0, max: 1, step: 0.05, percent: true },
      { key: "lowHz", label: "下の周波数", unit: "Hz", min: 50, max: 500, step: 10 },
      { key: "highHz", label: "上の周波数", unit: "Hz", min: 2000, max: 16000, step: 100 },
    ],
    defaults: { kind: "offVocal", strength: 1, lowHz: 120, highHz: 9000 },
  },
];

export const effectDef = (kind: EffectKind) => EFFECT_DEFS.find((d) => d.kind === kind)!;

/** 数の設定の値（key は EFFECT_DEFS の params の key） */
export const paramValue = (e: Effect, key: string): number => (e as unknown as Record<string, number>)[key];

/** 一覧での短い表示（例：「リバーブ 1.5秒 30%」） */
export function describeEffect(e: Effect): string {
  const def = effectDef(e.kind);
  const values = def.params.map((p) => {
    const v = paramValue(e, p.key);
    return p.percent ? `${Math.round(v * 100)}%` : `${v}${p.unit}`;
  });
  if (e.kind === "normalize") values.unshift(e.method === "peak" ? "ピーク" : "平均");
  // 周波数は「120Hz〜9000Hz」のように範囲で出す
  if (e.kind === "offVocal") return `${def.label} ${values[0]} ${e.lowHz}Hz〜${e.highHz}Hz`;
  return [def.label, ...values].join(" ");
}

export const chainApi = {
  list: () => invoke<EffectChain[]>("list_effect_chains"),
  create: (name: string) => invoke<number>("create_effect_chain", { name }),
  rename: (id: number, name: string) => invoke<void>("rename_effect_chain", { id, name }),
  remove: (id: number) => invoke<void>("delete_effect_chain", { id }),
  setEffects: (id: number, effects: Effect[]) => invoke<void>("set_effect_chain_effects", { id, effects }),
  /** プレイリストの項目に結び付ける。null なら外す */
  setItemChain: (itemId: number, chainId: number | null) =>
    invoke<void>("set_playlist_item_chain", { itemId, chainId }),
  /** ファイルにエフェクトセットをかけた音を用意して、そのパスを返す */
  render: (fileId: number, chainIds: number[]) => invoke<string>("render_effects", { fileId, chainIds }),
  /** 保存する前のエフェクトの並びで、試聴用の音を用意する */
  preview: (fileId: number, effects: Effect[]) => invoke<string>("preview_effects", { fileId, effects }),
};
