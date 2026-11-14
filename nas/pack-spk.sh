#!/usr/bin/env bash
#===============================================================================
# 红果短剧 Web 客户端 → 群晖 DSM 7 SPK 打包脚本
#
# 用法（Linux / macOS / Git-Bash 均可）：
#   ARCH=x86_64 VERSION=1.0.0-1 \
#   BIN=path/to/hongguoweb-amd64 \
#   FFMPEG_DIR=path/to/ffmpeg-amd64-dir \
#   WASM=path/to/ffmpeg-core.wasm \
#   ./nas/pack-spk.sh
#
#   ARCH          x86_64 | armv8（DSM 架构名）
#   VERSION       INFO 版本号，形如 1.0.0-1（默认 1.0.0-1）
#   BIN           已编译的 linux 二进制（不传则用 $BUILD_ROOT/bin/hongguoweb-<arch>）
#   FFMPEG_DIR    含 ffmpeg / ffprobe 的目录（不传则用 $BUILD_ROOT/ffmpeg/<arch>；
#                 目录不存在时不内置 ffmpeg —— 服务端中转模式不可用，浏览器直连播放仍可用）
#   WASM          ffmpeg-core.wasm 路径（不传则用 $BUILD_ROOT/web/ffmpeg-core.wasm；
#                 缺失时直连播放不可用 —— 仅服务端中转可用）
#   OUT_DIR       产物目录（默认 $PROJECT_DIR/dist）
#
# 产物：$OUT_DIR/hongguoweb_<DSM架构>-<版本>.spk
#===============================================================================
set -euo pipefail

NAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$NAS_DIR/.." && pwd)"

ARCH="${ARCH:-x86_64}"
case "$ARCH" in
  x86_64) BIN_ARCH=amd64 ;;
  armv8)  BIN_ARCH=arm64 ;;
  *) echo "[!] ARCH 只支持 x86_64 / armv8，收到: $ARCH" >&2; exit 1 ;;
esac

VERSION="${VERSION:-1.0.0-1}"
APP_NAME="hongguoweb"
DISPLAY_NAME="红果短剧"
DEFAULT_PORT=8788
BUILD_ROOT="${BUILD_ROOT:-$PROJECT_DIR/.nas-build}"
OUT_DIR="${OUT_DIR:-$PROJECT_DIR/dist}"
BIN="${BIN:-$BUILD_ROOT/bin/hongguoweb-$BIN_ARCH}"
FFMPEG_DIR="${FFMPEG_DIR:-$BUILD_ROOT/ffmpeg/$BIN_ARCH}"
WASM="${WASM:-$BUILD_ROOT/web/ffmpeg-core.wasm}"
ASSETS="$NAS_DIR/assets"

[ -f "$BIN" ] || { echo "[!] 找不到二进制: $BIN" >&2; exit 1; }
case "$(head -c 4 "$BIN" 2>/dev/null | od -An -c | tr -d ' \n')" in
  *177ELF*) : ;;
  *) echo "[!] $BIN 不是 Linux ELF 可执行文件（是不是忘了 GOOS=linux？）" >&2; exit 1 ;;
esac
[ -f "$ASSETS/PACKAGE_ICON.PNG" ] || { echo "[!] 缺少图标，先运行 python nas/make-icons.py" >&2; exit 1; }

TARGET="$BUILD_ROOT/target-$ARCH"
ASSEMBLE="$BUILD_ROOT/assemble-$ARCH"
rm -rf "$TARGET" "$ASSEMBLE"
mkdir -p "$TARGET/bin" "$TARGET/web" "$ASSEMBLE/conf" "$ASSEMBLE/scripts" \
         "$ASSEMBLE/ui/images" "$ASSEMBLE/WIZARD_UIFILES" "$OUT_DIR"

# ── target：bin/ + web/ ────────────────────────────────────────────────────────
cp "$BIN" "$TARGET/bin/hongguoweb"
chmod 755 "$TARGET/bin/hongguoweb"
if [ -x "$FFMPEG_DIR/ffmpeg" ] || [ -f "$FFMPEG_DIR/ffmpeg" ]; then
  cp "$FFMPEG_DIR/ffmpeg" "$TARGET/bin/ffmpeg"
  chmod 755 "$TARGET/bin/ffmpeg"
  echo "  ✓ 内置 ffmpeg ($(du -h "$TARGET/bin/ffmpeg" | cut -f1))"
