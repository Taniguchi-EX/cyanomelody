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

# hash/ … ハッシュ値の機能の確認用。重複（そのままのコピーと、タグだけ書き換えたもの）と、壊れたファイルを含む
# outside/ … ライブラリに登録しない場所の音声（ファイルを指定して探すときに使う）
hash="$out/hash"
outside="$out/outside"
rm -rf "$hash" "$outside"
mkdir -p "$hash/dup" "$outside"
ff -f lavfi -i "sine=frequency=523:duration=0.5" -metadata title="ド" -c:a libmp3lame "$hash/se1.mp3"
cp "$hash/se1.mp3" "$hash/dup/se1_copy.mp3"
ff -i "$hash/se1.mp3" -map_metadata -1 -metadata title="タグを書き換えた" -c copy "$hash/se1_retag.mp3"
ff -f lavfi -i "sine=frequency=659:duration=0.5" -metadata title="ミ" "$hash/se2.wav"
printf x > "$hash/broken.wav"
cp "$hash/se2.wav" "$outside/se2_outside.wav"
printf 'not audio' > "$outside/text.mp3"

if [ ! -d "$large" ]; then
  for d in $(seq -w 0 99); do
    mkdir -p "$large/d$d"
    for i in $(seq -w 0 299); do
      printf x > "$large/d$d/se_${d}_${i}.wav"
    done
  done
fi
echo "作成しました: $out"
