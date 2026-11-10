#!/bin/bash
# Docker の中で、cyanomelody を Android 向けにビルドする（デバッグ版の APK）。/work にリポジトリを置いて動かす（run.sh から）
#   引数：ターゲット（aarch64・x86_64 など。既定は aarch64）
set -euo pipefail
target="${1:-aarch64}"
cd /work/app
npm ci --no-audit --no-fund
[ -d src-tauri/gen/android ] || npx tauri android init --ci
npx tauri android build --apk --debug --target "$target" --ci
find src-tauri/gen/android/app/build/outputs/apk -name "*.apk" -exec ls -la {} \;
