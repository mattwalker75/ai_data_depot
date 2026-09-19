#!/usr/bin/env bash
#
# DEPOT.sh — run AI Data Depot (the local reference assistant).
#
# Usage:  ./DEPOT.sh [flags…]     flags run in the order given, e.g.  ./DEPOT.sh -x -s
#
#   -s, --start     Start the server in the background and open the browser
#                   (installs npm packages on first run). Idempotent.
#   -x, --stop      Stop the background server.
#   -r, --restart   Stop, then start (needed after changing port/host/data folder).
#   -i, --status    Is it running? Prints the URL and process id.
#   -l, --logs      Follow the server log (Ctrl-C to leave).
#   -f, --fg        Run in the foreground instead (Ctrl-C to stop).
#   -c, --check     Check prerequisites (Node 20+, packages, config, Ollama) and exit.
#   -t, --test      Run the unit tests.
#   -h, --help      This help.
#
# Bare words work too:  ./DEPOT.sh start | stop | restart | status | logs | fg | check | test
#
# Examples:
#   ./DEPOT.sh                 start it (same as --start) and open the browser
#   ./DEPOT.sh -c              see whether Node, the packages, config.json and Ollama are in place
#   ./DEPOT.sh --restart       apply a new port or host from config.json
#   ./DEPOT.sh -x -s           stop, then start, in one go
#   ./DEPOT.sh --logs          watch what the server is doing (Ctrl-C to leave)
#   ./DEPOT.sh -t              run the unit tests
#
# Configuration is config.json next to this script (Settings in the app edits
# the same file). Port and host changes take effect after --restart.
# First-time setup on a fresh machine:  ./INSTALL_APP.sh
#
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$HERE"
mkdir -p "$HERE/data"; PIDFILE="$HERE/data/depot.pid"; LOG="$HERE/data/depot.log"
if [[ -t 1 ]]; then C_RESET=$'\033[0m'; C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[0;33m'; C_BLU=$'\033[0;34m'; else C_RESET=''; C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; fi
info() { echo "${C_BLU}==>${C_RESET} $*"; }; ok() { echo "${C_GRN}OK ${C_RESET} $*"; }; warn() { echo "${C_YEL}!! ${C_RESET} $*"; }; err() { echo "${C_RED}ERROR${C_RESET} $*" >&2; }
usage() { awk 'NR>=3 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"; }
port() { node -e "try{const c=require('./config.json');console.log((c.server&&c.server.port)||8300)}catch{console.log(8300)}" 2>/dev/null || echo 8300; }
url() { echo "http://localhost:$(port)"; }
running() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
node_ok() { command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]]; }

cmd_check() {
  local rc=0
  if node_ok; then ok "Node.js $(node -v)"; else err "Node.js 20+ is required — run ./INSTALL_APP.sh"; rc=1; fi
  if [[ -d node_modules/express ]]; then ok "npm packages installed"; else warn "npm packages missing — run ./INSTALL_APP.sh (or --start installs them)"; fi
  if [[ -f config.json ]]; then ok "config.json present (port $(port))"; else warn "config.json will be created from config.template.json on first start"; fi
  if command -v ollama >/dev/null 2>&1; then
    if curl -fsS --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then ok "Ollama running ($(curl -s http://localhost:11434/api/tags | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).models||[]).length))' 2>/dev/null) models)"; else warn "Ollama installed but not running — start it with:  ollama serve   (only needed for local models)"; fi
  else warn "Ollama not installed — fine if you use a cloud provider; for local models run ./INSTALL_APP.sh --ollama"; fi
  running && ok "AI Data Depot is running — $(url)" || info "AI Data Depot is not running"
  return $rc
}
cmd_start() {
  if running; then ok "Already running (pid $(cat "$PIDFILE")) — $(url)"; return 0; fi
  node_ok || { err "Node.js 20+ is required. Run ./INSTALL_APP.sh"; return 1; }
  [[ -d node_modules/express ]] || { info "Installing npm packages (first run)…"; npm install --no-audit --no-fund >/dev/null || { err "npm install failed"; return 1; }; }
  nohup node server.js >> "$LOG" 2>&1 & echo $! > "$PIDFILE"
  for _ in $(seq 1 40); do curl -fsS "$(url)/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
  if curl -fsS "$(url)/api/health" >/dev/null 2>&1; then ok "AI Data Depot is running — $(url)   (log: $LOG)"; else err "Did not come up — see $LOG"; tail -n 20 "$LOG"; rm -f "$PIDFILE"; return 1; fi
}
cmd_stop() { if running; then kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; ok "Stopped."; else info "Not running."; fi; }
cmd_status() { running && ok "Running (pid $(cat "$PIDFILE")) — $(url)" || info "Not running."; }
cmd_logs() { touch "$LOG"; tail -n 60 -f "$LOG"; }
cmd_fg() { running && { err "Already running in the background (pid $(cat "$PIDFILE")); stop it first: ./DEPOT.sh -x"; return 1; }; exec node server.js; }
cmd_test() { node --test test/*.test.js; }

[[ $# -eq 0 ]] && set -- --start
rc=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--start|start)     cmd_start   || rc=$? ;;
    -x|--stop|stop)       cmd_stop    || rc=$? ;;
    -r|--restart|restart) cmd_stop; sleep 1; cmd_start || rc=$? ;;
    -i|--status|status)   cmd_status  || rc=$? ;;
    -l|--logs|logs)       cmd_logs    || rc=$? ;;
    -f|--fg|fg)           cmd_fg      || rc=$? ;;
    -c|--check|check)     cmd_check   || rc=$? ;;
    -t|--test|test)       cmd_test    || rc=$? ;;
    -h|--help|help)       usage; exit 0 ;;
    *) err "Unknown option: $1"; echo; usage; exit 2 ;;
  esac
  shift
done
exit $rc
