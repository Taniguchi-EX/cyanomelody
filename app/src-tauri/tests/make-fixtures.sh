#!/usr/bin/env bash
# audio_hash.rs の単体テストで使う音源を作る。ffmpegが必要。
#   bash tests/make-fixtures.sh   （app/src-tauri で実行）
# 形式ごとに以下の3つを作る。
#   base.* … 440Hzの0.3秒の音。タイトル「元」
#   retag.* … base を -c copy で作り直し、タイトルとコメントを変えたもの（音声は同じ）
#   other.* … 660Hzの音（音声が違う）
set -euo pipefail
cd "$(dirname "$0")/fixtures"
ff() { ffmpeg -v error -y "$@"; }
for spec in "mp3:-c:a libmp3lame" "wav:-c:a pcm_s16le" "flac:-c:a flac" "ogg:-c:a libvorbis" "m4a:-c:a aac"; do
  ext="${spec%%:*}"; codec="${spec#*:}"
  ff -f lavfi -i "sine=frequency=440:duration=0.3" -metadata title="元" $codec "base.$ext"
  ff -f lavfi -i "sine=frequency=660:duration=0.3" -metadata title="元" $codec "other.$ext"
  ff -i "base.$ext" -map_metadata -1 -metadata title="書き換えたタイトル" \
     -metadata comment="長いコメントを付けてタグ情報の大きさを変える。$(printf 'x%.0s' $(seq 1 300))" \
     -c copy "retag.$ext"
done
ls -la
