#!/usr/bin/env bash
#===============================================================================
# 红果短剧 → 群晖 DSM 7 SPK 打包脚本
#
# 依赖策略（用户口径）：
#   · 不内置 ffmpeg —— 依赖套件源里现成的 SynoCommunity FFmpeg（默认 ffmpeg7）
#   · INFO 写 install_dep_packages → 未装该套件时套件中心拒绝安装
#   · 社区包二进制带版本后缀（ffmpeg7/ffprobe7），启动脚本建 shim 软链给服务端用
#
# 用法：
#   ARCH=x86_64 VERSION=1.0.0-3 BIN=path/hongguoweb-amd64 WASM=path/ffmpeg-core.wasm \
#     DEP_PKG=ffmpeg7 ./nas/pack-spk.sh
#
#   ARCH      x86_64 | armv8（DSM 架构名）
#   VERSION   INFO 版本号（默认 1.0.0-3）
#   DEP_PKG   依赖的 ffmpeg 套件名（默认 ffmpeg7；可换 ffmpeg8/ffmpeg6/ffmpeg5/ffmpeg）
#   BIN       已编译的 linux 二进制（默认 $BUILD_ROOT/bin/hongguoweb-<arch>）
#   WASM      ffmpeg-core.wasm（缺失则浏览器直连播放不可用）
#   OUT_DIR   产物目录（默认 $PROJECT_DIR/dist）
#
# 产物：$OUT_DIR/hongguoweb_<DSM架构>-<版本>.spk
#===============================================================================
set -euo pipefail

NAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$NAS_DIR/.." && pwd)"

APP_NAME="hongguoweb"
DISPLAY_NAME="红果短剧"
ARCH="${ARCH:-x86_64}"
case "$ARCH" in
  x86_64) BIN_ARCH=amd64 ;;
  armv8)  BIN_ARCH=arm64 ;;
  *) echo "[!] ARCH 只支持 x86_64 / armv8，收到: $ARCH" >&2; exit 1 ;;
esac

VERSION="${VERSION:-1.0.0-3}"
DEP_PKG="${DEP_PKG:-ffmpeg7}"
DEP_NODE="${DEP_NODE:-Node.js_v22}"   # Node.js 官方套件（弹幕签名脚本需要 node）
DEFAULT_PORT=8788
BUILD_ROOT="${BUILD_ROOT:-$PROJECT_DIR/.nas-build}"
OUT_DIR="${OUT_DIR:-$PROJECT_DIR/dist}"
BIN="${BIN:-$BUILD_ROOT/bin/hongguoweb-$BIN_ARCH}"
WASM="${WASM:-$BUILD_ROOT/web/ffmpeg-core.wasm}"
ASSETS="$NAS_DIR/assets"

[ -f "$ASSETS/PACKAGE_ICON.PNG" ] || { echo "[!] 缺少图标，先运行 python nas/make-icons.py" >&2; exit 1; }
[ -f "$BIN" ] || { echo "[!] 找不到二进制: $BIN" >&2; exit 1; }
case "$(head -c 4 "$BIN" 2>/dev/null | od -An -c | tr -d ' \n')" in
  *177ELF*) : ;;
  *) echo "[!] $BIN 不是 Linux ELF（是不是忘了 GOOS=linux？）" >&2; exit 1 ;;
esac

TARGET="$BUILD_ROOT/target-$ARCH"
ASSEMBLE="$BUILD_ROOT/assemble-$ARCH"
rm -rf "$TARGET" "$ASSEMBLE"
mkdir -p "$TARGET/bin" "$TARGET/web" "$ASSEMBLE/conf" "$ASSEMBLE/scripts" \
         "$ASSEMBLE/ui/images" "$ASSEMBLE/WIZARD_UIFILES" "$OUT_DIR"

# ── target：bin/hongguoweb + web/（不含 ffmpeg） ────────────────────────────────
cp "$BIN" "$TARGET/bin/hongguoweb"
chmod 755 "$TARGET/bin/hongguoweb"
cp -a "$PROJECT_DIR/web/." "$TARGET/web/"
find "$TARGET/web" -name '*.bak' -delete 2>/dev/null || true
mkdir -p "$TARGET/web/assets/ffmpeg"
if [ -f "$WASM" ]; then
  cp "$WASM" "$TARGET/web/assets/ffmpeg/ffmpeg-core.wasm"
  echo "  ✓ 内置 ffmpeg-core.wasm ($(du -h "$WASM" | cut -f1))"
