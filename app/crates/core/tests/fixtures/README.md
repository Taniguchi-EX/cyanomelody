# テスト用の音声

MP3 のシークの見積もりのテストに使う。1 秒ごとに音の高さが上がる 20 秒の音（`t` 秒目は `200 + 100 × floor(t)` Hz）。

```sh
SRC="aevalsrc=0.4*sin(2*PI*(200+100*floor(t))*t):s=44100:d=20"
ffmpeg -f lavfi -i "$SRC" -c:a libmp3lame -b:a 32k steps_cbr.mp3                 # 固定ビットレート（Info ヘッダ付き）
ffmpeg -f lavfi -i "$SRC" -c:a libmp3lame -q:a 9 steps_vbr.mp3                   # 可変ビットレート（Xing ヘッダ付き）
ffmpeg -f lavfi -i "$SRC" -c:a libmp3lame -q:a 9 -write_xing 0 steps_vbr_noxing.mp3  # 可変ビットレート（目次なし）
```
