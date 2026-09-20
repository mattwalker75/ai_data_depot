# Security model

AI Data Depot is a **single-user tool that runs on your own computer**. There is no login,
by design: the person at the keyboard is the owner of every folder it can read. This page
says what that assumption rests on, what the app does to keep it true, and what it does not
protect against.

## What stands in for a login

| Control | Where | What it prevents |
| --- | --- | --- |
| Binds to `127.0.0.1` by default | `config.json → server.host` | Other devices on the network cannot connect at all. |
| Host-header check (HTTP 421) | `server.js` first middleware | **DNS rebinding**: a malicious web page cannot make your browser talk to the app through a hostname it controls, because the request's `Host` would not name this machine. |
| Same-origin check on writes (HTTP 403) | same middleware | **Cross-site requests**: another site open in your browser cannot POST to the app (checks `Sec-Fetch-Site` and `Origin`; requests with neither, e.g. `curl`, are local scripts and allowed). |
| `/api/open` only opens indexed items | `server.js` | The desktop "open" command can only be pointed at a file or page that is already in your index — never an arbitrary path or scheme. |
| `config.json` written `0600` | `src/config.js` | Other accounts on the machine cannot read your API keys. |
| Keys masked in the UI (`sk-ab•••••••wxyz`) | `src/config.js` | A screenshot or a look over your shoulder does not leak a key; a masked value sent back means "unchanged". |
| Sources are data, not instructions | `src/chat.js` grounding rules | A document or web page that contains text like "ignore your rules and…" is quoted, not obeyed. This is a prompt-level mitigation, not a guarantee. |
| Escaping everywhere in the UI | `public/app.js → esc()` | Document titles, file names and model output cannot inject HTML/JS into the page. The Markdown renderer escapes first, then formats. |
| Crawler stays on the origin you gave | `src/crawler.js` | A website source never follows links off its own site, honours robots.txt, and stops at `max_pages_per_site`. |

## What it deliberately does not do

- **No authentication.** Anyone who can run commands as your user can use the app and read
  the same folders. If you set `server.host` to `0.0.0.0`, everyone on your network can too —
  do that only on a network you trust, or put a reverse proxy with authentication in front.
- **No sandboxing of file reading.** `/api/fs/browse` lists any folder your user can read; that
  is the point of the picker. Nothing is written outside `data_dir` and `config.json`.
- **No encryption at rest.** The database contains the text of everything you index. Protect
  `data/` like you protect the source folders (FileVault does this on a Mac).
- **Model traffic.** With a cloud provider, the question, the retrieved passages and the
  conversation history are sent to that provider. The privacy badge in the Chat header says
  "Local" only when the active provider is marked `local: true` (Ollama, LM Studio).

## Reporting

It is your machine — if you find something, fix it or open an issue on the repository.
