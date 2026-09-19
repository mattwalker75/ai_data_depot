# Changelog

All notable changes to AI Data Depot are tracked here (Keep a Changelog style).

## [Unreleased]

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
