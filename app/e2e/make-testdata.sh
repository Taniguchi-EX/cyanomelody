#!/usr/bin/env bash
# 画面テスト用のデータを作る。ffmpegが必要。
#   bash e2e/make-testdata.sh <出力先フォルダ>
# 出力先に以下を作る。
#   formats/  … 5つの形式の音声（1秒のチャイム）。サブフォルダと日本語の名前を含む
#   large/    … 一覧の確認用に、中身がダミーの .wav を3万個
#   durations/ … 長さでの絞り込みの確認用に、長さの違う音声（3秒、1分10秒、1時間1分40秒）
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

# meta/ … 自動タグ付けの確認用。ファイルの中の情報（アーティスト・アルバム・ジャンル・作曲者）を入れた音声と、
#          無視する値（Unknown・Other）を入れた音声、情報のない音声。リリース年の絞り込みの確認にも使う（2006・2019・2023年、年なし）
meta="$out/meta"
rm -rf "$meta"
mkdir -p "$meta"
ff -f lavfi -i "sine=frequency=330:duration=0.5" -metadata artist="テストアーティスト" -metadata album="テストアルバム"   -metadata genre="Rock" -metadata composer="作曲家A" -metadata date="2006" -c:a libmp3lame "$meta/m1.mp3"
ff -f lavfi -i "sine=frequency=350:duration=0.5" -metadata artist="Unknown" -metadata album="テストアルバム" -metadata date="2019" -c:a libmp3lame "$meta/m2.mp3"
ff -f lavfi -i "sine=frequency=370:duration=0.5" -metadata genre="Other" -metadata composer="作曲家A" -metadata date="2023-04-14" "$meta/m3.flac"
ff -f lavfi -i "sine=frequency=390:duration=0.5" "$meta/m4.wav"

# hash/ … ハッシュ値の機能の確認用。重複（そのままのコピーと、タグだけ書き換えたもの）と、壊れたファイルを含む
# outside/ … ライブラリの外の音声（リンク切れのファイルを紐づけるときに、フォルダごと登録される）
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
# 曲名（タグ情報のタイトル）のない音声。再生の欄で、拡張子を除いたファイル名を出すことの確認に使う
ff -f lavfi -i "sine=frequency=440:duration=0.5" -map_metadata -1 "$outside/no_title.wav"

# 長い音声は作るのに時間がかかるので、一度作ったら作り直さない
durations="$out/durations"
if [ ! -d "$durations" ]; then
  mkdir -p "$durations.tmp"
  ff -f lavfi -i "sine=frequency=440:duration=3" "$durations.tmp/d_3s.wav"
  ff -f lavfi -i "sine=frequency=440:duration=70" -ac 1 -ar 8000 -c:a libmp3lame -b:a 8k "$durations.tmp/d_70s.mp3"
  ff -f lavfi -i "sine=frequency=440:duration=3700" -ac 1 -ar 8000 -c:a libmp3lame -b:a 8k "$durations.tmp/d_3700s.mp3"
  mv "$durations.tmp" "$durations"
fi

if [ ! -d "$large" ]; then
  for d in $(seq -w 0 99); do
    mkdir -p "$large/d$d"
    for i in $(seq -w 0 299); do
      printf x > "$large/d$d/se_${d}_${i}.wav"
    done
  done
fi
echo "作成しました: $out"
