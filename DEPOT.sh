#!/usr/bin/env bash
# AI Data Depot — start / stop / status / logs. Runs the local server in the
# background and opens the browser. Configuration lives in config.json.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$HERE"
PIDFILE="$HERE/data/depot.pid"; LOG="$HERE/data/depot.log"; mkdir -p "$HERE/data"
port() { node -e "try{const c=require('./config.json');console.log((c.server&&c.server.port)||8300)}catch{console.log(8300)}" 2>/dev/null; }
running() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
case "${1:-start}" in
  start)
    if running; then echo "Already running (pid $(cat "$PIDFILE")) — http://localhost:$(port)"; exit 0; fi
    command -v node >/dev/null || { echo "Node.js 20+ is required (https://nodejs.org)."; exit 1; }
    [[ -d node_modules ]] || { echo "Installing dependencies (first run)…"; npm install --no-audit --no-fund >/dev/null; }
    nohup node server.js >> "$LOG" 2>&1 & echo $! > "$PIDFILE"
    for _ in $(seq 1 30); do curl -fsS "http://localhost:$(port)/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
    echo "AI Data Depot is running — http://localhost:$(port)   (log: $LOG)";;
  stop)   running && { kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; echo "Stopped."; } || echo "Not running.";;
  restart) "$0" stop; sleep 1; "$0" start;;
  status) running && echo "Running (pid $(cat "$PIDFILE")) — http://localhost:$(port)" || echo "Not running.";;
  logs)   tail -n 60 -f "$LOG";;
  fg)     exec node server.js;;
  *) echo "Usage: ./DEPOT.sh {start|stop|restart|status|logs|fg}"; exit 2;;
esac
