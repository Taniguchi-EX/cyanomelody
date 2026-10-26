# Androidの連携

## 概要

Android だけに必要な処理を Kotlin の Tauri プラグインとして作る。

詳しい仕様は `00_現在の仕様/機能仕様.md` と `00_現在の仕様/技術仕様.md`、順番は `00_現在の仕様/開発ロードマップ.md` を参照。

## ミニロードマップ

### 実装

- [x] フォアグラウンドサービス、MediaSession（通知とロック画面）、音声フォーカス（一時的に失ったときの再開を含む）
- [x] 音楽ファイルを読む権限の要求
- [x] Google のログイン（AuthorizationClient）とアクセストークンの受け渡し
- [x] 一時停止が続いたら出力を閉じる

### レビュー

- [x] 差分を読み直し、仕様との食い違い、エラー処理の漏れ、不要なコードがないかを確かめる
- [x] 指摘を直す

### テスト

- [x] Docker で APK がビルドできる
- [ ] 実機での確認は `実機での総合テスト` で行う

### コミットとプッシュ

- [x] 仕様や手順に変更があれば `00_現在の仕様/` と README に反映する
- [x] コミットする
- [ ] プッシュする（自動の権限チェックで止められたため、開発者の許可待ち）
- [x] このフォルダに連番を付けて `02_完了したタスク/` に移す

## 結果

Kotlin（`app/src-tauri/gen/android/app/src/main/java/dev/cyanomelody/app/`）:

- `PlaybackService.kt`：試作（`prototypes/tauri_android`）で実機で動作を確かめたものを移した。フォアグラウンドサービス（`mediaPlayback`）、MediaSession（通知とロック画面の再生・一時停止・次・前・停止）、音声フォーカス（失ったら一時停止、一時的に失って取り戻したら再開）
- `RustBridge.kt`：Rust との JNI のつなぎ目。再生の状態の知らせを受けてサービスを更新し、通知などからの操作を Rust に送る。Google のログイン（Google Identity Services の AuthorizationClient）で `drive.readonly` と `drive.file` のアクセストークンを得る。同意が必要なら同意の画面を出す
- `MainActivity.kt`：起動時に RustBridge を初期化し、音楽ファイルを読む権限（`READ_MEDIA_AUDIO`）を求める。同意の画面の結果を受け取る
- `AndroidManifest.xml`：権限（`READ_MEDIA_AUDIO`、`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MEDIA_PLAYBACK`）とサービスを追加
- `build.gradle.kts`：Google のログインのライブラリ（`play-services-auth`）を追加

Rust（`app/src-tauri/src/`）:

- `android.rs`：JNI の関数（初期化、通知などからの操作）、再生の状態の知らせ、Android のアクセストークン `AndroidToken`（Google Identity Services が更新を受け持つため、リフレッシュトークンは持たない。50 分使い回す）
- `lib.rs`：Android では、ログインとログアウトを `AndroidToken` で行い、再生エンジンのイベントのたびに Kotlin に状態を知らせる
- 一時停止の間に出力を閉じる処理は、`再生エンジン` で作り済み

### レビュー

- 差分を読み直した。試作で実機の確認が済んでいる部分（再生サービス、通知、音声フォーカス）は、パッケージ名と表示の文言だけを変えて移した
- Kotlin と Rust のつなぎ方を、計画の「Tauri のプラグイン」から「JNI での直接のつなぎ」に変えた。プラグインの仕組みでは Kotlin から Rust を呼ぶ向き（通知からの操作）の扱いが難しく、試作で動いた方法を使うため。Android 向けのプロジェクト（`gen/android`）はリポジトリで管理しているので、作り直さない限り消えない。仮決めとして `仮決め事項の確認` に追加した
- Android 向けのビルドで出ていた警告（デスクトップ専用の部分が使われない、デスクトップ用の OAuth クライアントがない）をなくした
- 残した課題
  - Android のログインには、アプリの ID `dev.cyanomelody.app` 用の Android の OAuth クライアントが Google Cloud に必要。今あるのは試作の ID 用のため、開発者が作る（SHA-1 はデバッグ用の署名鍵のもので、試作と同じ）
  - Android のログアウトは、アプリの中の印を消すだけで、Google 側の許可は取り消さない

### テスト

- Docker で Android 17 向けの APK をビルドでき、Kotlin と Rust のコンパイルが通った。このアプリのコードについての警告はない
- Windows の検査のスクリプトが通った（Android 用のコードは Windows ではコンパイルされない）
- 実機での確認（バックグラウンド再生、通知とロック画面、音声フォーカス、権限の要求、ログイン）は、`実機での総合テスト` でまとめて行う

## 資料マップ

- `0010_Androidの連携_概要.md`：このファイル。タスクの概要とミニロードマップ
