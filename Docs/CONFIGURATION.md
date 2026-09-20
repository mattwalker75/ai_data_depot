# Configuration — `config.json`

Everything the tool can be told lives in one file next to the app, `config.json`, created from
`config.template.json` on first start. Edit it with a text editor or through **Settings** in the
app — both write the same file. Keys beginning with `_` are notes and are ignored.

Changes apply immediately except **`server.port`, `server.host` and `data_dir`**, which take
effect after `./DEPOT.sh --restart`; the app says so when you change them.

## `server`

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `8300` | Port the app listens on. |
| `host` | `127.0.0.1` | `127.0.0.1` = this computer only. `0.0.0.0` = any device on your network (then the Host guard accepts this machine's own addresses). |
| `open_browser` | `true` | Open the browser on start. `DEPOT_NO_OPEN=1` overrides. |

## `data_dir`

Where the database, sessions, personas and OCR data live (`./data` by default, relative to the
app). The folder is gitignored.

## `models`

| Key | Meaning |
| --- | --- |
| `active` | Which provider answers chat and (by default) builds the index. |
| `providers.<name>` | `label`, `base_url`, `api_key`, `chat_model`, `embedding_model`, `local` (true = nothing leaves the machine; shown as the privacy badge). Any OpenAI-compatible endpoint works — add a new entry under `custom` or a new name. |
| `temperature`, `max_tokens` | Passed to the chat model. `max_tokens` is sent under that name; a model that answers 400 asking for `max_completion_tokens` gets a retry with the new name, remembered for that provider/model until restart. |
| `context_chunks` | Passages handed to the model per answer (12). Lower it for small local context windows. |
| `request_timeout_ms` | Per request. |

Shipped providers: `ollama` (`http://localhost:11434/v1`), `lmstudio`, `openai`, `anthropic` (via
its OpenAI-compatible endpoint; no embedding model — see `embeddings.fallback_provider`),
`openrouter`, `groq`, `custom`.

## `embeddings`

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `active` | `active` = follow `models.active`; or name a provider to always embed there. |
| `fallback_provider` | `ollama` | Used when the chosen provider has no embedding model. |
| `batch_size` | `32` | Texts per embedding request. The client halves it automatically when a provider answers "request too large". |

Changing the embedding model changes the vector space. Each document records the model that
embedded it; when the current model differs, the app shows a banner with a *Re-index everything*
button, and re-indexing re-embeds unchanged files too.

## `indexing.files`

| Key | Default | Meaning |
| --- | --- | --- |
| `watch` | `true` | Index new and changed files as they appear. Folders with more than 1,500 sub-folders are not watched (see [ARCHITECTURE](ARCHITECTURE.md)); use Re-index. |
| `ocr` | `true` | Read scanned PDF pages with OCR. First use downloads ~15 MB of English data into `data/tessdata`. |
| `ocr_min_chars_per_page` | `40` | A page with fewer extractable characters is OCR'd. |
| `max_file_mb` | `50` | Larger files are skipped (reported per document). |
| `chunk_chars` / `chunk_overlap_chars` | `2800` / `300` | Passage size and overlap. |
| `extensions` | text, md, html, pdf, docx, xlsx, xls, csv, tsv, json, pptx, rtf, eml, msg, png, jpg, jpeg, webp, bmp, gif | File types indexed. Images need `ocr` on. An existing `config.json` keeps its own list — add the new types in Settings → Indexing · Files if you want them. |

## `indexing.websites`

| Key | Default | Meaning |
| --- | --- | --- |
| `max_pages_per_site` | `500` | Hard cap per website source, every scope mode. |
| `max_depth` | `6` | Link depth for *section* and *site* scopes (*linked* uses the source's own hops). |
| `recheck_hours` | `24` | Re-index websites this often (0 = never). |
| `delay_ms` | `1000` | Pause between requests to the same site. |
| `respect_robots` | `true` | Honour robots.txt. |
| `timeout_ms`, `user_agent` | | Per request. |

Per-source scope (set when adding a website, editable on its row): `linked` (default; same site,
N hops from the page), `section` (under the page's path), `site`, `page`.

## `output`

| Key | Default | Meaning |
| --- | --- | --- |
| `dir` | `./OUTPUT` | Where generated documents are written (relative to `config.json`). |
| `keep_days` | `30` | At startup, files of documents older than this are deleted unless marked Keep. Only app-generated files are touched. Also in Settings → General. |
| `auto_preview` | `true` | Open the preview window as soon as a file is created. Off = just the card under the reply; Preview still opens it. Settings → General. |
| `context_chunks` | `24` | Passages retrieved for a prose document (a memo needs more than a chat answer). |
| `max_documents` | `12` | Documents examined, one at a time, when building a table or comparison. |

See [DOCUMENTS.md](DOCUMENTS.md).

## `appearance`

`theme`: `harbor-light`, `harbor-dark`, `reading-room`, `ledger`, `graphite`, `system`, or the id of
a custom theme. `custom_themes`: array of `{ id, name, dark, tokens: { bg, panel, ink, mute, line,
acc, accInk, accSoft, accText, nav, navtxt, user, mark } }` — Settings → Appearance edits these.

## `chat`

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `sources-first` | Default for new sessions: `sources-first` (converse; cite sources when they answer; label general knowledge) or `sources-only` (refuse anything unsupported). The Chat header switch overrides per session. |
| `show_reasoning_ledger` | `true` | The folded "How I answered" under each reply. |
| `not_found_phrase` | `Not in your sources` | What sources-only answers begin with when nothing supports them. |
| `general_marker` | `From general knowledge, not your sources:` | The label the model must put in front of general-knowledge answers. |

## Environment variables

`DEPOT_CONFIG` (path to a different config.json — used by the test harness), `DEPOT_NO_OPEN=1`,
`PORT`, `HOST`.