else
  echo "  ! 未内置 ffmpeg-core.wasm（$WASM 缺失）：浏览器直连播放不可用"
fi
# 弹幕签名组件（服务端 webDir/../signer/fetch_danmaku.mjs，需 node 执行）
#   仓库只存 signer 源码；node_modules 构建期用 npm 装（不入库）
DANMU_SRC="$ASSETS/danmu"
if [ -d "$DANMU_SRC" ]; then
  if [ ! -d "$DANMU_SRC/node_modules" ]; then
    if command -v npm >/dev/null 2>&1; then
      echo "  安装弹幕组件依赖（npm install --omit=dev）..."
      ( cd "$DANMU_SRC" && npm install --omit=dev --no-audit --no-fund           --registry="${NPM_REGISTRY:-https://registry.npmmirror.com}" >/dev/null 2>&1 )         || echo "  ! npm install 失败：弹幕功能可能不可用"
    else
      echo "  ! 未找到 npm：弹幕功能不可用（请装 Node.js 后重试）"
    fi
  fi
  cp -a "$DANMU_SRC" "$TARGET/signer"
  echo "  ✓ 内置弹幕组件 signer/ ($(du -sh "$TARGET/signer" | cut -f1))"
else
  echo "  ! 未找到 $DANMU_SRC：弹幕功能不可用"
fi
echo "  ✓ 不内置 ffmpeg/ffprobe —— 依赖套件: ${DEP_PKG}"

# ── INFO ──────────────────────────────────────────────────────────────────────
cat > "$ASSEMBLE/INFO" <<EOF
package="${APP_NAME}"
version="${VERSION}"
description="红果短剧 Web 客户端：推荐流 / 找剧 / 详情 / 弹幕 / 评论 / 直连播放的自托管播放器（需先安装 ${DEP_PKG} 与 ${DEP_NODE}）。仅供个人学习研究。"
install_dep_packages="${DEP_PKG}:${DEP_NODE}"
arch="${ARCH}"
maintainer="NeeYoonc"
maintainer_url="https://github.com/NeeYoonc/hongguo-web-player"
distributor="NeeYoonc"
distributor_url="https://github.com/NeeYoonc/hongguo-web-player"
os_min_ver="7.0-40000"
reloadui="yes"
displayname="${DISPLAY_NAME}"
dsmuidir="ui"
dsmappname="SYNO.SDS.Hongguoweb.Application"
helpurl="https://github.com/NeeYoonc/hongguo-web-player"
support_url="https://github.com/NeeYoonc/hongguo-web-player"
changelog="[${VERSION}] 依赖 ${DEP_PKG}（ffmpeg）+ ${DEP_NODE}（node，弹幕用）；内置 signer 弹幕组件与 ffmpeg.wasm"
checksum=""
EOF

# ── conf ──────────────────────────────────────────────────────────────────────
cp "$ASSETS/conf/privilege" "$ASSEMBLE/conf/privilege"
printf '{}' > "$ASSEMBLE/conf/resource"

# ── 图标 ──────────────────────────────────────────────────────────────────────
cp "$ASSETS/PACKAGE_ICON.PNG" "$ASSETS/PACKAGE_ICON_256.PNG" "$ASSEMBLE/"
cp "$ASSETS/ui/images/"*.png "$ASSEMBLE/ui/images/"

# ── ui/config ────────────────────────────────────────────────────────────────
cat > "$ASSEMBLE/ui/config" <<EOF
{
    ".url": {
        "SYNO.SDS.Hongguoweb.Application": {
            "type": "url",
            "icon": "images/icon_{0}.png",
            "title": "${DISPLAY_NAME}",
            "desc": "红果短剧 Web 客户端（自托管播放器）",
            "protocol": "http",
            "port": "${DEFAULT_PORT}",
            "url": "/",
            "allUsers": true
        }
    }
}
EOF

