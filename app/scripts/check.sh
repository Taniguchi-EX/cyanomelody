#!/usr/bin/env bash
# コミットの前に行う検査をまとめて実行する。
# 使い方: bash scripts/check.sh（app/ で実行する）
set -euo pipefail
cd "$(dirname "$0")/.."

step() { echo; echo "=== $1"; }

step "Rust の書式（cargo fmt）"
cargo fmt --all -- --check

step "Rust の静的な検査（cargo clippy）"
cargo clippy --workspace --all-targets -- -D warnings

step "Rust の単体テスト（cargo test）"
cargo test --workspace

step "TypeScript の型の検査（tsc）"
npm run --silent typecheck

echo
echo "RESULT: CHECK OK"
