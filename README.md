# AI Data Depot

A local reference assistant for non-technical professionals. It answers questions
**only from the document folders and websites you enable**, cites every claim, and says
plainly when the answer isn't in your sources. Runs on your own computer; works with cloud
models (OpenAI and other OpenAI-compatible providers) or fully local ones (Ollama, LM Studio),
in which case nothing leaves the machine.

## Requirements

| | |
| --- | --- |
| **Required** | Node.js 20 or newer. Everything else is an npm package — PDF text, OCR of scanned pages and Word/Excel/PowerPoint reading included. |
| **Optional** | [Ollama](https://ollama.com) for fully local models; Homebrew on macOS to install Node and Ollama. |
| **Once** | The first scanned PDF downloads ~15 MB of English OCR data (cached in `data/tessdata`). |

## Quick start

```bash
./INSTALL_APP.sh            # checks Node, installs packages, creates config.json, runs the tests
./INSTALL_APP.sh --ollama   # …and sets up Ollama + pulls an embedding and a chat model
./DEPOT.sh --start          # opens http://localhost:8300
```

`./DEPOT.sh --help` and `./INSTALL_APP.sh --help` list every flag with examples.

**As a desktop app:** `Start_Ai_Data_Depot.sh` starts the server and opens it in its own
window; closing the window stops it. Turn it into a double-clickable `.app` with
[my_mac_app](https://github.com/mattwalker75/my_mac_app):
`mk_mac_app.py --name "AI Data Depot" --script /path/to/ai_data_depot/Start_Ai_Data_Depot.sh --icon /path/to/ai_data_depot/icon/ai_data_depot.icns`
(the icon is in `icon/`, as `.icns` and `.png`).

## In one paragraph

Group folders and websites into **bundles** and tick the ones a question may use. **Index**
them (files of every common type, scanned PDFs via OCR, websites within a scope you choose —
never the open internet). **Ask**: answers cite passages `[1]`, `[2]`… you can click to read
and open — for PDFs, the page itself with the passage highlighted; *Sources first* mode
converses normally and labels general knowledge, *Sources only* refuses anything unsupported;
📄 narrows a conversation to one document; ask for *"a memo"*, *"a spreadsheet of every
deadline"* or *"a PDF summary"* and the file is made for you — a clean client copy and a cited
copy, previewed in the Files tab and kept in `OUTPUT/` for 30 days. **Personas** set the voice (Tax Specialist, Legal, Researcher…);
**Sessions** save a conversation per client or matter and export it.

## Documentation

| | |
| --- | --- |
| [Docs/USER_GUIDE.md](Docs/USER_GUIDE.md) | Using the app: bundles, indexing, asking, modes, personas, sessions, settings. |
| [Docs/CONFIGURATION.md](Docs/CONFIGURATION.md) | Every key in `config.json` and what it does. |
| [Docs/ARCHITECTURE.md](Docs/ARCHITECTURE.md) | How it is built: modules, data model, request and indexing flows. |
| [Docs/DOCUMENTS.md](Docs/DOCUMENTS.md) | Generated documents: memos, summaries, checklists, spreadsheets, comparisons; the two copies; OUTPUT/ and retention. |
| [Docs/API.md](Docs/API.md) | The HTTP/SSE endpoints. |
| [Docs/SECURITY.md](Docs/SECURITY.md) | The single-user, local trust model and what it does and doesn't protect. |
| [Docs/DEVELOPMENT.md](Docs/DEVELOPMENT.md) | Running, testing, conventions, adding file types/providers. |
| [CLAUDE.md](CLAUDE.md) | Notes for an LLM working on this codebase. |
| [CHANGELOG.md](CHANGELOG.md) | What changed, when. |

Configuration lives in `config.json` (gitignored; created from `config.template.json`) — edit it
in a text editor or in **Settings**. Tests: `npm test`.
