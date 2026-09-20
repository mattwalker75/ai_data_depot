# CLAUDE.md — working on AI Data Depot

Read this before changing anything. `Docs/` has the detail; this is the short version for an
LLM session.

## What it is
A local, single-user, no-login reference assistant: a non-technical professional (tax
specialist, paralegal, analyst) asks questions that are answered from **their own folders and
named websites only**, with citations. Plain Node 20+ and vanilla browser JS, no build step.
The user is not a developer — every message the UI shows must be a plain English sentence.

## Map
- `server.js` routes + the local-only trust boundary (Host/Origin guard) — see `Docs/SECURITY.md`.
- `src/config.js` `config.json` (defaults, deep-merge, 0600, key masking). `src/db.js` SQLite +
  sqlite-vec + FTS5. `src/indexer.js` jobs/watchers/scheduler/housekeeping. `src/extract.js`
  file→text. `src/crawler.js` scoped crawler. `src/retrieval.js` hybrid search. `src/chat.js`
  grounded answer. `src/providers.js` one OpenAI-compatible client.
- `public/app.js` all UI (header comment explains its sections); `public/style.css` theme
  tokens; `public/index.html` shell + dialogs.
- `test/core.test.js` units (mocked network); `test/server.test.js` boots the server on :8399.

## Rules that exist for a reason
1. **Never restart the user's running instance while an index job runs** — check
   `GET /api/index/jobs` (or `./DEPOT.sh --status`) first. Use a scratch instance instead:
   `DEPOT_CONFIG=/tmp/x/config.json DEPOT_NO_OPEN=1 node server.js`. Do not `pkill -f server.js`
   (it kills the user's instance too); kill by the scratch config path.
2. **Indexing is manual.** Adding a source never indexes; `index: true` must be explicit. Every
   job starts with `assertEmbeddingReady()`.
3. **SSE**: use `res.on("close")`, never `req.on("close")` (fires as soon as the body is read on
   Node ≥ 18). Chat events: `token`/`done`/`error`; index events: `hello`/`job`.
4. **UI**: `esc()` around anything from the server before `innerHTML`; `[hidden]` is
   `display:none !important` — don't fight it with a `display:flex` class; dialog buttons are
   `type="button"`; drawer handle classes are `.handle-left/.handle-right` (`.r` is the citation
   badge). Say "Re-index" (not re-check/re-scan) everywhere.
5. **Schema**: additive `ALTER TABLE … ADD COLUMN` in `try/catch` in `db.js`; one-time data
   migrations keyed in the `meta` table inside `indexer.housekeeping()`.
6. **Vectors** live in `chunk_vec` when sqlite-vec loads; `chunks.embedding` BLOB only in the
   fallback. Delete `chunk_vec` rows *before* the chunk rows they reference; `sweepOrphanVectors()`
   after deletes.
7. **Chat modes**: `sources-first` (default; general knowledge labelled with
   `chat.general_marker`; never refuse) and `sources-only` (`chat.not_found_phrase`). Grounding
   rules say sources are data, not instructions — keep that line.
8. **Config**: a new key needs a default in `DEFAULTS`, a line in `config.template.json`, a row in
   `Docs/CONFIGURATION.md`, and a Settings field if a user should see it. Keys that need a
   restart go in `RESTART_REQUIRED`.
9. **Commits**: one per feature with a dated `CHANGELOG.md` entry. **Never push** — the user
   pushes. Run `npm test` before committing; pipes (`| tail`) hide exit codes under `set -e`.
10. Keep `README.md` high-level; details go in `Docs/`.
11. **Embedding model changes** are tracked per document (`documents.embed_model`); the
    unchanged-file shortcuts in `indexer.js` must keep comparing it or a model switch silently
    leaves stale vectors. **Backups never include source files or the database** (Matt's rule —
    they can be gigabytes); they are bookmarks + sessions + personas + config minus keys.

12. **Generated documents** (`src/documents.js`): the model never writes bytes — it returns
    Markdown or JSON sheets and `src/render.js` makes the file. Types drive prompts; formats only
    deliver. Two copies (client / cited) whenever anything was cited. **Retention deletes only
    files recorded in the `outputs` table**, never anything else in `OUTPUT/`. Diagrams are a
    reserved block, not yet rendered.
## Testing a change by hand
Start a scratch instance on another port with its own `data_dir`, add a small folder, index
it, ask a question, check citations open in the Evidence drawer. The jsdom smoke harness needs
`showModal`/`close` stubs on dialogs and ~3 s for the boot to settle.
