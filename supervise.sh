#!/bin/sh
# 红果短剧 Web 客户端守护脚本：崩溃/被杀后自动拉起，记录退出码
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
BIN="$DIR/server/hongguoweb"
LOG="$DIR/server.log"
PID="$DIR/server.pid"
SUP="$DIR/supervisor.pid"

echo $$ > "$SUP"
echo "$(date '+%Y/%m/%d %H:%M:%S') supervisor: start (pid $$)" >> "$LOG"
fail=0
while :; do
  GOMEMLIMIT=1600MiB GOGC=80 "$BIN" \
    -addr 0.0.0.0:8788 \
    -data "$DIR/data" \
    -web "$DIR/web" \
    -cache "$DIR/cache" >> "$LOG" 2>&1 &
  child=$!
  echo "$child" > "$PID"
  wait "$child"
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "$(date '+%Y/%m/%d %H:%M:%S') supervisor: server exited normally, stop supervising" >> "$LOG"
    break
  fi
  fail=$((fail + 1))
  [ "$fail" -gt 20 ] && fail=20
  delay=$((fail * 2))
  [ "$delay" -gt 20 ] && delay=20
  echo "$(date '+%Y/%m/%d %H:%M:%S') supervisor: server exited code=$code, restart in ${delay}s" >> "$LOG"
  sleep "$delay"
done
rm -f "$SUP"
