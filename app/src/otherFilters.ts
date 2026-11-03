/** 「その他」の項目。key は FileFilter の条件、count は Facets の件数 */
export const OTHER_ITEMS = [
  { key: "duplicatesOnly", count: "duplicates", icon: "⧉", label: "重複しているファイル", chip: "重複" },
  { key: "recentOnly", count: "recent", icon: "🕘", label: "直近で再生したもの", chip: "直近で再生" },
  { key: "missingOnly", count: "missing", icon: "⚠", label: "リンク切れしているもの", chip: "リンク切れ" },
] as const;

export type OtherKey = (typeof OTHER_ITEMS)[number]["key"];
