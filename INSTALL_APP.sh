#!/usr/bin/env bash
#
# INSTALL_APP.sh — set up AI Data Depot on this computer.
#
# What the tool needs:
#   REQUIRED  Node.js 20 or newer (npm comes with it). Everything else the app
#             uses is an npm package — no other system software. PDF text, OCR of
#             scanned pages, Word/Excel/PowerPoint reading are all pure npm.
#   OPTIONAL  Ollama, only if you want fully local models (nothing leaves the
#             machine). Any OpenAI-compatible cloud provider works without it.
#   OPTIONAL  Homebrew on macOS — the easiest way to install Node and Ollama.
#   NOTE      The first scanned PDF triggers a one-time ~15 MB download of the
#             English OCR data (cached under data/tessdata). Needs internet once.
#
# Usage:  ./INSTALL_APP.sh [flags…]
#
#   (no flags)      Check Node, install npm packages, create config.json, run the tests.
#   -o, --ollama    Also make sure Ollama is installed and running, and pull the
#                   models the default config expects (nomic-embed-text for the
#                   index + a chat model, see --model).
#   -m, --model M   Chat model to pull with --ollama (default: qwen3:8b).
#   -y, --yes       Don't ask before installing things with Homebrew.
#   -c, --check     Only report what is installed / missing; change nothing.
#   -h, --help      This help.
#
# Re-run any time (after pulling new code, for example). Safe to repeat.
# Then:  ./DEPOT.sh --start
#
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$HERE"
if [[ -t 1 ]]; then C_RESET=$'\033[0m'; C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[0;33m'; C_BLU=$'\033[0;34m'; else C_RESET=''; C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; fi
info() { echo "${C_BLU}==>${C_RESET} $*"; }; ok() { echo "${C_GRN}OK ${C_RESET} $*"; }; warn() { echo "${C_YEL}!! ${C_RESET} $*"; }; err() { echo "${C_RED}ERROR${C_RESET} $*" >&2; }
usage() { awk 'NR>=3 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"; }

WANT_OLLAMA=0; YES=0; CHECK_ONLY=0; CHAT_MODEL="qwen3:8b"; EMBED_MODEL="nomic-embed-text"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--ollama) WANT_OLLAMA=1 ;;
    -m|--model)  CHAT_MODEL="${2:-}"; [[ -n "$CHAT_MODEL" ]] || { err "--model needs a name"; exit 2; }; shift ;;
    -y|--yes)    YES=1 ;;
    -c|--check)  CHECK_ONLY=1 ;;
    -h|--help)   usage; exit 0 ;;
    *) err "Unknown option: $1"; echo; usage; exit 2 ;;
  esac; shift
done
confirm() { [[ $YES -eq 1 ]] && return 0; read -r -p "$1 [y/N] " a; [[ "$a" == y || "$a" == Y ]]; }
have() { command -v "$1" >/dev/null 2>&1; }
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

echo "AI Data Depot — install"; echo
# ---- Node.js
if have node && [[ "$(node_major)" -ge 20 ]]; then ok "Node.js $(node -v)"
else
  if have node; then warn "Node.js $(node -v) is too old — 20 or newer is required"; else warn "Node.js is not installed"; fi
  if [[ $CHECK_ONLY -eq 1 ]]; then :;
  elif have brew; then confirm "Install/upgrade Node.js with Homebrew (brew install node)?" && { brew install node || brew upgrade node; }
  else err "Install Node.js 20+ from https://nodejs.org (or install Homebrew, then: brew install node) and re-run."; exit 1; fi
  have node && [[ "$(node_major)" -ge 20 ]] && ok "Node.js $(node -v)" || { [[ $CHECK_ONLY -eq 1 ]] || { err "Node.js 20+ still not available."; exit 1; }; }
fi
# ---- npm packages
if [[ $CHECK_ONLY -eq 1 ]]; then [[ -d node_modules/express ]] && ok "npm packages installed" || warn "npm packages not installed"
else
  info "Installing npm packages…"
  if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null; else npm install --no-audit --no-fund >/dev/null; fi
  node -e "for (const m of ['express','better-sqlite3','sqlite-vec','pdfjs-dist','tesseract.js','@napi-rs/canvas','mammoth','xlsx','cheerio','chokidar']) require.resolve(m)" && ok "npm packages installed" || { err "A package failed to install — see the npm output above."; exit 1; }
fi
# ---- config.json
if [[ -f config.json ]]; then ok "config.json present"
elif [[ $CHECK_ONLY -eq 1 ]]; then warn "config.json will be created from config.template.json on first start"
else cp config.template.json config.json && ok "config.json created from config.template.json"; fi
# ---- Ollama (optional)
if have ollama; then
  if curl -fsS --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then ok "Ollama installed and running"; else warn "Ollama installed but not running"; [[ $CHECK_ONLY -eq 1 || $WANT_OLLAMA -eq 0 ]] || { info "Starting Ollama…"; (nohup ollama serve >/dev/null 2>&1 &); sleep 3; }; fi
else
  if [[ $WANT_OLLAMA -eq 1 && $CHECK_ONLY -eq 0 ]]; then
    if have brew; then confirm "Install Ollama with Homebrew (brew install ollama)?" && brew install ollama && { (nohup ollama serve >/dev/null 2>&1 &); sleep 3; }
    else err "Install Ollama from https://ollama.com/download and re-run with --ollama."; exit 1; fi
  else info "Ollama not installed (optional — only for local models; ./INSTALL_APP.sh --ollama sets it up)"; fi
fi
if [[ $WANT_OLLAMA -eq 1 && $CHECK_ONLY -eq 0 ]] && have ollama; then
  for m in "$EMBED_MODEL" "$CHAT_MODEL"; do
    if ollama list 2>/dev/null | awk '{print $1}' | grep -q "^${m}\(:latest\)\?$"; then ok "Ollama model $m present"; else info "Pulling Ollama model $m…"; ollama pull "$m" && ok "Pulled $m" || warn "Could not pull $m"; fi
  done
  node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.json'));c.models=c.models||{};c.models.active='ollama';c.models.providers=c.models.providers||{};c.models.providers.ollama=Object.assign(c.models.providers.ollama||{},{chat_model:process.argv[1],embedding_model:process.argv[2]});fs.writeFileSync('config.json',JSON.stringify(c,null,2)+'\n')" "$CHAT_MODEL" "$EMBED_MODEL" && ok "config.json: active provider ollama, chat $CHAT_MODEL, embeddings $EMBED_MODEL"
fi
# ---- tests
if [[ $CHECK_ONLY -eq 0 ]]; then info "Running the unit tests…"; node --test test/*.test.js >/dev/null 2>&1 && ok "Tests pass" || warn "Some tests failed — run ./DEPOT.sh --test to see"; fi
echo; echo "Next:  ./DEPOT.sh --start      (then Settings → Models to choose your model)"
