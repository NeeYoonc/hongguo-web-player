#!/bin/sh
# 红果短剧 Web 客户端启动脚本（带守护，群晖 NAS 常驻）
set -u
DIR=/volume1/AI/红果/client
LOG="$DIR/server.log"
PID="$DIR/server.pid"
SUP="$DIR/supervisor.pid"

if [ -f "$SUP" ] && kill -0 "$(cat "$SUP")" 2>/dev/null; then
  echo "守护进程已在运行 (pid $(cat "$SUP"))"
elif curl -s -m 2 http://127.0.0.1:8788/healthz >/dev/null 2>&1; then
  echo "端口 8788 已有服务在响应（非守护模式）"
  exit 0
else
  setsid "$DIR/supervise.sh" >/dev/null 2>&1 &
  echo $! > "$SUP"
fi

i=0
while [ "$i" -lt 15 ]; do
  if curl -s -m 2 http://127.0.0.1:8788/healthz >/dev/null 2>&1; then
    IP=$(ip route get 192.168.2.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
    [ -z "$IP" ] && IP=$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -vE '^(127\.|169\.254\.|172\.)' | head -1)
    echo "已启动: http://${IP:-127.0.0.1}:8788 (server pid $(cat "$PID" 2>/dev/null), supervisor $(cat "$SUP" 2>/dev/null))"
    exit 0
  fi
  i=$((i + 1)); sleep 1
done
echo "启动失败，请查看 $LOG"
exit 1
