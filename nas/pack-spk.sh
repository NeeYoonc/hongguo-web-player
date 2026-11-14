#!/usr/bin/env bash
#===============================================================================
# 红果短剧 → 群晖 DSM 7 套件（SPK）打包脚本
#
# 两个套件：
#   PKG=hongguoweb     Web 客户端（不内置 ffmpeg，强制依赖 ffmpeg-static）
#   PKG=ffmpeg-static  静态 ffmpeg/ffprobe 工具包（hongguoweb 的前置依赖）
#
# 用法：
#   PKG=ffmpeg-static ARCH=x86_64 VERSION=1.0.0-1 \
#     FFMPEG_DIR=path/to/ffmpeg-amd64-dir OUT_DIR=dist ./nas/pack-spk.sh
#
#   PKG=hongguoweb ARCH=x86_64 VERSION=1.0.0-2 \
#     BIN=path/to/hongguoweb-amd64 WASM=path/to/ffmpeg-core.wasm OUT_DIR=dist ./nas/pack-spk.sh
#
#   ARCH          x86_64 | armv8（DSM 架构名）
#   BIN           已编译的 linux 二进制（不传则用 $BUILD_ROOT/bin/hongguoweb-<arch>）
#   FFMPEG_DIR    含 ffmpeg / ffprobe 的静态目录（ffmpeg-static 必填；
#                 hongguoweb 不需要 —— ffmpeg 由依赖套件提供）
#   WASM          ffmpeg-core.wasm（hongguoweb 用；缺失则浏览器直连播放不可用）
#   OUT_DIR       产物目录（默认 $PROJECT_DIR/dist）
#
# 产物：$OUT_DIR/<包名>_<DSM架构>-<版本>.spk
#===============================================================================
set -euo pipefail

NAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$NAS_DIR/.." && pwd)"

PKG="${PKG:-hongguoweb}"
ARCH="${ARCH:-x86_64}"
case "$ARCH" in
  x86_64) BIN_ARCH=amd64 ;;
  armv8)  BIN_ARCH=arm64 ;;
  *) echo "[!] ARCH 只支持 x86_64 / armv8，收到: $ARCH" >&2; exit 1 ;;
esac
case "$PKG" in
  hongguoweb)   DEFAULT_VERSION=1.0.0-2 ; DISPLAY_NAME="红果短剧" ;;
  ffmpeg-static) DEFAULT_VERSION=1.0.0-1 ; DISPLAY_NAME="FFmpeg (静态版)" ;;
  *) echo "[!] PKG 只支持 hongguoweb / ffmpeg-static，收到: $PKG" >&2; exit 1 ;;
esac

VERSION="${VERSION:-$DEFAULT_VERSION}"
DEFAULT_PORT=8788
BUILD_ROOT="${BUILD_ROOT:-$PROJECT_DIR/.nas-build}"
OUT_DIR="${OUT_DIR:-$PROJECT_DIR/dist}"
BIN="${BIN:-$BUILD_ROOT/bin/hongguoweb-$BIN_ARCH}"
FFMPEG_DIR="${FFMPEG_DIR:-$BUILD_ROOT/ffmpeg/$BIN_ARCH}"
WASM="${WASM:-$BUILD_ROOT/web/ffmpeg-core.wasm}"
ASSETS="$NAS_DIR/assets"
DEP_PKG="ffmpeg-static"

[ -f "$ASSETS/PACKAGE_ICON.PNG" ] || { echo "[!] 缺少图标，先运行 python nas/make-icons.py" >&2; exit 1; }

TARGET="$BUILD_ROOT/target-$PKG-$ARCH"
ASSEMBLE="$BUILD_ROOT/assemble-$PKG-$ARCH"
rm -rf "$TARGET" "$ASSEMBLE"
mkdir -p "$TARGET/bin" "$ASSEMBLE/conf" "$ASSEMBLE/scripts" "$OUT_DIR"

