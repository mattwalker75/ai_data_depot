# Development

## Run

```sh
./INSTALL_APP.sh          # once: Node check, npm ci, config.json from template (optionally Ollama)
./DEPOT.sh --fg           # foreground with logs; --start/--stop/--restart/--status/--logs otherwise
npm test                  # node --test test/*.test.js (no network; providers are mocked)
```

A second instance for experiments, without touching your own data:

```sh
DEPOT_CONFIG=/tmp/scratch/config.json DEPOT_NO_OPEN=1 node server.js   # config sets port + data_dir
```

Never restart the real instance while an index job runs (`GET /api/index/jobs`); stop it first.

## Layout

```
server.js            routes + trust boundary + startup
src/                 one module per concern (see Docs/ARCHITECTURE.md)
public/              index.html · style.css · app.js  (vanilla, no build)
test/                core.test.js (units) · server.test.js (boots the server on :8399; the e2e test also runs a fake provider on :8398) · fixtures/
Docs/                what you are reading
DEPOT.sh · INSTALL_APP.sh · config.template.json · CHANGELOG.md · CLAUDE.md
```

## Conventions

- **No build step, no framework.** Plain Node 20+, plain browser JS. Keep it that way; it is
  what lets a non-developer run it from a folder.
- **Errors are sentences.** Anything thrown from a route reaches the user as a toast, so phrase
  it for them ("That file is not on this computer any more."), not for you.
- **Escape at the edge.** `esc()` in `app.js` around every server/user string that goes into
  `innerHTML`. The Markdown renderer escapes first.
- **Schema changes** are `ALTER TABLE … ADD COLUMN` inside `try {} catch {}` in `src/db.js`
  (idempotent), plus a one-time data migration keyed on the `meta` table in
  `indexer.housekeeping()` when existing rows need touching.
- **Config keys** get a default in `src/config.js → DEFAULTS`, a line in `config.template.json`,
  a row in `Docs/CONFIGURATION.md` and, if a user should see it, a field in Settings.
- **Per-feature commits** with a `CHANGELOG.md` entry (Keep a Changelog). Matt pushes.
- **Tests** live in `test/`; `server.test.js` needs ports 8399 and 8398 free. Fixtures: `test/fixtures/` (a hand-built PDF, an `.eml`).

## Adding things

- **A file type**: `src/extract.js` (return `{ title, mime, pages: [{ text, label }] }`), add the
  extension to `DEFAULTS.indexing.files.extensions` and `supported()`.
- **A provider**: an entry under `models.providers` is usually enough (any OpenAI-compatible
  base URL). Only touch `src/providers.js` for a different wire format.
- **A persona**: `src/personas.js → BUILTIN`, or let users do it in the Personas page.
- **A setting section**: `public/app.js → renderSettings()`; keep one Save per card and PUT
  only that card's keys.

## Debugging

- Server log: `./DEPOT.sh --logs` (or the terminal with `--fg`). `[index]`, `[open]`,
  `[watch]`, `[sched]` prefixes.
- Indexing progress and errors: Sources page (badge on the rail while a job runs); per-source
  "N files could not be read" opens the grouped reasons.
- SSE in Node ≥ 18: listen on `res.on("close")`, not `req.on("close")` — the request stream
  closes as soon as the body is consumed.
- A `<button>` inside `<form method="dialog">` submits the dialog; give it `type="button"`.
