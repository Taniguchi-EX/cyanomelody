#!/usr/bin/env bash
# 配布用のビルドを Docker で行う（Android のリリース版、Ubuntu のパッケージ）。
# 使い方: bash scripts/build-release.sh <android|linux>（app/ で実行する）
#   android: 署名した APK を out/cyanomelody-<版>-release.apk に出す。署名鍵は ../secrets/android_signing.sec.properties
#   linux:   .deb を out/ に出す
# Windows のインストーラは、開発 PC で `npx tauri build` を実行する（target/release/bundle/ に出る）。
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:?android か linux を指定してください}"
IMAGE="cyanomelody-android-env:latest"
APP="$(pwd -W 2>/dev/null || pwd)"
SECRETS="$(cd ../secrets && (pwd -W 2>/dev/null || pwd))"
VERSION="$(node -p "require('./package.json').version")"
mkdir -p out

case "$TARGET" in
  android)
    [ -f ../secrets/android_signing.sec.properties ] || { echo "署名鍵の設定 ../secrets/android_signing.sec.properties がない" >&2; exit 1; }
    BUILD='npx tauri android build --apk --target aarch64 > /out/build-android-release.log 2>&1 || { tail -30 /out/build-android-release.log; exit 1; }
apk=$(find src-tauri/gen/android/app/build/outputs/apk -name "*release*.apk" | head -1)
$ANDROID_HOME/build-tools/37.0.0/apksigner verify --print-certs "$apk" | grep -E "SHA-256|SHA-1"
cp "$apk" "/out/cyanomelody-'"$VERSION"'-release.apk"'
    ;;
  linux)
    BUILD='npx tauri build --bundles deb > /out/build-linux.log 2>&1 || { tail -30 /out/build-linux.log; exit 1; }
cp target/release/bundle/deb/*.deb /out/'
    ;;
  *)
    echo "android か linux を指定してください" >&2
    exit 1
    ;;
esac

START=$(date +%s)
# 作業用のコピーはボリュームに置く（Windows のフォルダを直接使うと遅い）。node_modules は Linux 用を入れる
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$APP:/src:ro" -v "$APP/out:/out" -v "$SECRETS:/secrets:ro" \
  -v "cm-release-build-$TARGET:/build/app" \
  -v cm-android-cargo:/usr/local/cargo/registry \
  -v cm-gradle:/root/.gradle \
  -v cm-android-home:/root/.android \
  -e CYANOMELODY_ANDROID_SIGNING=/secrets/android_signing.sec.properties \
  "$IMAGE" sh -c '
set -e
# build.rs が ../../secrets を読むため、/build/app と /build/secrets の位置関係にする
ln -sfn /secrets /build/secrets
cd /src && tar --exclude=./out --exclude=./target --exclude=./node_modules --exclude=./e2e/screenshots \
  --exclude=./src-tauri/gen/android/app/build --exclude=./src-tauri/gen/android/.gradle -cf - . | (cd /build/app && tar -xf -)
cd /build/app
npm install --no-audit --no-fund --silent
'"$BUILD"'
'
echo "所要時間: $(( $(date +%s) - START ))秒"
ls -l out/ | grep -E "\.apk|\.deb"
echo "RESULT: BUILD OK"
