# cyanomelody アプリ

Tauri 2（Rust ＋ React）の本体。仕様は `../docs/00_現在の仕様/` を参照。

## フォルダ構成

- `crates/core/`：中核（`cyanomelody-core`）。OS に依存しない処理を置き、Tauri には依存しない
- `src-tauri/`：Tauri のアプリ（`cyanomelody`）。画面と中核をつなぐ
  - `gen/android/`：Android 向けのプロジェクト（`tauri android init` で生成し、手を加えたもの）
- `src/`：画面（React ＋ TypeScript）
- `scripts/check.sh`：コミットの前に行う検査

## 準備

- Rust（最新の安定版。`rustfmt`、`clippy` を含む）
- Node.js 22 以上
- Docker（Android 版と Ubuntu 版のビルド）

```sh
cd app
npm install
```

## 開発と検査

```sh
npm run tauri dev          # Windows で起動する（画面の変更はその場で反映される）
bash scripts/check.sh      # 書式、静的な検査、単体テスト、型の検査
```

## ビルド

Windows 版（開発 PC で直接ビルドする）:

```sh
npx tauri build --debug --no-bundle   # target/debug/cyanomelody.exe
```

Android 版（Docker でビルドする。ビルド環境のイメージは `../prototypes/android_env/`）:

```sh
bash ~/.claude/skills/cyanomelody-android-test/resources/build-apk.sh "$(pwd)"   # out/app-debug.apk
```

- デバッグ用の署名鍵は Docker のボリューム `cm-android-home` に保存して使い回す。消すと上書きインストールできなくなる
- 実機での確認の手順は、Claude Code のスキル `cyanomelody-android-test` にまとめてある