# ★ 关键：ui/ 必须同时放进 package.tgz（target/ui）—— DSM 的 webman 第三方链接
#   指向 /var/packages/<pkg>/target/ui，只有这里存在才会生成「打开」按钮
#  （SPK 根目录的 ui/ 保留给套件中心读取图标/配置）
mkdir -p "$TARGET/ui/images"
cp "$ASSEMBLE/ui/config" "$TARGET/ui/config"
cp "$ASSEMBLE/ui/images/"*.png "$TARGET/ui/images/"
chmod 644 "$TARGET/ui/config" "$TARGET/ui/images/"*.png 2>/dev/null || true

# ── scripts/start-stop-status ────────────────────────────────────────────────
cat > "$ASSEMBLE/scripts/start-stop-status" <<'SSS_EOF'
#!/bin/sh
# 红果短剧 Web 客户端 · DSM 启停脚本
#  ffmpeg/ffprobe 由依赖套件（${DEP_PKG} 等社区 FFmpeg）提供，社区包二进制带版本后缀
#  （ffmpeg7/ffprobe7）→ 这里在数据目录建 shim 软链，服务端按 "ffmpeg/ffprobe" 调用即可。
PACKAGE_NAME="$SYNOPKG_PKGNAME"
BASE="/var/packages/${PACKAGE_NAME}/target"
VAR="/var/packages/${PACKAGE_NAME}/var"
PID="$VAR/hongguoweb.pid"
LOG="$VAR/hongguoweb.log"
PORT_FILE="$VAR/ports"
DEFAULT_PORT=8788
DEP_PKG="__DEP_PKG__"

resolve_port() {
  p=""
  if [ -f "$PORT_FILE" ]; then
    p=$(sed -n 's/^PORT=\([0-9][0-9]*\).*/\1/p' "$PORT_FILE" 2>/dev/null | head -1)
  fi
  [ -n "$p" ] || p="$DEFAULT_PORT"
  echo "$p"
}

is_running() {
  [ -f "$PID" ] || return 1
  _p=$(cat "$PID" 2>/dev/null)
  [ -n "$_p" ] || return 1
  kill -0 "$_p" 2>/dev/null
}

setup_ffmpeg_shim() {
  _shim="$VAR/bin"
  mkdir -p "$_shim" 2>/dev/null || return 0
  # 先找声明的依赖包，再兜底其它 ffmpeg 版本包（架构一致即可）
  for _pkg in "$DEP_PKG" ffmpeg8 ffmpeg7 ffmpeg6 ffmpeg5 ffmpeg4 ffmpeg; do
    [ -n "$_pkg" ] || continue
    _d="/var/packages/${_pkg}/target/bin"
    [ -d "$_d" ] || continue
    for _f in "$_d"/ffmpeg "$_d"/ffmpeg[0-9] "$_d"/ffmpeg[0-9][0-9]; do
      [ -x "$_f" ] || continue
      _probe="${_f%ffmpeg*}ffprobe${_f##*ffmpeg}"
      [ -x "$_probe" ] || continue
      ln -sf "$_f" "$_shim/ffmpeg" 2>/dev/null
      ln -sf "$_probe" "$_shim/ffprobe" 2>/dev/null
      echo "  ffmpeg: ${_f}（来自套件 ${_pkg}）"
      return 0
    done
  done
  # 兜底：系统 PATH 里已有静态 ffmpeg（如 /usr/local/bin 或 /usr/bin）
  if command -v ffmpeg >/dev/null 2>&1; then
    echo "  ffmpeg: $(command -v ffmpeg)（系统 PATH）"
    return 0
  fi
  echo "[!] 未找到 ffmpeg：服务端中转模式不可用（浏览器直连播放不受影响）" >&2
  return 1
}

# node：弹幕签名脚本（signer/fetch_danmaku.mjs）由 node 执行 → 建 node shim
setup_node() {
  for _cand in     /var/packages/Node.js_v22/target/usr/local/bin     /var/packages/Node.js_v20/target/usr/local/bin     /var/packages/Node.js_v18/target/usr/local/bin     /usr/local/bin /usr/bin; do
    if [ -x "$_cand/node" ]; then
      ln -sf "$_cand/node" "$VAR/bin/node" 2>/dev/null || true
      echo "  node: $_cand/node"
      return 0
    fi
  done
  echo "[!] 未找到 node（Node.js 套件未安装？）：弹幕功能不可用，其他功能不受影响" >&2
  return 1
}

