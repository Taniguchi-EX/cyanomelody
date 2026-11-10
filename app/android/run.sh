#!/bin/bash
# ビルド環境のコンテナで、コマンドを動かす（Windows の Git Bash から）。
# node_modules・cargo の置き場所・Gradle の置き場所は、Windows 用と分けるため Docker のボリュームに置く。
# APK に署名するデバッグ用の鍵（/root/.android）も残す（ビルドのたびに変わると、端末の上で更新できない）
cd "$(dirname "$0")/../.."  # リポジトリの一番上
MSYS_NO_PATHCONV=1 docker run --rm -i \
  -v "$(pwd -W 2>/dev/null || pwd):/work" \
  -v cm-node-modules:/work/app/node_modules \
  -v cm-cargo-registry:/opt/cargo/registry \
  -v cm-cargo-target:/cache/target \
  -v cm-gradle:/root/.gradle \
  -v cm-android-keys:/root/.android \
  -e CARGO_TARGET_DIR=/cache/target \
  --network host \
  cyanomelody-android-build "$@"
