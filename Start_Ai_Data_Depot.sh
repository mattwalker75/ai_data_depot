#!/usr/bin/env bash
#
# Start_Ai_Data_Depot.sh — launcher for AI Data Depot as a desktop app.
#
# Turn it into a clickable macOS app with my_mac_app:
#
#   cd ~/Desktop/REPOs/my_mac_app
#   ./mk_mac_app.py --name "AI Data Depot" \
#                   --script ~/Desktop/REPOs/ai_data_depot/Start_Ai_Data_Depot.sh \
#                   --icon example_icons/books.png        # or --emoji 🗄️
#
# Behaviour:
#   • Starts the AI Data Depot server (in the foreground, output in LOG) and
#     opens it in a NEW dedicated browser window — its own window, never a
#     tab in your regular browser.
#   • Closing that window shuts the server down.
#   • If AI Data Depot is already running (say, started with ./DEPOT.sh),
#     the launcher just opens a window onto it and leaves it running when the
#     window is closed.
#   • The port comes from config.json (server.port), so changing it in
#     Settings is enough — nothing to edit here.
#
# ============================== CONFIG =======================================

APP_NAME="AI Data Depot"                          # used in messages/logs only
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # the app's directory: this script lives in it
START_CMD="DEPOT_NO_OPEN=1 ./DEPOT.sh --fg"       # foreground start; the launcher opens the window itself
STARTUP_TIMEOUT=60                                # seconds to wait for the server to come online
LOG="/tmp/ai_data_depot.log"                      # server output goes here
BROWSER_PROFILE_BASE="/tmp/ai_data_depot_browser" # per-launch browser profiles are created from this

# =========================== END CONFIG ======================================

set -u

# Unique profile per launch → the browser starts as a NEW instance with its
# own window instead of handing off to (a tab/window in) an existing one.
BROWSER_PROFILE="$BROWSER_PROFILE_BASE.$$"
APP_PID=""
REUSED=0   # 1 when a server was already running and we only opened a window

# =============================================================================
# environment_setup — pre-flight checks before anything starts.
# =============================================================================
environment_setup() {
  if [ ! -f "$REPO/server.js" ] || [ ! -f "$REPO/DEPOT.sh" ]; then
    echo "ERROR: $REPO does not look like the AI Data Depot folder (no server.js / DEPOT.sh)."
    echo "Keep this launcher inside the ai_data_depot folder, or edit REPO in it."
    exit 1
  fi
  if [ ! -d "$REPO/node_modules" ]; then
    echo "ERROR: packages are not installed. Run ./INSTALL_APP.sh in $REPO once."
    exit 1
  fi
  if [ ! -f "$REPO/config.json" ]; then
    echo "ERROR: config.json is missing. Run ./INSTALL_APP.sh in $REPO once (it creates it from the template)."
    exit 1
  fi
  # The port lives in config.json; fall back to the default if it cannot be read.
  PORT="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((c.server&&c.server.port)||8300)}catch(e){console.log(8300)}' "$REPO/config.json" 2>/dev/null || echo 8300)"
  URL="http://localhost:$PORT"

  # Clear any browser instances left over from previous launches and their
  # per-launch profile directories. Guarded so an empty BROWSER_PROFILE_BASE
  # can never turn the pkill/rm into something machine-wide.
  if [ -n "$BROWSER_PROFILE_BASE" ]; then
    pkill -f "user-data-dir=$BROWSER_PROFILE_BASE" 2>/dev/null && sleep 2
    rm -rf "$BROWSER_PROFILE_BASE".* 2>/dev/null
  fi
}

# =============================================================================
# find_browser — locate a Chromium-based browser (needed for the window-not-tab
# launch via --app and --user-data-dir). Sets CHROME, "" if none.
# =============================================================================
find_browser() {
  CHROME=""
  local path
  for path in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Arc.app/Contents/MacOS/Arc"; do
    if [ -x "$path" ]; then
      CHROME="$path"
      break
    fi
  done
}