else
  echo "  ! 未内置 ffmpeg（$FFMPEG_DIR 缺失）：服务端中转模式不可用"
fi
if [ -f "$FFMPEG_DIR/ffprobe" ]; then
  cp "$FFMPEG_DIR/ffprobe" "$TARGET/bin/ffprobe"
  chmod 755 "$TARGET/bin/ffprobe"
  echo "  ✓ 内置 ffprobe ($(du -h "$TARGET/bin/ffprobe" | cut -f1))"
fi

cp -a "$PROJECT_DIR/web/." "$TARGET/web/"
find "$TARGET/web" -name '*.bak' -delete 2>/dev/null || true
mkdir -p "$TARGET/web/assets/ffmpeg"
if [ -f "$WASM" ]; then
  cp "$WASM" "$TARGET/web/assets/ffmpeg/ffmpeg-core.wasm"
  echo "  ✓ 内置 ffmpeg-core.wasm ($(du -h "$WASM" | cut -f1))"
else
  echo "  ! 未内置 ffmpeg-core.wasm（$WASM 缺失）：浏览器直连播放不可用"
fi

# ── INFO ──────────────────────────────────────────────────────────────────────
cat > "$ASSEMBLE/INFO" <<EOF
package="${APP_NAME}"
version="${VERSION}"
description="红果短剧 Web 客户端：推荐流 / 找剧 / 详情 / 弹幕 / 评论 / 直连播放的自托管播放器。仅供个人学习研究。"
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
changelog="[${VERSION}] 红果短剧自托管播放器；内置 ffmpeg（服务端中转）+ ffmpeg.wasm（浏览器直连解密）"
checksum=""
EOF

# ── conf ──────────────────────────────────────────────────────────────────────
cp "$ASSETS/conf/privilege" "$ASSEMBLE/conf/privilege"
printf '{}' > "$ASSEMBLE/conf/resource"

# ── 图标 ──────────────────────────────────────────────────────────────────────
cp "$ASSETS/PACKAGE_ICON.PNG" "$ASSETS/PACKAGE_ICON_256.PNG" "$ASSEMBLE/"
cp "$ASSETS/ui/images/"*.png "$ASSEMBLE/ui/images/"

# ── ui/config（门户入口；port 由 postinst 按向导值改写） ──────────────────────
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

# ── scripts/start-stop-status ────────────────────────────────────────────────
cat > "$ASSEMBLE/scripts/start-stop-status" <<'SSS_EOF'
#!/bin/sh
# 红果短剧 Web 客户端 · DSM 启停脚本
PACKAGE_NAME="$SYNOPKG_PKGNAME"
BASE="/var/packages/${PACKAGE_NAME}/target"
VAR="/var/packages/${PACKAGE_NAME}/var"
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
  PORT=$(resolve_port)
  export PATH="$BASE/bin:$PATH"
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

# ── scripts/installer + 生命周期钩子 ─────────────────────────────────────────
cat > "$ASSEMBLE/scripts/installer" <<'INSTALLER_EOF'
#!/bin/sh
# 红果短剧 Web 客户端 · 安装期逻辑（被各 hook 脚本 source 后调用）
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
cat > "$ASSEMBLE/WIZARD_UIFILES/install_uifile_chs" <<'WIZ_EOF'
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
cat > "$ASSEMBLE/WIZARD_UIFILES/uninstall_uifile_chs" <<'WIZ_EOF'
[{
  "step_title": "卸载套件",
  "items": [{
    "type": "singleselect",
    "desc": "保留或删除套件数据。",
    "subitems": [{
      "key": "wizard_keep_data",
      "desc": "<b>仅卸载。</b>保留数据以备将来重新安装。",
      "defaultValue": true
    }, {
      "key": "wizard_delete_data",
      "desc": "<b style=\"color: red\">删除套件全部数据。（不可恢复！）</b>",
      "defaultValue": false
    }]
  }]
}]
WIZ_EOF

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
OUT_SPK="$OUT_DIR/${APP_NAME}_${ARCH}-${VERSION}.spk"
rm -f "$OUT_SPK"
"$PYTHON_BIN" "$NAS_DIR/mktar.py" spk "$ASSEMBLE" "$OUT_SPK"

echo
echo "✓ 打包完成: $OUT_SPK"
echo "  大小: $(du -h "$OUT_SPK" | cut -f1)  架构: $ARCH  版本: $VERSION"