# ── 依赖工具函数 ──────────────────────────────────────────────────────────────
is_elf() {
  [ -f "$1" ] || return 1
  case "$(head -c 4 "$1" 2>/dev/null | od -An -c | tr -d ' \n')" in
    *177ELF*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$PKG" = "hongguoweb" ]; then
  # ── hongguoweb：服务端 + 前端 ────────────────────────────────────────────────
  [ -f "$BIN" ] || { echo "[!] 找不到二进制: $BIN" >&2; exit 1; }
  is_elf "$BIN" || { echo "[!] $BIN 不是 Linux ELF（是不是忘了 GOOS=linux？）" >&2; exit 1; }

  cp "$BIN" "$TARGET/bin/hongguoweb"
  chmod 755 "$TARGET/bin/hongguoweb"
  cp -a "$PROJECT_DIR/web/." "$TARGET/web_tmp/"
  mv "$TARGET/web_tmp" "$TARGET/web"
  find "$TARGET/web" -name '*.bak' -delete 2>/dev/null || true
  mkdir -p "$TARGET/web/assets/ffmpeg"
  if [ -f "$WASM" ]; then
    cp "$WASM" "$TARGET/web/assets/ffmpeg/ffmpeg-core.wasm"
    echo "  ✓ 内置 ffmpeg-core.wasm ($(du -h "$WASM" | cut -f1))"
  else
    echo "  ! 未内置 ffmpeg-core.wasm（$WASM 缺失）：浏览器直连播放不可用"
  fi
else
  # ── ffmpeg-static：只装 ffmpeg / ffprobe ─────────────────────────────────────
  is_elf "$FFMPEG_DIR/ffmpeg" || { echo "[!] $FFMPEG_DIR/ffmpeg 不存在或不是 ELF" >&2; exit 1; }
  is_elf "$FFMPEG_DIR/ffprobe" || { echo "[!] $FFMPEG_DIR/ffprobe 不存在或不是 ELF" >&2; exit 1; }
  cp "$FFMPEG_DIR/ffmpeg" "$TARGET/bin/ffmpeg"
  cp "$FFMPEG_DIR/ffprobe" "$TARGET/bin/ffprobe"
  chmod 755 "$TARGET/bin/ffmpeg" "$TARGET/bin/ffprobe"
  echo "  ✓ ffmpeg ($(du -h "$FFMPEG_DIR/ffmpeg" | cut -f1)) / ffprobe ($(du -h "$FFMPEG_DIR/ffprobe" | cut -f1))"
fi

# ── INFO ──────────────────────────────────────────────────────────────────────
{
  echo "package=\"${PKG}\""
  echo "version=\"${VERSION}\""
  if [ "$PKG" = "hongguoweb" ]; then
    echo "description=\"红果短剧 Web 客户端：推荐流 / 找剧 / 详情 / 弹幕 / 评论 / 直连播放的自托管播放器（需先安装 ${DEP_PKG}）。仅供个人学习研究。\""
    echo "install_dep_packages=\"${DEP_PKG}\""
  else
    echo "description=\"静态编译的 ffmpeg / ffprobe（供红果短剧等套件调用服务端中转/解码）。\""
  fi
  echo "arch=\"${ARCH}\""
  echo "maintainer=\"NeeYoonc\""
  echo "maintainer_url=\"https://github.com/NeeYoonc/hongguo-web-player\""
  echo "distributor=\"NeeYoonc\""
  echo "distributor_url=\"https://github.com/NeeYoonc/hongguo-web-player\""
  echo "os_min_ver=\"7.0-40000\""
  echo "reloadui=\"yes\""
  echo "displayname=\"${DISPLAY_NAME}\""
  echo "helpurl=\"https://github.com/NeeYoonc/hongguo-web-player\""
  echo "support_url=\"https://github.com/NeeYoonc/hongguo-web-player\""
  if [ "$PKG" = "hongguoweb" ]; then
    echo "dsmuidir=\"ui\""
    echo "dsmappname=\"SYNO.SDS.Hongguoweb.Application\""
    echo "changelog=\"[${VERSION}] 瘦身版：ffmpeg 改由依赖套件 ${DEP_PKG} 提供；内置 ffmpeg.wasm 浏览器直连解密\""
  else
    echo "changelog=\"[${VERSION}] 静态 ffmpeg/ffprobe；作为 hongguoweb 的前置依赖\""
  fi
  echo "checksum=\"\""
} > "$ASSEMBLE/INFO"

# ── conf ──────────────────────────────────────────────────────────────────────
sed "s/hongguoweb/${PKG}/g" "$ASSETS/conf/privilege" > "$ASSEMBLE/conf/privilege"
printf '{}' > "$ASSEMBLE/conf/resource"

# ── 图标 ──────────────────────────────────────────────────────────────────────
cp "$ASSETS/PACKAGE_ICON.PNG" "$ASSETS/PACKAGE_ICON_256.PNG" "$ASSEMBLE/"

# ── 各包专属：ui / 脚本 ───────────────────────────────────────────────────────
if [ "$PKG" = "hongguoweb" ]; then
  mkdir -p "$ASSEMBLE/ui/images"
  cp "$ASSETS/ui/images/"*.png "$ASSEMBLE/ui/images/"
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

  cat > "$ASSEMBLE/scripts/start-stop-status" <<'SSS_EOF'
#!/bin/sh
# 红果短剧 Web 客户端 · DSM 启停脚本
# ffmpeg/ffprobe 由依赖套件 ffmpeg-static 提供 → 把它的 bin 目录加进 PATH
PACKAGE_NAME="$SYNOPKG_PKGNAME"
BASE="/var/packages/${PACKAGE_NAME}/target"
VAR="/var/packages/${PACKAGE_NAME}/var"
DEP_BIN="/var/packages/ffmpeg-static/target/bin"
PID="$VAR/hongguoweb.pid"
LOG="$VAR/hongguoweb.log"
PORT_FILE="$VAR/ports"
DEFAULT_PORT=8788

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

do_start() {
  if is_running; then
    echo "已在运行 (pid $(cat "$PID"))"
    return 0
  fi
  mkdir -p "$VAR/data" "$VAR/cache" "$VAR/tmp" || return 1
  if [ -x "$DEP_BIN/ffmpeg" ]; then
    export PATH="$DEP_BIN:$BASE/bin:$PATH"
  else
    echo "[!] 依赖套件 ffmpeg-static 未安装（$DEP_BIN/ffmpeg 不存在）：服务端中转模式不可用" >&2
    export PATH="$BASE/bin:$PATH"
  fi
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
  chmod 755 "$ASSEMBLE/scripts/start-stop-status"

  # 安装向导（端口）+ 卸载向导
  mkdir -p "$ASSEMBLE/WIZARD_UIFILES"
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
else
  # ffmpeg-static：无 UI、无服务，仅提供 bin/
  cat > "$ASSEMBLE/scripts/start-stop-status" <<'SSS_EOF'
#!/bin/sh
# ffmpeg-static：纯工具包，无后台服务 → 启停均为空操作
case "$1" in
  start|stop|restart|status) exit 0 ;;
  *) exit 0 ;;
