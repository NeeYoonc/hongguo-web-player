#!/usr/bin/env bash
# 构建取流侧车 hg-resolve（复用 hongguo-desktop 的官方 App 签名/接口实现）
#
#   REF_REPO  参考实现仓库（默认 GitHub）
#   REF_COMMIT 固定提交（保证可复现；改动需人工验证）
#   TARGET   Rust 目标三元组（x86_64-unknown-linux-musl / aarch64-unknown-linux-musl）
#   OUT      输出路径（默认 $BUILD_ROOT/bin/hg-resolve-<arch>）
#   CROSS=1  用 cross（Docker）构建 aarch64；否则本机 cargo（x86_64 + musl-tools）
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${BUILD_ROOT:-$PROJECT_DIR/.nas-build}"
REF_REPO="${REF_REPO:-https://github.com/it00021hot/hongguo-desktop}"
REF_COMMIT="${REF_COMMIT:-374b1819b0c4ae2f77cf6008e1c138f92f1f16bd}"
TARGET="${TARGET:-x86_64-unknown-linux-musl}"
CROSS="${CROSS:-0}"
OUT="${OUT:-$BUILD_ROOT/bin/hg-resolve-$(echo "$TARGET" | cut -d- -f1)}"
WORK="${WORK:-$BUILD_ROOT/sidecar-src}"

mkdir -p "$(dirname "$OUT")"
# OUT/WORK 预先转成绝对路径：脚本后面会 cd 进 WORK，相对路径会落错目录
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
mkdir -p "$(dirname "$WORK")"
WORK="$(cd "$(dirname "$WORK")" && pwd)/$(basename "$WORK")"
rm -rf "$WORK"
echo "[sidecar] 克隆参考实现 @ $REF_COMMIT"
git clone --filter=blob:none --no-checkout "$REF_REPO" "$WORK" >/dev/null 2>&1
git -C "$WORK" checkout -q "$REF_COMMIT"

echo "[sidecar] 注入 hg-resolve + 打补丁"
rm -rf "$WORK/crates/hg-resolve"
cp -a "$PROJECT_DIR/nas/sidecar" "$WORK/crates/hg-resolve"
# 1) 加入 workspace members
python3 - "$WORK" <<'PY'
import io, sys, os
work = sys.argv[1]
p = os.path.join(work, 'Cargo.toml')
s = io.open(p, encoding='utf-8').read()
if '"crates/hg-resolve"' not in s:
    s = s.replace('members = [', 'members = [\n    "crates/hg-resolve",', 1)
# 2) 降低 rust-version（CI 用当前 stable；上游写的是预期版本号）
s = s.replace('rust-version = "1.99.1"', 'rust-version = "1.85"')
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)

# 3) 关掉需要 pkg-config/libvvdec 的默认特性（侧车不解码，只要选流）
p = os.path.join(work, 'crates/hongguo-api/Cargo.toml')
s = io.open(p, encoding='utf-8').read()
old = 'hongguo-bytevc2 = { path = "../hongguo-bytevc2" }'
new = 'hongguo-bytevc2 = { path = "../hongguo-bytevc2", default-features = false, features = ["oxideav"] }'
if old in s:
    s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print("[sidecar] Cargo 补丁完成")
PY

export CARGO_NET_GIT_FETCH_WITH_CLI=true
cd "$WORK"
if [ "$CROSS" = "1" ]; then
  cargo install cross --locked >/dev/null 2>&1 || true
  cross build --release -p hg-resolve --target "$TARGET"
else
  rustup target add "$TARGET" >/dev/null 2>&1 || true
  cargo build --release -p hg-resolve --target "$TARGET"
fi
cp "$WORK/target/$TARGET/release/hg-resolve" "$OUT"
chmod 755 "$OUT"
echo "[sidecar] 完成: $OUT ($(du -h "$OUT" | cut -f1))"
