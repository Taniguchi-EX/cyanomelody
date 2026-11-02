#!/usr/bin/env bash
# 画面テストをまとめて実行する。テストごとに空のデータでアプリ（リリースビルド）を起動し直す。
#   bash e2e/run.sh <テストデータ> <作業用フォルダ> [テストのスクリプト名...]
# 事前に make-testdata.sh でテストデータを作り、npx tauri build --no-bundle でビルドしておく。
# スクリーンショットと結果は <作業用フォルダ>/<スクリプト名>/ に保存する。
set -uo pipefail

data="${1:?テストデータのフォルダを指定してください}"
work="${2:?作業用フォルダを指定してください}"
shift 2
scripts=("$@")
[ ${#scripts[@]} -eq 0 ] && scripts=(tag-management.mjs tag-admin.mjs hash-features.mjs)

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
exe="$app_dir/src-tauri/target/release/cyanomelody.exe"
failed=0

for s in "${scripts[@]}"; do
  name="${s%.mjs}"
  rm -rf "$work/$name"
  mkdir -p "$work/$name/appdata"
  CYANOMELODY_DATA_DIR="$work/$name/appdata" \
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
    "$exe" &
  pid=$!
  for _ in $(seq 1 30); do
    curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && break
    sleep 1
  done
  echo "=== $s"
  node "$app_dir/e2e/$s" "$data" "$work/$name" || failed=1
  kill "$pid" 2>/dev/null
  taskkill //IM cyanomelody.exe //F >/dev/null 2>&1
  sleep 1
done
exit $failed