do_start() {
  if is_running; then
    echo "已在运行 (pid $(cat "$PID"))"
    return 0
  fi
  mkdir -p "$VAR/data" "$VAR/cache" "$VAR/tmp" || return 1
  setup_ffmpeg_shim >&2 || true
  setup_node >&2 || true
  # $VAR/bin 里是 ffmpeg/ffprobe/node 的 shim → 必须排在 PATH 最前
  export PATH="$VAR/bin:$BASE/bin:$PATH"
  PORT=$(resolve_port)
  export TMPDIR="$VAR/tmp"
  export GOMEMLIMIT=1600MiB
  export GOGC=80
  # < /dev/null：不持有调用方 stdin（否则 synopkg/SSH 调用会一直等 EOF）
  nohup "$BASE/bin/hongguoweb" \
    -addr "0.0.0.0:$PORT" \
    -data "$VAR/data" \
    -web "$BASE/web" \
    -cache "$VAR/cache" \
    < /dev/null >> "$LOG" 2>&1 &
  echo $! > "$PID"
  i=0
  while [ "$i" -lt 20 ]; do
    if ! is_running; then
      echo "[!] 进程启动后退出，详见 $LOG" >&2
      rm -f "$PID"
      return 1
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "已启动: http://<NAS-IP>:$PORT (pid $(cat "$PID"))"
  return 0
}

do_stop() {
  if is_running; then
    _p=$(cat "$PID")
    kill "$_p" 2>/dev/null
    i=0
    while [ "$i" -lt 10 ] && kill -0 "$_p" 2>/dev/null; do
      i=$((i + 1))
      sleep 1
    done
    kill -9 "$_p" 2>/dev/null
  fi
  rm -f "$PID"
  echo "已停止"
  return 0
}

case "$1" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop >/dev/null 2>&1; do_start ;;
  status)
    if is_running; then
      echo "running (pid $(cat "$PID"))"
      exit 0
    fi
    echo "stopped"
    exit 1
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
exit 0
SSS_EOF
sed -i "s/__DEP_PKG__/${DEP_PKG}/" "$ASSEMBLE/scripts/start-stop-status"
chmod 755 "$ASSEMBLE/scripts/start-stop-status"

# ── scripts/installer + 生命周期钩子 ─────────────────────────────────────────
cat > "$ASSEMBLE/scripts/installer" <<'INSTALLER_EOF'
#!/bin/sh
# 安装期逻辑（被各 hook 脚本 source 后调用）
PACKAGE_NAME="$SYNOPKG_PKGNAME"
BASE="/var/packages/${PACKAGE_NAME}/target"
VAR="/var/packages/${PACKAGE_NAME}/var"
UI_DIR="/var/packages/${PACKAGE_NAME}/ui"
DEFAULT_PORT=8788

setup_dirs() {
  mkdir -p "$VAR/data" "$VAR/cache" "$VAR/tmp" 2>/dev/null
  chown -R "${PACKAGE_NAME}:${PACKAGE_NAME}" "$VAR" 2>/dev/null || true
}

sync_ui() {
  _port="$1"
  for _cfg in "$UI_DIR/config" "$BASE/ui/config"; do
    [ -f "$_cfg" ] || continue
    sed -i "s/\"port\"[[:space:]]*:[[:space:]]*\"[0-9]*\"/\"port\": \"${_port}\"/" "$_cfg" 2>/dev/null || true
  done
}

write_ports() {
  _p=""
  if [ -f "$VAR/ports" ]; then
    _p=$(sed -n 's/^PORT=\([0-9][0-9]*\).*/\1/p' "$VAR/ports" 2>/dev/null | head -1)
  fi
  if [ -z "$_p" ] && [ -n "${wizard_port:-}" ]; then
    _p="$wizard_port"
  fi
  [ -n "$_p" ] || _p="$DEFAULT_PORT"
  printf 'PORT=%s\n' "$_p" > "$VAR/ports"
  chown "${PACKAGE_NAME}:${PACKAGE_NAME}" "$VAR/ports" 2>/dev/null || true
  sync_ui "$_p"
}

