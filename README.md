# AI Data Depot

A local reference assistant for non-technical professionals. It answers questions
**only from the document folders and websites you enable**, cites every claim, and says
plainly when the answer isn't in your sources. Runs on your own computer; works with
cloud models (OpenAI and other OpenAI-compatible providers) or fully local ones (Ollama,
LM Studio), in which case nothing leaves the machine.

## Requirements

| | |
| --- | --- |
| **Required** | Node.js 20 or newer (npm comes with it). Everything else is an npm package — no other system software; PDF text, OCR of scanned pages and Word/Excel/PowerPoint reading are all pure npm. |
| **Optional** | [Ollama](https://ollama.com) for fully local models (nothing leaves the machine). Any OpenAI-compatible cloud provider works without it. |
| **Optional** | Homebrew on macOS — the easiest way to install Node and Ollama. |
| **Once** | The first scanned PDF downloads ~15 MB of English OCR data (cached in `data/tessdata`). |

## Quick start

```bash
./INSTALL_APP.sh            # checks Node, installs packages, creates config.json, runs the tests
./INSTALL_APP.sh --ollama   # …and sets up Ollama + pulls nomic-embed-text and a chat model (--model NAME)
./DEPOT.sh --start          # opens http://localhost:8300
```

`./DEPOT.sh --help` lists every flag: `-s/--start`, `-x/--stop`, `-r/--restart`, `-i/--status`,
`-l/--logs`, `-f/--fg`, `-c/--check`, `-t/--test`. Flags run in the order given (`./DEPOT.sh -x -s`);
bare words (`start`, `stop`, …) work too. `./INSTALL_APP.sh --help` likewise (`--check`, `--yes`).

## How it works

1. **Bundles** — group folders/files and websites into named bundles ("Federal tax code 2026",
   "Client · Henderson"). Each bundle is a checkbox: on, the assistant may read it; off, it may not.
2. **Indexing** — files (text, Markdown, HTML, PDF incl. scanned pages via OCR, Word, Excel, CSV,
   PowerPoint, JSON, RTF) and websites are split into passages and indexed (vector + keyword) in a
   local SQLite database. Folders are watched for new files; websites are re-checked on a schedule.
   Each website source has a **scope**: *linked pages* (the page and what it links to on the same
   site, N hops — the default), *this section* (everything under its address, e.g.
   `https://www.irs.gov/privacy-disclosure` covers `/privacy-disclosure/…`), *whole site*, or *this
   page only*. Other websites are never followed, translated copies (`/es/…`) are skipped, and
   every mode stops at the pages-per-website cap — this is deliberately not a search engine.
3. **Ask** — the best passages from the enabled bundles are handed to the model, which must cite them
   as `[1]`, `[2]`… Click a citation to see the exact passage in the Evidence drawer and open the
   file or page. "How I answered" under each reply lists what was searched, read and skipped.
4. **Personas** set voice and focus (Tax Specialist, Researcher, Legal, …); you can add your own. The
   source rules always apply on top.
5. **Sessions** are saved conversations — one per customer or matter. Save, load, export (`.json` to
   move between machines, `.md` to read), import.

## Configuration

Everything lives in `config.json` (created from `config.template.json` on first run). Edit it in a
text editor or in **Settings** — both write the same file. Port, listen address and data folder
take effect after a restart; the app tells you. API keys are stored in `config.json` (gitignored)
and shown masked in the UI.

| Section | What |
| --- | --- |
| `models` | Active provider; per-provider base URL, API key, chat model, embedding model. The embedding model follows the active provider; `embeddings.fallback_provider` covers providers without one (Anthropic). |
| `indexing.files` | Watch folders, OCR, size limit, passage size, file types. |
| `indexing.websites` | Pages per site (500), link depth, re-check interval, pause between pages, robots.txt. |
| `appearance.theme` | `harbor-light`, `harbor-dark`, `reading-room`, `ledger`, `graphite`, `system`. |
| `server` | `port` (8300), `host`, open the browser on start. |

## Layout

```
server.js        Express app + JSON/SSE API           public/        UI (no build step)
src/config.js    config.json load/merge/mask          src/extract.js file → text (PDF/OCR/Office)
src/db.js        SQLite schema, sqlite-vec            src/crawler.js scoped website crawler
src/indexer.js   jobs, watching, re-checks            src/retrieval.js hybrid vector + keyword search
src/chat.js      grounded answer + citations          src/personas.js src/sessions.js
data/            depot.sqlite, sessions/, personas.json, tessdata/   (gitignored)
```

Tests: `npm test`.
