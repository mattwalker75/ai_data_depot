# User guide

AI Data Depot answers questions from **your** material — folders on this computer and websites
you name — and shows you exactly where each answer came from. It is not a search engine and
will not wander the internet.

## Starting it as a desktop app

`Start_Ai_Data_Depot.sh` (in the app folder) starts the server and opens AI Data Depot in its
own window — not a tab in your browser; closing that window stops the app. Run it from a
terminal, or make it a double-clickable `.app` for your Desktop or Applications folder with
[my_mac_app](https://github.com/mattwalker75/my_mac_app):

```sh
mk_mac_app.py --name "AI Data Depot" --script ~/Desktop/REPOs/ai_data_depot/Start_Ai_Data_Depot.sh --emoji 🗄️
```

If the app is already running (started with `./DEPOT.sh`), the launcher just opens a window
onto it and leaves it running afterwards. The port is read from `config.json`, so changing it
in Settings needs no edit to the launcher. Requirements: `./INSTALL_APP.sh` run once, and a
Chromium-based browser (Chrome, Edge, Brave or Arc) for the dedicated window — otherwise your
default browser opens a tab.

## The window

- **Rail (left edge)**: Chat, Sources, Personas, Sessions, and Settings at the bottom. A pulsing
  dot on Sources means indexing is running.
- **Reading-from drawer (left of Chat)**: your bundles with a checkbox each. Only ticked bundles
  are read. A ⚠ next to a name means it needs attention — hover for why, click to jump to it.
- **Evidence drawer (right of Chat)**: the passage behind a citation, with Prev/Next and *Open
  file* / *Open page*. The *All sources* tab lists everything the reply drew on.
- Drag a drawer's handle to resize it; click the handle to hide or show it.

## 1 · Make a bundle and add sources

Sources → **+ New bundle** → name it ("Federal tax 2026", "Client · Henderson"). Give it a
description: it appears in the Reading-from drawer and helps you remember what is in it.

- **+ Folder or file** opens a picker. Everything under a folder is included (supported types
  only — see Settings → Indexing · Files). Text, Markdown, HTML, PDF (scanned pages via OCR),
  Word, Excel, CSV, PowerPoint, JSON, RTF, **emails** (`.eml`, Outlook `.msg` — headers, body,
  attachment names) and **images** (`.png`, `.jpg`, `.webp`, `.bmp`, `.gif` — read with OCR, so
  receipts and scanned letters work).
- **+ Website** asks for an address and a **scope**:
  - *Linked pages* (default) — the page and what it links to on the same site, N hops.
  - *This section* — everything whose address starts with the page's.
  - *Whole site* — up to the pages-per-site cap.
  - *This page only.*
  Other websites are never followed; translated copies (`/es/…`) are skipped.

Nothing is read until you index it. Tick **Index right away** when adding, or use the buttons.

## 2 · Index

Sources → **Index files** / **Index websites**, or **Index** / **Re-index** on a single source.
The first thing a job does is a one-word test of your embedding model; if no model is
connected you get a window saying so — set one up in Settings → Models first.

While a job runs the Sources page shows *done / total*, an estimate of the time left, and a
**Stop** button. Afterwards each source shows its document count; **N files could not be read**
is a button — click it to see the reasons grouped (password-protected PDF, too large, model
rate-limited…) and **Retry the failed files** to re-read just those.

A changed or new file in a watched folder is picked up automatically (large folder trees are
not watched — re-index them by hand). Websites are re-indexed on the schedule in Settings.

## 3 · Ask

Type in Chat. The reply cites passages as `[1]`, `[2]`…; click one to see it. Under each reply:

- a badge — **From your sources**, **Sources + general knowledge**, or **General knowledge — not
  from your sources**;
- **How I answered** — which bundles were searched, how many passages were considered, which
  documents were used, which bundles were off.

**Mode** (switch in the Chat header, under the model name):
- **Sources first** — converses normally, uses your sources when they answer, and prefixes
  anything else with *"From general knowledge, not your sources:"*.
- **Sources only** — refuses to answer anything the sources do not support ("Not in your
  sources"). Use it when you must not rely on the model's memory.

The **Local / Cloud** badge says whether your question leaves the machine.

**Ask about one document.** Click 📄 next to the composer and pick a document, or *Ask about
this* in the Evidence drawer. A chip above the composer shows what you are asking about; only
that document is searched until you click ✕. The choice is saved with the session.

**Copy an answer.** Hover a reply and click *Copy*: the text goes to the clipboard with a
numbered *Sources* list (title, page, file path or address) ready to paste into a memo.

**See the page.** For a cited PDF the Evidence drawer shows the page itself with the cited
passage highlighted; ‹ › walk through the document's pages. Other file types show the passage
text.

## 3b · Make a file

Ask for one in the chat — *"turn this into a memo for the Hendersons"*, *"make a spreadsheet of
every deadline in this file"*, *"write me a poem about flowers and save it as a PDF"*. The reply
acknowledges it, a card appears while the file is made, then shows **Preview** and **Download**.
**Preview** opens the file in a floating window over the page — *Client copy* (clean) and *With
sources* (citations and a Sources section), each with its own download, plus Keep and Delete.
Word and Excel preview as text there; the download is the real file. The **Files** tab in the
right drawer is the list of this session's files (or all); click a row to open the same window,
⬇ downloads the client copy.

Kinds: memo/letter, summary/briefing, checklist, table/data extract (Excel by default; built
document by document so nothing is skipped), comparison, and free-form for anything else.
Memos, summaries and free-form documents can carry a small **diagram** — a flowchart, timeline,
sequence or chart — when it helps or when you ask ("…with a flowchart of the steps"); it is
drawn into PDF and Word files using your installed Chrome/Edge/Brave/Arc, and shown live in
the preview. Switch off in Settings → General if you never want them.
Formats: PDF, Word, Excel (tables and checklists), text. The 🗎 button next to the composer is the
same thing as a form; **File** under any reply saves that reply as-is.

Files live in `OUTPUT/` and are deleted after 30 days unless you tick **Keep** — the card then
says *expired*. Delete removes a file at once. Details: [DOCUMENTS.md](DOCUMENTS.md).

## 4 · Personas

A persona sets voice and focus (Tax Specialist, Researcher, Legal, Analyst, Tutor, Concise,
General). Choose one in the Chat header. Personas → edit or **Save a copy** to make your own;
the source rules always apply on top of a persona.

## 5 · Sessions

A session is a saved conversation — one per customer or matter. **Save** in the header; the
▾ menu lists recent ones. Sessions page: load, rename, delete, **Export** (`.json` to move to
another machine or share with a colleague who also runs the tool; `.md` to read or paste into a
report) and **Import**.

## 6 · Settings

- **Models** — pick a provider (Ollama, LM Studio, OpenAI, OpenRouter, Groq, Anthropic, custom),
  enter its address and key, pick the chat and embedding models from the list. Changing the
  embedding model means re-indexing everything.
- **Appearance** — presets (light, dark, Reading Room, Ledger, Graphite, follow system) or make
  your own theme.
- **Indexing · Files / Websites** — OCR, size limits, pages per site, schedule.
- **General** — port, listen address, data folder (restart to apply), *Reload config.json* if you
  edited it by hand, **Compact the database** to reclaim space after removing sources,
  **Generated files** (open a preview automatically when a file is created; how many days files
  are kept), and **Backups**.

## 7 · Backups

**Back up now** writes a small zip to `data/backups/` (download it from the list to keep it
elsewhere). It holds your bundles and *where* their sources live — folder paths and website
addresses, bookmarks rather than copies — your saved sessions, your personas, and your settings
**without API keys**. The files themselves and the index are never included; they can be
gigabytes and the files already live in your folders. **Restore from a backup…** merges a zip
into the current install (nothing is deleted or overwritten); then put the source folders back
where they were, re-enter API keys, and re-index.

## Changing the embedding model

The index only works with the model that built it. If you switch embedding models in Settings,
Chat and Sources show a yellow banner naming both models with a **Re-index everything** button;
unchanged files are re-read automatically once you do.

## Tips

- Keep bundles small and named by purpose; turn off what a question is not about — retrieval
  gets sharper and the ledger stays readable.
- For a scanned PDF that came back empty, check Settings → Indexing · Files → OCR is on.
- If replies feel generic, ask more specifically or switch to *Sources only* to see what the
  sources actually contain.
