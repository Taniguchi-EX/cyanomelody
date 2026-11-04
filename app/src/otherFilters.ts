/** 「その他」の項目。key は FileFilter の条件、count は Facets の件数 */
export const OTHER_ITEMS = [
  { key: "duplicatesOnly", count: "duplicates", icon: "⧉", label: "重複しているファイル", chip: "重複" },
  { key: "recentOnly", count: "recent", icon: "🕘", label: "直近で再生したもの", chip: "直近で再生" },
  { key: "missingOnly", count: "missing", icon: "⚠", label: "リンク切れしているもの", chip: "リンク切れ" },
] as const;

export type OtherKey = (typeof OTHER_ITEMS)[number]["key"];

/** 長さの条件（以上・以下）。key は FileFilter の条件 */
export const DURATION_LIMITS = [
  { key: "minDuration", label: "以上" },
  { key: "maxDuration", label: "以下" },
] as const;

export type DurationKey = (typeof DURATION_LIMITS)[number]["key"];

/** 秒を「1:30」「1:00:00」の形にする */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
