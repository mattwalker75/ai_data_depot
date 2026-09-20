# Changelog

All notable changes to AI Data Depot are tracked here (Keep a Changelog style).

## [Unreleased]

### Added
- 2026-09-20: `Start_Ai_Data_Depot.sh` — desktop-app launcher for my_mac_app:
  starts the server in the foreground, opens a dedicated browser window,
  stops the server when the window closes; reuses (and leaves running) an
  instance that is already up; reads the port from config.json.

### Fixed
- 2026-09-20: **File cards disappeared after a reload** when the file had
  been requested in chat or made with *File* on an earlier reply: saving the
  session replaced the message objects the file was about to attach to.
  Saving now keeps the same objects and only takes the server's id/time.
- 2026-09-20: *Copy* renumbers citations 1, 2, 3 in order of use instead of
  keeping the chat's internal numbers.
- 2026-09-20: A fresh install no longer logs "blob dedup skipped: no such
  table: chunk_vec" at every start.

### Fixed
- 2026-09-20: **The Evidence page view showed blank pages for many PDFs.** Pages
  were rasterised on the server, where pdf.js has no system fonts: PDFs that
  do not embed their fonts (most Word-made ones) drew no text at all, and a
  pdf.js option (`useSystemFonts`) hid text even for the rest. Pages are now
  rendered in the browser with pdf.js, with the same highlight boxes; the
  server render remains as a fallback and now draws standard-font PDFs.

