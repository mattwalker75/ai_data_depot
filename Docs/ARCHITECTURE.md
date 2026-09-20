# Architecture

AI Data Depot is one Node.js process: an Express server that serves a static UI and a small
JSON/SSE API, a SQLite database, and a handful of modules under `src/`. No build step, no
framework on the front end, no external services beyond the model provider you choose.

```
browser ──HTTP/SSE──▶ server.js ──▶ src/chat.js ──▶ src/retrieval.js ──▶ SQLite (depot.sqlite)
                          │                 │                                  ▲
                          │                 └──▶ src/providers.js ──▶ OpenAI-compatible API
                          │                       (chat + embeddings)         (OpenAI, Ollama, …)
                          └──▶ src/indexer.js ──▶ src/extract.js (files) ─────┘
                                     └──────────▶ src/crawler.js (websites)
```

## Modules

| File | Responsibility |
| --- | --- |
| `server.js` | Routes, the local-only trust boundary (Host/Origin guard), SSE streams for chat and indexing progress, startup (watchers, scheduler, housekeeping). |
| `src/config.js` | `config.json`: defaults, deep-merge on load, atomic save (0600), key masking for the UI, which keys need a restart. |
| `src/db.js` | SQLite schema and migrations (`ALTER … ADD COLUMN`, idempotent), sqlite-vec loading with an in-process fallback, orphan-vector sweep. |
| `src/providers.js` | One client for every provider (OpenAI chat-completions + embeddings API). Streaming chat; embeddings with retry/backoff and adaptive batch size; model listing and status. |
| `src/extract.js` | File → pages of text: PDF (pdf.js; OCR via tesseract.js + @napi-rs/canvas for pages with no text), DOCX (mammoth), XLSX/CSV (SheetJS), PPTX (jszip), HTML (Readability), text/Markdown/JSON/RTF. |
| `src/chunk.js` | Text → overlapping passages, cut at paragraph → sentence → line → word boundaries. |
| `src/crawler.js` | Scoped BFS crawler: same origin; scope modes *section / linked / site / page*; robots.txt; polite delay; conditional requests; PDFs in scope; every same-site link kept with its text. |
| `src/indexer.js` | Jobs (one at a time, progress over an event emitter), file and website indexing, retry-failed, folder watching (bounded), scheduled website re-index, startup recovery and housekeeping. |
| `src/retrieval.js` | Hybrid search: sqlite-vec nearest neighbours + FTS5 keyword hits, fused by reciprocal rank, restricted to the enabled bundles. |
| `src/chat.js` | The grounded answer: persona + mode rules + numbered passages → model; citations parsed back out; the "How I answered" ledger; answer basis (sources / general / mixed / chat). |
| `src/personas.js`, `src/sessions.js` | Built-in + user personas (`data/personas.json`); sessions as one JSON file each (`data/sessions/`). |
| `src/documents.js` | Generated documents: types (what the model is told, shape, allowed formats), the request block the chat model hands over, intent detection, prose and two-pass tabular generation, the `outputs` table, OUTPUT/ files and retention. |
| `src/docmodel.js` | Markdown → typed blocks; client/cited variants; HTML and Markdown output of blocks. |
| `src/render.js` | Blocks/sheets → bytes: pdfkit, docx, SheetJS, text. |
| `src/backup.js` | Backup zips (bundle/source bookmarks, sessions, personas, config without keys — never files or the index) and the merge-only restore. |
| `public/` | `index.html` (shell + dialogs), `style.css` (theme tokens, one block per preset), `app.js` (all UI logic). |

## Data model (SQLite)

```
bundles ─┬─ sources ─┬─ documents ─┬─ chunks ─── chunks_fts (FTS5, external content)
         │           │             └─ chunk_vec (sqlite-vec vec0; chunk_id ↔ chunks.id)
         │           └─ options (JSON: website scope/depth)
         └─ enabled, description
jobs (indexing runs, pruned to the last 200)      meta (key/value: vec_dim, migration flags)
outputs (generated documents: title, type, format, basis, model JSON, files JSON, keep)
```

- `documents.locator` is the file path or URL; `content_hash` is SHA-1 of the extracted text, so an
  unchanged document is skipped without re-embedding. `documents.meta` holds a web page's ETag /
  Last-Modified and its same-site links (for conditional re-fetches).
- `documents.embed_model` records which embedding model built the document's vectors
  (`provider/model`); a document whose text is unchanged is still re-embedded when the current
  model differs, and `indexer.indexModels()` reports the mismatch to the UI.
- `chunks.embedding` (BLOB) is only populated when sqlite-vec is **not** available; otherwise the
  vector lives in `chunk_vec` only. `chunk_vec` has no foreign key, so `sweepOrphanVectors()` runs
  after jobs and deletions.
- Sessions and personas are deliberately files, not rows: a session is something you copy to a
  colleague; a persona is something you edit in a text editor.

## Request flow for a question

1. UI POSTs `/api/chat` with the message, history, persona, enabled bundle ids and mode.
2. `retrieval.search()` embeds the question (embedding provider), runs a vector KNN over `chunk_vec`
   and an FTS5 query over `chunks_fts`, fuses them (RRF), and loads the top `models.context_chunks`
   passages with their document and bundle. With `documentId` (ask about one document) both
   searches are restricted to that document and the vector side ranks all of its chunks exactly.
3. `chat.answer()` builds the system prompt: persona → mode rules (sources-first or sources-only)
   → numbered `SOURCES` block; appends trimmed history and the message; streams the model's reply
   as SSE `token` events.
4. On completion it extracts the `[n]` citations actually used, decides the answer's basis, and
   emits a `done` event with text, citations (with excerpt and locator) and the ledger.

## Indexing flow

Files: walk the folder (supported extensions only) → for each file, skip if size+mtime unchanged
→ `extractFile` → `chunkPages` → `providers.embed` (batched, retried) → one transaction writing
the document, its chunks, FTS rows and vectors. Websites: `crawler.crawl()` per source with its
scope → each page (HTML or PDF) goes through the same store path with a trailing "Links on this
page" passage. Every job first makes one tiny embedding call (`assertEmbeddingReady`) and refuses
if it fails, so nothing is read for nothing.

## The Evidence page view

A cited PDF page is rendered in the browser by pdf.js (served from the npm package at
`/vendor/pdfjs/`) from `GET /api/documents/:id/file`; highlight boxes come from the page's
text items matched by word overlap against the cited passage. The server can rasterise a page
too (`/api/documents/:id/page/:n`), but only as a fallback: Node has no system fonts, so a PDF
that does not embed its fonts renders without text there.

## Trust boundary

Single user, local machine, no login. What stands in for authentication: the server binds to
`127.0.0.1` by default; every request's `Host` must name this machine (defeats DNS rebinding);
state-changing requests must be same-origin (`Sec-Fetch-Site` / `Origin`); `/api/open` will only
open something that is in the index. See [SECURITY.md](SECURITY.md).
