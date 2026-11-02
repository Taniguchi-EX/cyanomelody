#!/usr/bin/env bash
# 画面テスト用のデータを作る。ffmpegが必要。
#   bash e2e/make-testdata.sh <出力先フォルダ>
# 出力先に以下を作る。
#   formats/  … 5つの形式の音声（1秒のチャイム）。サブフォルダと日本語の名前を含む
#   large/    … 一覧の確認用に、中身がダミーの .wav を3万個
set -euo pipefail

out="${1:?出力先フォルダを指定してください}"
formats="$out/formats"
large="$out/large"

mkdir -p "$formats/サブフォルダ"
ff() { ffmpeg -v error -y "$@"; }
ff -f lavfi -i "sine=frequency=880:duration=1" -metadata title="チャイム" "$formats/chime.wav"
ff -i "$formats/chime.wav" -metadata title="チャイム" -c:a libmp3lame "$formats/chime.mp3"
ff -i "$formats/chime.wav" -metadata title="チャイム" "$formats/chime.flac"
ff -i "$formats/chime.wav" -metadata title="チャイム" -c:a libvorbis "$formats/chime.ogg"
ff -i "$formats/chime.wav" -metadata title="チャイム" -c:a aac "$formats/サブフォルダ/チャイム.m4a"

if [ ! -d "$large" ]; then
  for d in $(seq -w 0 99); do
    mkdir -p "$large/d$d"
    for i in $(seq -w 0 299); do
      printf x > "$large/d$d/se_${d}_${i}.wav"
    done
  done
fi
echo "作成しました: $out"
