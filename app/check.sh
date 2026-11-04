#!/usr/bin/env bash
# テストを流す入口。変更に合わせて、流す範囲を選ぶ（どれを流すかは docs/01_現在の機能/00_全体/開発の手順.md の対応表を参照）。
#   bash check.sh quick             単体テスト・型チェック・lint。実装の途中はこれを流す
#   bash check.sh e2e <名前...>     画面テストのうち、指定したものだけ（例：bash check.sh e2e tags playlists）
#   bash check.sh all               quick と、性能を除くすべての画面テスト。作業の最後（コミットの前）に流す
#   bash check.sh perf              性能の画面テスト（3万件）。一覧・スキャン・絞り込み・ハッシュ値・プレイリストの展開を変えたとき
# 画面テストはデバッグビルドで流す（リリースビルドより速く作れて、テストの時間はほとんど変わらない）。
# テストデータと結果は CYANOMELODY_TEST_DIR（省くと一時フォルダの cyanomelody-test）に置く。
# 普段使っているアプリ（リリースビルド）は止めない。
set -uo pipefail
cd "$(dirname "$0")"

mode="${1:-}"
[ $# -gt 0 ] && shift
test_dir="${CYANOMELODY_TEST_DIR:-${TEMP:-/tmp}/cyanomelody-test}"
failed=0
started=$(date +%s)

elapsed() { echo "（$(($(date +%s) - $1))秒）"; }

quick() {
  local t
  t=$(date +%s)
  echo "--- 単体テスト（cargo test）"
  (cd src-tauri && cargo test) >"$test_dir/cargo-test.log" 2>&1 || failed=1
  grep -E "^(error|warning)|-->|test result: .* [1-9][0-9]* passed|FAILED|panicked" "$test_dir/cargo-test.log"
  # 型チェックが読む、ライセンスの一覧（ビルドの前に作るもの）を作っておく
  node scripts/licenses.mjs >/dev/null || failed=1
  echo "--- 型チェック（tsc）"
  npx tsc -b >"$test_dir/tsc.log" 2>&1 || failed=1
  head -30 "$test_dir/tsc.log"
  echo "--- lint（oxlint）"
  npx oxlint src e2e >"$test_dir/oxlint.log" 2>&1 || failed=1
  grep -E "^\S+\.(tsx?|mjs):" "$test_dir/oxlint.log"
  echo "quick $(elapsed "$t")（ログ：$test_dir）"
}

e2e() {
  local t
  t=$(date +%s)
  echo "--- テストデータ"
  bash e2e/make-testdata.sh "$test_dir/testdata" >/dev/null 2>&1 || { echo "テストデータを作れませんでした（ffmpeg が必要）"; failed=1; return; }
  echo "--- デバッグビルド"
  if ! npx tauri build --debug --no-bundle >"$test_dir/build.log" 2>&1; then
    grep -E "^error|error\[" "$test_dir/build.log" | head -20
    echo "ビルドに失敗しました（$test_dir/build.log）"
    failed=1
    return
  fi
  echo "ビルド $(elapsed "$t")"
  t=$(date +%s)
  echo "--- 画面テスト"
  local scripts=()
  for name in "$@"; do scripts+=("${name%.mjs}.mjs"); done
  CYANOMELODY_EXE="$PWD/src-tauri/target/debug/cyanomelody.exe" \
    bash e2e/run.sh "$test_dir/testdata" "$test_dir/work" "${scripts[@]}" 2>&1 | grep -E "^(===|FAIL)|件成功|^OK .*（"
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
  echo "画面テスト $(elapsed "$t")（結果とスクリーンショット：$test_dir/work）"
}

mkdir -p "$test_dir"
case "$mode" in
  quick) quick ;;
  e2e)
    [ $# -gt 0 ] || { echo "画面テストの名前を指定してください（例：bash check.sh e2e tags）"; exit 2; }
    e2e "$@"
    ;;
  all)
    quick
    e2e
    ;;
  perf) e2e perf ;;
  *)
    sed -n '2,9p' "$0"
    exit 2
    ;;
esac
echo "合計 $(elapsed "$started")"
[ $failed -eq 0 ] && echo "すべて成功" || echo "失敗があります"
exit $failed
