#!/usr/bin/env bash
# 构建取流侧车 hg-resolve（官方 App v5 通道）
#
# 源码来自本仓库 nas/vendor（vendor 了 hongguo-desktop 的签名/接口实现），
# 不再需要 clone 外部仓库；协议变化时手动同步上游提交并更新 NOTICE.md。
#
#   TARGET   Rust 目标三元组（x86_64-unknown-linux-musl / aarch64-unknown-linux-musl）
#   OUT      输出路径（默认 $BUILD_ROOT/bin/hg-resolve-<arch>）
#   CROSS=1  用 cross（Docker）构建 aarch64；否则本机 cargo
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${BUILD_ROOT:-$PROJECT_DIR/.nas-build}"
VENDOR="$PROJECT_DIR/nas/vendor"
TARGET="${TARGET:-x86_64-unknown-linux-musl}"
CROSS="${CROSS:-0}"
OUT="${OUT:-$BUILD_ROOT/bin/hg-resolve-$(echo "$TARGET" | cut -d- -f1)}"

mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"

cd "$VENDOR"
echo "[sidecar] 从 nas/vendor 构建（target=$TARGET）"
if [ "$CROSS" = "1" ]; then
  cargo install cross --locked >/dev/null 2>&1 || true
  cross build --release -p hg-resolve --target "$TARGET"
else
  rustup target add "$TARGET" >/dev/null 2>&1 || true
  cargo build --release -p hg-resolve --target "$TARGET"
fi
cp "$VENDOR/target/$TARGET/release/hg-resolve" "$OUT"
chmod 755 "$OUT"
echo "[sidecar] 完成: $OUT ($(du -h "$OUT" | cut -f1))"