### Added
- 2026-09-20: **Generated documents.** Ask in the chat for a memo, summary,
  checklist, spreadsheet, comparison or anything free-form ("write me a poem
  about flowers and save it as a PDF") and the file is made: the model hands
  the request to the app instead of writing it inline, the type drives the
  prompt and the retrieval (tables are built document by document in two
  passes), and the file is rendered with pdfkit / docx / SheetJS into
  `OUTPUT/`. Two copies whenever anything was cited — a clean client copy and
  a cited copy with a Sources section — previewed in the new **Files** tab of
  the right drawer with a download each; a card under the reply links to it.
  🗎 beside the composer is the same as a form; **File** under a reply saves
  that reply as-is; a "Make this a file?" button appears when a message
  clearly asked for one but the model did not hand it over. Files not marked
  Keep are deleted at startup after `output.keep_days` (30); only files the
  app generated are ever touched. Chat modes apply (Sources only refuses what
  the sources cannot support). New dependencies: `pdfkit`, `docx`.

### Fixed
- 2026-09-20: **"Unsupported parameter: 'max_tokens'… Use 'max_completion_tokens'".**
  Newer OpenAI models reject `max_tokens`. The first reply refused this way
  is retried with `max_completion_tokens` (same value), and that name is used
  for that provider/model for the rest of the run. Settings → Models says
  so under Max answer length, and reports when the switch has happened.

### Added
- 2026-09-20: **Ask about one document.** 📄 next to the composer picks a
  document from the enabled bundles (or *Ask about this* in the Evidence
  drawer); only that document is searched until the chip is cleared, the
  model is told it is answering about one document, and the ledger says so.
  Saved with the session.
- 2026-09-20: **Copy an answer with its sources** — hover a reply, *Copy*:
  Markdown with a numbered Sources list (title, page, path or address).
- 2026-09-20: **The page, not just the passage.** For a cited PDF the
  Evidence drawer renders the page with the cited text highlighted and lets
  you page through the document (`GET /api/documents/:id/page/:n`).
- 2026-09-20: **Emails and images as sources.** `.eml` and Outlook `.msg`
  (headers, body, attachment names; the subject is the title) and `.png`
  `.jpg` `.jpeg` `.webp` `.bmp` `.gif` (read with OCR). New installs get
  them by default; an existing config.json keeps its own list — add them in
  Settings → Indexing · Files.
- 2026-09-20: **Embedding-model mismatch warning.** Each document records
  the model that embedded it. Switching embedding models shows a banner in
  Chat and Sources naming both, with *Re-index everything*; re-indexing now
  re-embeds unchanged files too (before, the unchanged-file shortcut kept
  the old vectors).
- 2026-09-20: **Backups.** Settings → General → *Back up now* writes a small
  zip (bundles and where their sources live — bookmarks, not copies —
  sessions, personas, settings without API keys) to `data/backups/`, with
  download, delete and *Restore from a backup…* (merge-only). Source files
  and the index are deliberately never included.

### Security
- 2026-09-20: **Local trust boundary.** Every request must carry a `Host`
  naming this machine (defeats DNS rebinding — a web page cannot reach the
  API through a hostname it controls), and state-changing requests must be
  same-origin (`Sec-Fetch-Site` / `Origin`), so another site in your browser
  cannot POST here. `/api/open` opens only files and pages that are in the
  index — never an arbitrary path. `config.json` (API keys) is written with
  owner-only permissions. The grounding rules tell the model that quoted
  sources are information, not instructions. See `Docs/SECURITY.md`.

### Changed
- 2026-09-20: **Storage.** Embeddings were stored twice (a BLOB on every
  chunk *and* the sqlite-vec row); with sqlite-vec loaded the BLOB is no
  longer written and existing duplicates are dropped once at startup (a
  10,000-document index shrinks from 2.8 GB to 1.8 GB after **Settings →
  General → Compact the database**, which is new). Vectors of deleted
  sources/documents are swept after every job and deletion (they used to
  linger in nearest-neighbour results). The `jobs` history is pruned to 200.
  Conditional-request data for web pages moved from the `error` column to
  its own `meta` column (migrated automatically).
- 2026-09-20: Documentation moved to `Docs/` (user guide, configuration,
  architecture, API, security, development); `README.md` is the short front
  page; `CLAUDE.md` added for LLM sessions; `public/app.js` gained a
  structural header and JSDoc on its main functions.

### Fixed
- 2026-09-20: **Changing a website's scope had no effect on Re-check.** The
  re-check sends conditional requests; on "304 Not Modified" the crawler
  re-queued the links stored by the *first* crawl, which had been filtered by
  the old scope — so a page registered under "this section" and switched to
  "linked pages" kept yielding one page. Every same-site link is now stored
  regardless of scope and filtered by the scope in force; changing the scope
  clears the conditional metadata so the next Re-check truly re-reads; pages
  indexed before this change are re-read once on their next Re-check.
- 2026-09-20: **A page's links are now part of what is indexed.** The
  readability extractor strips navigation, so "Steps to file your taxes →
  /how-to-file-your-taxes-step-by-step" on an IRS page was invisible to the
  assistant. Each web page now carries a "Links on this page" passage (same
  site, with link text), so the assistant can say what a page points to and
  give the address; in *Sources first* mode it must do that rather than
  refuse.

### Changed
- 2026-09-20: URLs in answers and cited passages are clickable (open in a new
  tab); Markdown links render too. The Cited-passage panel puts Prev / Next /
  Open at the top.

### Changed
- 2026-09-19: **Bundles carry a description.** Each bundle card on the Sources
  page has a description field ("2024–2026 federal tax code, IRS publications
  and the Henderson client file"). The Reading-from drawer in Chat now shows
  the bundle name with that description under it, instead of a list of file
  names; without a description it shows "2 folders · 1 website". A bundle
  that needs attention — a source not indexed, an indexing failure, files
  that could not be read — carries a ⚠ next to its name whose tooltip lists
  the issues, and clicking the name (or the ⚠) opens that bundle on the
  Sources page.

### Changed
- 2026-09-19: **Chat converses.** "Are you there?" got "Not in your sources" —
  the strict rule was the only rule. There are now two modes, switchable per
  conversation with a **Sources only** tick in the composer (default in
  Settings → Models): *Sources first* replies normally to small talk, answers
  from your sources with citations when they cover the question, and answers
  the rest from general knowledge under an unmistakable "From general
  knowledge, not your sources" label — never a made-up citation; *Sources
  only* is the old strict behaviour. Every reply carries a badge (From your
  sources / Sources + general knowledge / General knowledge), the mode is
  saved with the session, and "How I answered" now lists the documents the
  answer drew on rather than every passage retrieval merely looked at.

### Changed
- 2026-09-19: **Websites have a scope.** A registered page whose links fan out
  across a site (irs.gov/individuals/get-transcript) was read as one page,
  because the only rule was "everything under this address". Each website
  source now has a scope, chosen when added and editable on its row: *linked
  pages* (same site, N link-hops from the page — the new default, 2 hops),
  *this section* (the old rule), *whole site*, *this page only*. Other
  websites are never followed; translated copies of pages (`/es/`, `/zh-hans/`
  …) are skipped unless the start page is one; the pages-per-website cap
  always applies.
- 2026-09-19: **"N files could not be read" is now a button** that opens a
  window listing the failed files grouped by reason, with **Retry the failed
  files** — which re-reads only those files (or re-fetches only those pages),
  not the whole source, and reports how many were recovered.

### Fixed
- 2026-09-19: **Rate limits lost hundreds of files.** A 10,000-file run against
  OpenAI failed 683 files on "429 Rate limit reached" and "429 Request too
  large" — the embedding client had no retry. It now retries rate limits and
  outages with backoff (honouring Retry-After) and halves a batch the
  provider calls too large, down to a single passage; a passage that is
  itself too large is reported with the setting to change.

### Changed
- 2026-09-19: Settings → Models: a saved API key is shown as its first 5 and
  last 5 characters (`sk-pr••••••••a1b2c`) so you can tell which key it is;
  pasting a new one replaces it. "List models" now opens a sub-window with
  every model the provider offers and a search box that starts empty (the old
  dropdown only showed models matching what was already typed); there is one
  beside the chat model and one beside the embedding model, and clicking a
  model fills the field.

### Fixed
- 2026-09-19: After the first chat message, any refresh of the page state
  (adding a source, toggling a bundle) failed with "null is not an object
  (welcome-hint)": the welcome text had left the thread but the hint updater
  still wrote to it. Guarded. Adding a folder or website needs no model —
  only Index does.

### Fixed
- 2026-09-19: **Indexing with no working model read every file for nothing.**
  A run over 10,722 files (OCR included) failed 10,661 of them at the very
  last step because the active provider had no API key. Indexing now makes
  one tiny embedding call before it starts and refuses — with a message that
  says what to set up — if that fails, so nothing is read in vain. The
  Sources page shows the same warning while no model is working, and clicking
  Index / Re-index (anywhere) first does that quick check and opens a
  "No model is connected" window with the reason and a button to
  Settings → Models, queuing nothing.

### Changed
- 2026-09-19: **Indexing status lives with Sources.** The bar across the top is
  gone; while indexing runs, the Sources icon in the rail carries a pulsing
  badge, and the Sources page shows an "Indexing now" card: files (or pages)
  done of the total, percent, an estimated time left from the measured rate,
  the current file, how many jobs are queued, and a Stop button. The source
  row being worked on shows the same count inline.
- 2026-09-19: Fixed Stop sticking at "Stopping…" after a restart: the page
  now reconciles with the server whenever the progress stream (re)connects,
  and Stop clears immediately when nothing is running. A job interrupted by a
  restart has to be started again — the page says so.

### Fixed
- 2026-09-19: **Indexing had no visible progress** once the drawers were made
  Chat-only — clicking Index or Re-index produced a "Queued" toast and nothing
  else. A job bar now runs across the top of every view (what is being
  indexed, N of M, the current file, a progress bar, Stop), the source's own
  row shows a spinner with its button disabled while it runs, and the click
  itself gives immediate feedback.
- 2026-09-19: **The log was buried in pdf.js and OCR chatter** (glyph-path
  warnings, "translateFont failed: cMapUrl", `Filter "Crypt"`, "Image too
  small to scale"). pdf.js now runs at errors-only verbosity and is pointed at
  the character maps and standard fonts it ships (which also lets it render
  those glyphs); Tesseract's own messages go to its debug file. A document
  with no readable text at all (encrypted, or image-only with OCR off) is now
  a proper per-document error in the Documents list instead of a silent
  empty entry.

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
