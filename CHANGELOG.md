# Changelog

All notable changes to AI Data Depot are tracked here (Keep a Changelog style).

## [Unreleased]

### Changed
- 2026-09-19: **Round-2 UI tweaks.** (1) The Reading-from and Evidence drawers
  now belong to Chat only — Sources, Personas, Sessions and Settings use the
  full width. (2) The persona in use carries an "Active — in use for chat"
  label and a thick accent outline. (3) **Custom colour themes**: Settings →
  Appearance has an editor (start from any preset, thirteen named colours,
  dark/light, live preview) that saves themes into `config.json`
  (`appearance.custom_themes`); custom themes appear beside the presets and
  can be edited or deleted. (4) Adding a folder or file uses a file-dialog
  style picker — Places sidebar, breadcrumbs, an editable path, a table with
  kind, size and modified date, double-click to open. New bundle and Add
  website are proper dialogs too (no more browser `prompt()` popups), with
  errors shown inline. (5) **Indexing is now a deliberate step**: adding a
  source no longer indexes it automatically. Each dialog offers "Index right
  away"; otherwise the source shows an **Index** button, and Chat shows a
  banner when an enabled bundle has sources the assistant cannot read yet.
  To be clear about what indexing is: it is not a speed-up — it is how the
  assistant reads a source at all. Until a source is indexed, it is invisible
  to answers, and the app now says so rather than implying otherwise.

### Fixed
- 2026-09-19: **Adding a large folder crashed the app** (`EMFILE: too many open
  files, watch`): live folder watching asks macOS for a file descriptor per
  sub-folder, and an unhandled watcher error killed the process. A source with
  more than 1,500 folders is no longer watched live (it is still indexed on
  demand and on the schedule, and the log says so); watcher errors stop
  watching that one source instead of the server; uncaught errors are logged,
  not fatal; and on startup, jobs and sources left "running"/"indexing" by a
  crash are reset so they can be run again.

### Fixed
- 2026-09-19: The right drawer's handle vanished when that drawer was collapsed —
  it was positioned half outside the window, leaving a 7px sliver and no way to
  reopen the Evidence drawer. Collapsed handles now stay fully on-screen on both
  sides, matching the left.
- 2026-09-19: The right drawer handle rendered as a full-height pale stripe with
  no pill: its side class `r` collided with the `r` class of the citation
  badges and inherited their styling. Handle classes renamed.
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
