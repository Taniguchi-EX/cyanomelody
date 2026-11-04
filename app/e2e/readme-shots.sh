#!/usr/bin/env bash
# README に載せるスクリーンショットを撮り直す（テストではない）。ffmpeg が必要。
#   bash e2e/readme-shots.sh
# 見本の効果音を作ってリリースビルドのアプリで操作し、画像をリポジトリの assets/readme/ に置く。
# 普段使っているアプリは止めない（画面テストと同じく、別の名前・別のデータで動かす）。
set -euo pipefail
cd "$(dirname "$0")/.."

work="${TEMP:-/tmp}/cyanomelody-readme"
# 見本のデータは、画面（右の欄のパス）に出るので、ユーザー名を含まない短い場所に置く（READMESHOT_DATA で変えられる）
data="${READMESHOT_DATA:-E:/tmp/見本}"
rm -rf "$work" "$data"
mkdir -p "$data/効果音/環境音" "$data/効果音/足音" "$data/効果音/戦闘"
ff() { ffmpeg -v error -y "$@"; }
# 名前だけの見本なので、中身は短い音（周波数を変えたもの）
make() { ff -f lavfi -i "sine=frequency=$2:duration=$3" -metadata title="$(basename "${1%.*}")" "$data/効果音/$1"; }
make "環境音/雨_小降り.mp3" 300 4
make "環境音/雨_土砂降り.mp3" 320 5
make "環境音/風_そよ風.ogg" 200 6
make "環境音/森の朝.flac" 440 8
make "足音/足音_砂利.wav" 600 2
make "足音/足音_木の床.wav" 650 2
make "戦闘/爆発_小.wav" 120 2
make "戦闘/爆発_大.wav" 100 3
make "戦闘/剣_振る.mp3" 900 1

bash e2e/run.sh "$data" "$work/shots" readme-shots.mjs
mkdir -p ../assets/readme
cp "$work/shots/readme-shots/"{library,playlist,effects}.png ../assets/readme/
echo "assets/readme/ に置きました"
