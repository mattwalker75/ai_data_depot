# HTTP API

All endpoints are JSON unless noted; errors are `{ "error": "plain-English message" }` with
status 400 (or 421/403 from the trust boundary — see [SECURITY](SECURITY.md)). The UI is
the only intended client, but everything is callable with `curl` from the same machine.

## State

| Method & path | Purpose |
| --- | --- |
| `GET /api/state` | Everything the UI needs at once: bundles (with sources and counts), personas, sessions list, redacted config, meta (version, paths, sqlite-vec), model status, indexing readiness. |
| `GET /api/health` | `{ ok, version }`. |

## Bundles & sources

| Method & path | Body / notes |
| --- | --- |
| `POST /api/bundles` | `{ name, description? }` |
| `PATCH /api/bundles/:id` | any of `name`, `enabled`, `description` |
| `DELETE /api/bundles/:id` | removes its sources, documents, chunks and vectors |
| `GET /api/bundles/:id/documents` | indexed documents with status and error |
| `POST /api/sources` | `{ bundle_id, kind: "path" \| "website", locator, options?: { scope, depth }, index?: true }` — `index` must be exactly `true` to queue a job |
| `PATCH /api/sources/:id` | `{ options }` — a scope change forgets conditional-request data so the next index re-reads |
| `POST /api/sources/:id/index` | queue an index job for this source |
| `POST /api/sources/:id/retry-failed` | re-read only the documents that errored |
| `GET /api/sources/:id/errors` | errors grouped by reason `{ groups: [{ reason, count, files }] }` |
| `DELETE /api/sources/:id` | |
| `GET /api/chunks/:id` | one passage (used by the Evidence drawer) |

## Files

| Method & path | Body / notes |
| --- | --- |
| `POST /api/fs/browse` | `{ path? }` → `{ path, parent, home, shortcuts, entries: [{ name, dir, size, mtime, ext, supported }] }` |
| `POST /api/open` | `{ locator }` — opens an **indexed** file or page with the desktop's default app |

## Indexing

| Method & path | Notes |
| --- | --- |
| `GET /api/index/ready` | `{ ready, error? }` — one tiny embedding call against the embedding provider |
| `POST /api/index/files` | queue all folder sources of enabled bundles |
| `POST /api/index/websites` | queue all website sources |
| `POST /api/index/stop` | stop after the current item → `{ was_running }` |
| `GET /api/index/jobs` | current job + recent history |
| `GET /api/index/events` | **SSE**: `hello` (current state on connect), then `job` events `{ id, status, done, total, note, eta_s… }` |

## Models & settings

| Method & path | Notes |
| --- | --- |
| `GET /api/models/status` | reachability of the active provider |
| `GET /api/models/list` | models the active provider offers |
| `GET /api/settings` | redacted config (API keys masked) |
| `PUT /api/settings` | partial object, deep-merged; masked keys are ignored (unchanged); returns `{ restart_required: [...] }` for port/host/data_dir |
| `POST /api/settings/reload` | re-read `config.json` from disk (after editing it by hand) |
| `GET /api/maintenance/stats` | `{ db_bytes, documents, chunks, bundles, vec }` |
| `POST /api/maintenance/compact` | housekeeping + `VACUUM` → `{ before, after }` bytes; refused while a job runs |

## Personas & sessions

| Method & path | Notes |
| --- | --- |
| `GET /api/personas`, `POST /api/personas`, `PUT /api/personas/:id`, `DELETE /api/personas/:id` | built-ins are read-only |
| `GET /api/sessions`, `GET /api/sessions/:id`, `PUT /api/sessions/:id`, `DELETE /api/sessions/:id` | one JSON file each |
| `POST /api/sessions/import` | body = an exported session JSON |
| `GET /api/sessions/:id/export?format=json\|md` | download |

## Chat

`POST /api/chat` — `{ message, history, persona, bundle_ids, mode }` → **SSE**:
`token { text }` repeated, then `done { text, citations, ledger, basis, mode }`, or `error { message }`.
The connection closing on the client side aborts the model request.
