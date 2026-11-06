#!/usr/bin/env bash
# 画面テストをまとめて実行する。テストごとに空のデータでアプリを起動し直す。
#   bash e2e/run.sh <テストデータ> <作業用フォルダ> [テストのスクリプト名...]
# 普段は app/check.sh から呼ぶ（テストデータの作成とビルドもそちらで行う）。
# スクリプト名を省くと、性能のテスト（perf.mjs）を除くすべてを実行する。
# スクリーンショットと結果は <作業用フォルダ>/<スクリプト名>/ に保存する。
# 普段使っているアプリ（cyanomelody.exe）は止めない。テストのアプリは、別の名前の実行ファイルにして、
# 別のデータ・別のWebView2の保存領域で動かし、終わったらそれだけを止める。
set -uo pipefail

data="${1:?テストデータのフォルダを指定してください}"
work="${2:?作業用フォルダを指定してください}"
shift 2
scripts=("$@")
[ ${#scripts[@]} -eq 0 ] && scripts=(tag-management.mjs tags.mjs hash-features.mjs credits.mjs bulk.mjs facets.mjs playlists.mjs effects.mjs export.mjs settings.mjs autotag.mjs)

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$work"
exe="$work/cyanomelody-e2e.exe"
# テストする実行ファイル。CYANOMELODY_EXE で変えられる（普段のアプリを開いたままビルドするときなど）
cp "${CYANOMELODY_EXE:-$app_dir/src-tauri/target/release/cyanomelody.exe}" "$exe"
failed=0

for s in "${scripts[@]}"; do
  name="${s%.mjs}"
  rm -rf "$work/$name"
  mkdir -p "$work/$name/appdata"
  CYANOMELODY_DATA_DIR="$work/$name/appdata" \
    WEBVIEW2_USER_DATA_FOLDER="$work/$name/webview" \
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
    "$exe" &
  # 画面（ページ）が開くまで待つ。保存領域を新しく作るので、起動に時間がかかることがある
  for _ in $(seq 1 60); do
    curl -s -m 2 http://127.0.0.1:9222/json/list 2>/dev/null | grep -q "\"page\"" && break
    sleep 1
  done
  echo "=== $s"
  node "$app_dir/e2e/$s" "$data" "$work/$name" || failed=1
  taskkill //IM cyanomelody-e2e.exe //F >/dev/null 2>&1
  sleep 1
done
exit $failed