# =============================================================================
# start_app — start the server unless one is already answering on the port.
# =============================================================================
start_app() {
  cd "$REPO" || exit 1
  if curl -sf -o /dev/null --max-time 2 "$URL/api/health"; then
    echo "$APP_NAME is already running at $URL — opening a window onto it."
    REUSED=1
    return
  fi
  echo "Starting $APP_NAME..."
  bash -c "$START_CMD" > "$LOG" 2>&1 &
  APP_PID=$!
}

# =============================================================================
# cleanup — runs on exit (the browser window was closed, an error, a signal).
# Stops the server this launch started; a server we merely reused is left alone.
# =============================================================================
cleanup() {
  echo ""
  if [ "$REUSED" -eq 1 ]; then
    echo "Window closed. $APP_NAME was already running before this launch and stays up (./DEPOT.sh --stop to stop it)."
  else
    echo "Shutting down $APP_NAME..."
    if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
      pkill -P "$APP_PID" 2>/dev/null || true
      kill "$APP_PID" 2>/dev/null || true
    fi
    # belt-and-suspenders: anything still bound to the port
    PORT_PIDS="$(lsof -ti :"$PORT" 2>/dev/null || true)"
    if [ -n "$PORT_PIDS" ]; then
      # shellcheck disable=SC2086
      kill $PORT_PIDS 2>/dev/null || true
      sleep 1
      # shellcheck disable=SC2086
      kill -9 $PORT_PIDS 2>/dev/null || true
    fi
    echo "Stopped."
  fi
  pkill -f "user-data-dir=$BROWSER_PROFILE" 2>/dev/null || true
  rm -rf "$BROWSER_PROFILE" 2>/dev/null
}

# =============================================================================
# wait_for_backend — block until the server answers, or fail with the log tail.
# =============================================================================
wait_for_backend() {
  [ "$REUSED" -eq 1 ] && return
  echo "Waiting for $URL ..."
  local online=0
  for _ in $(seq 1 "$STARTUP_TIMEOUT"); do
    if curl -sf -o /dev/null --max-time 2 "$URL/api/health"; then
      online=1
      break
    fi
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      echo "ERROR: $APP_NAME exited before coming online. Last log lines:"
      tail -n 40 "$LOG" || true
      exit 1
    fi
    sleep 1
  done
  if [ "$online" -ne 1 ]; then
    echo "ERROR: $URL did not respond within ${STARTUP_TIMEOUT}s. Last log lines:"
    tail -n 40 "$LOG" || true
    exit 1
  fi
}

# ============================== MAIN =========================================
# The browser runs in the FOREGROUND: the script parks there for the life of
# the window, and exiting fires the trap → cleanup(). The window IS the app.
# =============================================================================

environment_setup
find_browser
start_app
trap cleanup EXIT INT TERM HUP
wait_for_backend

if [ -n "${DEPOT_LAUNCHER_TEST:-}" ]; then
  # Test hook: stand in for the browser window for a few seconds, then leave.
  echo "TEST MODE: $APP_NAME is online at $URL (pid ${APP_PID:-reused}); closing in ${DEPOT_LAUNCHER_TEST}s."
  sleep "$DEPOT_LAUNCHER_TEST"
elif [ -n "$CHROME" ]; then
  echo "Opening $URL in a dedicated browser window..."
  echo "(Closing that window will stop the app.)"
  "$CHROME" \
    --app="$URL" \
    --user-data-dir="$BROWSER_PROFILE" \
    --no-first-run \
    --disable-background-mode \
    --no-default-browser-check
  # falls through to cleanup() via trap
else
  echo "No Chromium browser found — opening in your default browser."
  echo "The server keeps running until this script is stopped."
  open "$URL"
  if [ -n "$APP_PID" ]; then wait "$APP_PID"; fi
fi
