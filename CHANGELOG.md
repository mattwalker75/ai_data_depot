# Changelog

All notable changes to AI Data Depot are tracked here (Keep a Changelog style).

## [Unreleased]

### Fixed
- 2026-09-19: The right drawer's handle vanished when that drawer was collapsed —
  it was positioned half outside the window, leaving a 7px sliver and no way to
  reopen the Evidence drawer. Collapsed handles now stay fully on-screen on both
  sides, matching the left.
- 2026-09-19: Clicking a handle moved the handle but did not actually hide the
  drawer: the width is an inline CSS variable (remembered sizes), which beats
  the class rule that zeroed it. Collapse now sets the width to 0 outright.

### Added
- 2026-09-19: `DEPOT.sh` takes dash flags (`-s/--start`, `-x/--stop`, `-r/--restart`,
  `-i/--status`, `-l/--logs`, `-f/--fg`, `-c/--check`, `-t/--test`, `-h/--help`),
  runs them in the order given, accepts the bare words too, and prints its
  header as help. New `INSTALL_APP.sh`: checks/installs Node 20+ (Homebrew on
  macOS), installs npm packages (`npm ci`), creates `config.json`, runs the
  tests; `--ollama` also installs/starts Ollama and pulls `nomic-embed-text`
  plus a chat model (`--model`), `--check` reports without changing anything,
  `--yes` skips prompts. README gains a Requirements table: Node is the only
  required software; Ollama and Homebrew are optional.

### Added
- 2026-09-19: First working version. Bundles of folders/files and websites with
  per-bundle enable/disable; indexing of text, Markdown, HTML, PDF (with OCR for
  scanned pages), Word, Excel/CSV, PowerPoint, JSON and RTF into a local SQLite
  index (sqlite-vec + FTS5); a scoped website crawler (same host, under the root
  path, page cap, depth cap, robots.txt, polite delay, PDFs in scope) with
  scheduled re-checks; folder watching; grounded chat that answers only from the
  enabled bundles with numbered citations, an Evidence drawer showing the exact
  passage, and a folded "How I answered" ledger; a "Not in your sources" answer
  when the sources do not contain it; personas (built-ins + your own); sessions
  (save/load/import/export .json and .md); OpenAI-compatible providers (OpenAI,
  Anthropic, OpenRouter, Groq, LM Studio, Ollama, custom) with the embedding
  model following the active provider; a Settings screen backed by `config.json`
  (models, appearance presets incl. light/dark/system, file and website indexing
  as separate sections, general) with restart notices; resizable side drawers
  with edge handles; `DEPOT.sh` start/stop/status/logs.
