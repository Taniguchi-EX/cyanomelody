/** データのエクスポート・インポート（と Windows からのコピー）で一緒に運ぶ、画面の設定（localStorage の key） */
const SCREEN_KEYS = [
  "cyanomelody.volume",
  "cyanomelody.playerMode",
  "cyanomelody.fileSort",
  "cyanomelody.fileSort.playlist",
  "cyanomelody.listView",
  "cyanomelody.display",
  "cyanomelody.width.side",
  "cyanomelody.width.detail",
];

/** Windows の画面だけで使う設定（Android へは写さない）：左右の欄の幅 */
const DESKTOP_ONLY_KEYS = ["cyanomelody.width.side", "cyanomelody.width.detail"];

const DISPLAY_KEY = "cyanomelody.display";

/** 画面の設定を読む（読めない値は入れない） */
export function readScreen(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SCREEN_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) out[key] = JSON.parse(raw);
    } catch {
      // 読めない値は書き出さない
    }
  }
  return out;
}

/** 今の表示の設定のフォント（Android で写すとき、端末の今のフォントを残すため） */
function currentFont(): unknown {
  try {
    const raw = localStorage.getItem(DISPLAY_KEY);
    return raw ? (JSON.parse(raw) as { font?: unknown }).font : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取り込んだ画面の設定を保存する（次にアプリを起動したときに反映する）。
 * forAndroid なら、Windows だけの設定（左右の欄の幅）は写さず、表示の設定のフォントは今のまま残す（Android ではフォントを選べない）
 */
export function writeScreen(screen: Record<string, unknown>, forAndroid = false) {
  for (const key of SCREEN_KEYS) {
    if (!(key in screen) || (forAndroid && DESKTOP_ONLY_KEYS.includes(key))) continue;
    let value = screen[key];
    if (forAndroid && key === DISPLAY_KEY && value && typeof value === "object") {
      const font = currentFont();
      const { font: _ignored, ...rest } = value as Record<string, unknown>;
      value = font === undefined ? rest : { ...rest, font };
    }
    localStorage.setItem(key, JSON.stringify(value));
  }
}

/** バイト数を「12.3 MB」などにする */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