postinst() {
  setup_dirs
  write_ports
  exit 0
}

postupgrade() {
  setup_dirs
  write_ports
  exit 0
}

preupgrade() {
  /var/packages/${PACKAGE_NAME}/scripts/start-stop-status stop >/dev/null 2>&1
  exit 0
}

preuninst() {
  /var/packages/${PACKAGE_NAME}/scripts/start-stop-status stop >/dev/null 2>&1
  exit 0
}

postuninst() {
  if [ "${wizard_delete_data:-false}" = "true" ]; then
    rm -rf "$VAR/data" "$VAR/cache" "$VAR/tmp" "$VAR/bin" 2>/dev/null
    rm -f "$VAR/ports" "$VAR/hongguoweb.log" "$VAR/hongguoweb.pid" 2>/dev/null
  fi
  exit 0
}
INSTALLER_EOF
chmod 755 "$ASSEMBLE/scripts/installer"

for hook in postinst postupgrade preupgrade preuninst postuninst; do
  cat > "$ASSEMBLE/scripts/$hook" <<HOOK_EOF
#!/bin/sh
. "\$(dirname "\$0")/installer"
${hook}
HOOK_EOF
  chmod 755 "$ASSEMBLE/scripts/$hook"
done

# ── WIZARD_UIFILES（安装问端口 / 卸载问是否删数据） ──────────────────────────
cat > "$ASSEMBLE/WIZARD_UIFILES/install_uifile" <<'WIZ_EOF'
[{
  "step_title": "红果短剧 端口设置",
  "items": [{
    "type": "textfield",
    "desc": "Web 端口（留空使用默认 8788）",
    "subitems": [{
      "key": "wizard_port",
      "desc": "端口",
      "validator": {
        "allowBlank": true,
        "regex": { "expr": "/^[0-9]+$/", "errorText": "请输入数字端口" }
      }
    }]
  }]
}]
WIZ_EOF
cp "$ASSEMBLE/WIZARD_UIFILES/install_uifile" "$ASSEMBLE/WIZARD_UIFILES/install_uifile_chs"
cat > "$ASSEMBLE/WIZARD_UIFILES/uninstall_uifile" <<'WIZ_EOF'
[{
  "step_title": "Uninstall package",
  "items": [{
    "type": "singleselect",
    "desc": "Keep or delete package data.",
    "subitems": [{
      "key": "wizard_keep_data",
      "desc": "<b>Uninstall only.</b> Keep data for future re-installation.",
      "defaultValue": true
    }, {
      "key": "wizard_delete_data",
      "desc": "<b style=\"color: red\">Erase all package data. (Not recoverable)</b>",
      "defaultValue": false
    }]
  }]
}]
WIZ_EOF
cp "$ASSEMBLE/WIZARD_UIFILES/uninstall_uifile" "$ASSEMBLE/WIZARD_UIFILES/uninstall_uifile_chs"

# ── package.tgz + 外层 spk（Python tarfile 显式写权限位） ─────────────────────
PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  for _p in python3 python; do
    if command -v "$_p" >/dev/null 2>&1 && "$_p" -c 'import sys, tarfile' >/dev/null 2>&1; then
      PYTHON_BIN="$_p"
      break
    fi
  done
fi
[ -n "$PYTHON_BIN" ] || { echo "[!] 需要可用的 python3（含 tarfile）" >&2; exit 1; }

"$PYTHON_BIN" "$NAS_DIR/mktar.py" package "$TARGET" "$ASSEMBLE/package.tgz"
OUT_SPK="$OUT_DIR/${APP_NAME}_${ARCH}-${VERSION}.spk"
rm -f "$OUT_SPK"
"$PYTHON_BIN" "$NAS_DIR/mktar.py" spk "$ASSEMBLE" "$OUT_SPK"

echo
echo "✓ 打包完成: $OUT_SPK"
echo "  架构: $ARCH  版本: $VERSION  依赖: ${DEP_PKG} + ${DEP_NODE}  大小: $(du -h "$OUT_SPK" | cut -f1)"
