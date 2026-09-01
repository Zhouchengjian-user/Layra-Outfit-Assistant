#!/bin/bash
# Layra dev 服务器守护脚本：崩溃后自动重启
# 用法：bash scripts/keep-dev-alive.sh
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="/tmp/yida-dev.log"

cd "$PROJECT_DIR"

while true; do
  if ! curl -s -o /dev/null -m 3 http://localhost:3001 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] server down, restarting..." >> "$LOG"
    pkill -f "next dev" 2>/dev/null
    pkill -f "npm run dev" 2>/dev/null
    sleep 2
    nohup npm run dev >> "$LOG" 2>&1 &
  fi
  sleep 10
done
