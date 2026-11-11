#!/bin/bash
# Docker の中で、cyanomelody を Android 向けにビルドする。/work にリポジトリを置いて動かす（run.sh から）
#   引数1：ターゲット（aarch64・x86_64 など。既定は aarch64）
#   引数2：release ならリリース版（公開用の鍵で署名する。鍵は run.sh の CYANOMELODY_RELEASE=1 で /keys に渡す）。省くとデバッグ版
set -euo pipefail
target="${1:-aarch64}"
mode="${2:-debug}"
cd /work/app
npm ci --no-audit --no-fund
[ -d src-tauri/gen/android ] || npx tauri android init --ci
if [ "$mode" = release ]; then
  # 鍵とパスワードは、リポジトリの外のファイル（/keys）から読む。画面には出さない
  export CYANOMELODY_ANDROID_KEYSTORE=/keys/cyanomelody-android-release.sec.jks
  CYANOMELODY_ANDROID_KEYSTORE_PASSWORD="$(sed -n 's/^password=//p' /keys/cyanomelody-android-release.sec.txt)"
  export CYANOMELODY_ANDROID_KEYSTORE_PASSWORD
  npx tauri android build --apk --target "$target" --ci
else
  npx tauri android build --apk --debug --target "$target" --ci
fi
find src-tauri/gen/android/app/build/outputs/apk -name "*.apk" -exec ls -la {} \;
