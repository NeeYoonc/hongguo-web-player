#!/bin/sh
# 停止红果短剧 Web 客户端（含守护进程）
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
PID="$DIR/server.pid"
SUP="$DIR/supervisor.pid"
if [ -f "$SUP" ] && kill -0 "$(cat "$SUP")" 2>/dev/null; then
  kill "$(cat "$SUP")" 2>/dev/null
fi
if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  kill "$(cat "$PID")" 2>/dev/null
fi
sleep 1
pkill -x hongguoweb 2>/dev/null
rm -f "$PID" "$SUP"
echo "已停止"