esac
SSS_EOF
  chmod 755 "$ASSEMBLE/scripts/start-stop-status"
fi

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
  chmod 755 "$BASE/bin" 2>/dev/null || true
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
  if [ -f "$BASE/web/index.html" ]; then
    write_ports
  fi
  exit 0
}

postupgrade() {
  setup_dirs
  if [ -f "$BASE/web/index.html" ]; then
    write_ports
  fi
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
    rm -rf "$VAR/data" "$VAR/cache" "$VAR/tmp" 2>/dev/null
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

# ── package.tgz + 外层 spk（用 Python tarfile 显式写权限位：Windows 上 tar 会丢 exec 位） ─
PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  for _p in python3 python; do
    # Windows 上 python3 可能是 Microsoft Store 占位符（能执行但什么都不做）→ 必须实测
    if command -v "$_p" >/dev/null 2>&1 && "$_p" -c 'import sys, tarfile' >/dev/null 2>&1; then
      PYTHON_BIN="$_p"
      break
    fi
  done
fi
[ -n "$PYTHON_BIN" ] || { echo "[!] 需要可用的 python3（含 tarfile）" >&2; exit 1; }

"$PYTHON_BIN" "$NAS_DIR/mktar.py" package "$TARGET" "$ASSEMBLE/package.tgz"
OUT_SPK="$OUT_DIR/${PKG}_${ARCH}-${VERSION}.spk"
rm -f "$OUT_SPK"
"$PYTHON_BIN" "$NAS_DIR/mktar.py" spk "$ASSEMBLE" "$OUT_SPK"

echo
echo "✓ 打包完成: $OUT_SPK"
echo "  包名: $PKG  架构: $ARCH  版本: $VERSION  大小: $(du -h "$OUT_SPK" | cut -f1)"
