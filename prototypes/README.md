# prototypes

技術選定のための試作。検証項目は `docs/01_進行中のタスク/技術選定/試作検証項目.md`、結果は同じフォルダの `試作結果.md` を参照。

## android_env

Tauri 2 の Android ビルド環境（Android 17 / API 37、NDK 30、Rust、Node.js、JDK 17）の Dockerfile。

```sh
docker build -t cyanomelody-android-env:latest prototypes/android_env
```

## stream_decode

Range 指定の部分取得で、タグの読み込み、デコード、シークを行い、通信の回数と量を数える（C-4、B-2、C-5）。

テスト用の曲は `testdata/` に ffmpeg で作る（リポジトリには含めない）。

```sh
cd prototypes/stream_decode/testdata
SRC='anoisesrc=color=pink:duration=180:amplitude=0.3:sample_rate=44100'
META=(-metadata "title=テスト曲" -metadata "artist=テスト歌手" -metadata "album=テストアルバム")
ffmpeg -f lavfi -i "$SRC" -ac 2 "${META[@]}" -c:a libmp3lame -b:a 192k -id3v2_version 3 cbr.mp3
ffmpeg -f lavfi -i "$SRC" -ac 2 "${META[@]}" -c:a libmp3lame -q:a 2 -id3v2_version 3 vbr.mp3
ffmpeg -f lavfi -i "$SRC" -ac 2 "${META[@]}" -c:a pcm_s16le song.wav
ffmpeg -f lavfi -i "$SRC" -ac 2 -c:a pcm_s16le notag.wav
ffmpeg -f lavfi -i "$SRC" -ac 2 "${META[@]}" -c:a aac -b:a 256k -movflags +faststart faststart.m4a
ffmpeg -f lavfi -i "$SRC" -ac 2 "${META[@]}" -c:a aac -b:a 256k moov_end.m4a
```

Range 指定に対応した HTTP サーバ（Caddy）を立てて実行する。

```sh
docker network create cm-net
docker run -d --name cm-media --network cm-net -v "$PWD/testdata:/srv:ro" caddy:2 caddy file-server --root /srv --listen :80
docker run --rm --network cm-net -v "$PWD:/work" -w /work rust:1-bookworm sh -c 'cargo run --release -- http://cm-media'
```

取得単位は環境変数 `CHUNK_KB`（既定 256）で変えられる。

## play_local

Symphonia でデコードした音を cpal で鳴らす（B-1）。デスクトップで直接実行する。

```sh
cargo run --release -- <ファイル> [音量 0.0〜1.0]
```

確認用のチャイム音（ド・ミ・ソ、3 秒）は `testdata/` に ffmpeg で作る（リポジトリには含めない）。Android 実機のテスト用の曲にも使う。

```sh
cd prototypes/play_local/testdata
for ext in mp3 wav m4a; do
  ffmpeg -f lavfi -i "sine=frequency=523.25:duration=1" -f lavfi -i "sine=frequency=659.25:duration=1" -f lavfi -i "sine=frequency=783.99:duration=1" \
    -filter_complex "[0][1][2]concat=n=3:v=0:a=1,afade=t=out:st=2.5:d=0.5,volume=0.3" -ar 44100 -ac 2 -metadata title=チャイム chime.$ext
done
ffmpeg -i chime.wav -c:a aac -b:a 192k chime_moov_end.m4a
```

## tauri_android

Android 実機での検証用アプリ。次の機能を持つ。

- チャイム音を Rust でデコードし、cpal（AAudio）で鳴らす（G-1、A-1）
- 常駐する再生エンジンで、音の高さを変えたチャイム 3 曲のプレイリストを繰り返す。10 秒ごとに出力の動き具合をログに出す
- Kotlin のフォアグラウンドサービス、MediaSession（通知とロック画面の操作）、音声フォーカス（`gen/android/.../PlaybackService.kt`）。Rust とは JNI でつなぐ（`RustBridge.kt`）（A-2、A-3、A-4、A-5、A-6）
- 指定フォルダの曲をファイルパスで一覧にし、再生する（D-1、D-2）
- 端末 ID をデータ領域に保存して表示する（E-2）

実機でのビルド、インストール、操作、ログ確認の手順は、Claude Code のスキル `cyanomelody-android-test`（`~/.claude/skills/cyanomelody-android-test/`）にまとめてある。

ビルドは android_env のイメージの中で行う。デバッグ用の署名鍵（`/root/.android/debug.keystore`）はボリュームに保存して使い回す。保存しないとビルドのたびに鍵が変わり、上書きインストールできなくなる。

```sh
# prototypes/tauri_android で実行
docker run --rm -v "$PWD:/work" -w /work -v cm-android-home:/root/.android cyanomelody-android-env:latest \
  npx tauri android build --debug --apk --target aarch64
```

曲の一覧を試すときは、音楽ファイルを読む権限を adb で与える。

```sh
adb shell pm grant dev.cyanomelody.proto android.permission.READ_MEDIA_AUDIO
```
