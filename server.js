"use strict";
/**
 * AI Data Depot — local reference assistant. One Express process serves the
 * UI and a small JSON API; chat answers and indexing progress stream over
 * Server-Sent Events. Single user, binds to localhost by default, no login.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const express = require("express");

const config = require("./src/config");
const { open } = require("./src/db");
const providers = require("./src/providers");
const indexer = require("./src/indexer");
const personas = require("./src/personas");
const sessions = require("./src/sessions");
const chat = require("./src/chat");
const backup = require("./src/backup");
const extract = require("./src/extract");

const cfg = config.load();
const db = open();
const app = express();

// Local-only trust boundary. There is no login by design (single user on
// their own machine), so two things must hold instead: (1) only requests
// addressed to this machine are served — a web page you visit cannot reach
// the API through DNS rebinding, because its Host header would not match;
// (2) state-changing requests must come from the app's own origin, so a
// cross-site page cannot POST here even with a permissive Host.
app.use((req, res, next) => {
  const hostHeader = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", String(cfg.server.host || "").toLowerCase()]);
  if (cfg.server.host === "0.0.0.0") { for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || []) allowed.add(String(i.address).toLowerCase()); }
  if (!allowed.has(hostHeader)) return res.status(421).json({ error: `Requests must be addressed to this machine (got Host "${hostHeader}").` });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.origin, fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return res.status(403).json({ error: "Cross-site request refused." });
    if (origin) { try { const oh = new URL(origin).hostname.toLowerCase(); if (!allowed.has(oh)) return res.status(403).json({ error: "Cross-site request refused." }); } catch { return res.status(403).json({ error: "Cross-site request refused." }); } }
  }
  next();
});
app.use(express.json({ limit: "20mb" }));
// UI files are served from disk; never let a browser keep a stale copy after
// an update — always revalidate (ETag makes an unchanged file a cheap 304).
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], etag: true, lastModified: true, setHeaders: (res) => res.set("cache-control", "no-cache") }));

const VERSION = require("./package.json").version;
let restartNeeded = [];

// Every handler error — thrown synchronously or rejected — becomes a plain
// JSON message the UI can show, never Express's HTML stack page.
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e.message); if (!res.headersSent) res.status(400).json({ error: e.message }); else res.end(); } };
const sse = (res) => { res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" }); res.flushHeaders(); return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

// ---------------------------------------------------------------- state
function bundlesWithSources() {
  const bundles = db.prepare("SELECT * FROM bundles ORDER BY position, id").all();
  const sources = db.prepare("SELECT * FROM sources ORDER BY id").all();
  return bundles.map((b) => ({ ...b, enabled: !!b.enabled, sources: sources.filter((s) => s.bundle_id === b.id) }));
}
app.get("/api/state", wrap((req, res) => res.json({
  version: VERSION, config: config.redacted(), restart_required: restartNeeded,
  bundles: bundlesWithSources(), personas: personas.list(), sessions: sessions.list(), job: indexer.current(),
  config_path: config.CONFIG_PATH, data_dir: config.dataDir(), sqlite_vec: require("./src/db").vecLoaded,
  index_models: indexer.indexModels(),
})));

// ---------------------------------------------------------------- bundles + sources
app.post("/api/bundles", wrap((req, res) => {
  const name = String(req.body.name || "").trim(); if (!name) throw new Error("Give the bundle a name.");
  const pos = (db.prepare("SELECT coalesce(max(position),0) AS p FROM bundles").get().p || 0) + 1;
  const id = db.prepare("INSERT INTO bundles(name, description, position) VALUES (?,?,?)").run(name, String(req.body.description || ""), pos).lastInsertRowid;
  res.json({ id });
}));
app.patch("/api/bundles/:id", wrap((req, res) => {
  const b = db.prepare("SELECT * FROM bundles WHERE id=?").get(req.params.id); if (!b) throw new Error("No such bundle.");
  const name = req.body.name !== undefined ? String(req.body.name).trim() : b.name;
  const enabled = req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : b.enabled;
  const description = req.body.description !== undefined ? String(req.body.description) : b.description;
  db.prepare("UPDATE bundles SET name=?, enabled=?, description=? WHERE id=?").run(name, enabled, description, b.id);
  res.json({ ok: true });
}));
app.delete("/api/bundles/:id", wrap((req, res) => { db.prepare("DELETE FROM bundles WHERE id=?").run(req.params.id); require("./src/db").sweepOrphanVectors(); indexer.startWatchers(); res.json({ ok: true }); }));
app.post("/api/bundles/:id/sources", wrap((req, res) => {
  const b = db.prepare("SELECT * FROM bundles WHERE id=?").get(req.params.id); if (!b) throw new Error("No such bundle.");
  const kind = req.body.kind === "website" ? "website" : "path";
  let location = String(req.body.location || "").trim();
  if (!location) throw new Error(kind === "website" ? "Enter the website address." : "Enter a folder or file path.");
  if (kind === "website") { if (!/^https?:\/\//i.test(location)) location = "https://" + location; new URL(location); }
  else { const abs = config.expandHome(location); if (!fs.existsSync(abs)) throw new Error(`"${location}" does not exist on this computer.`); }
  const options = kind === "website" ? JSON.stringify(sourceOptions(req.body.options)) : null;
  const id = db.prepare("INSERT INTO sources(bundle_id, kind, location, options) VALUES (?,?,?,?)").run(b.id, kind, location, options).lastInsertRowid;
  if (kind === "path") indexer.startWatchers();
  // Indexing is a deliberate step the user starts (Sources → Index), unless asked for here.
  if (req.body.index === true) indexer.indexSource(id);
  res.json({ id, indexed: req.body.index === true });
}));
const { SCOPES } = require("./src/crawler");
function sourceOptions(o) { o = o || {}; return { scope: SCOPES.includes(o.scope) ? o.scope : "linked", depth: Math.max(0, Math.min(10, Number(o.depth ?? 2) || 0)) }; }
app.patch("/api/sources/:id", wrap((req, res) => {
  const s = db.prepare("SELECT * FROM sources WHERE id=?").get(req.params.id); if (!s) throw new Error("No such source.");
  if (s.kind !== "website") throw new Error("Only websites have scope options.");
  db.prepare("UPDATE sources SET options=? WHERE id=?").run(JSON.stringify(sourceOptions(req.body.options)), s.id);
  indexer.forgetConditionalMeta(s.id); // so the next Re-check re-reads pages instead of trusting 304s
  res.json({ ok: true, options: sourceOptions(req.body.options) });
}));
app.post("/api/sources/:id/retry-failed", wrap((req, res) => res.json({ job: indexer.retryFailed(Number(req.params.id)) })));
app.get("/api/sources/:id/errors", wrap((req, res) => res.json(indexer.sourceErrors(Number(req.params.id)))));
app.delete("/api/sources/:id", wrap((req, res) => { db.prepare("DELETE FROM sources WHERE id=?").run(req.params.id); require("./src/db").sweepOrphanVectors(); indexer.startWatchers(); res.json({ ok: true }); }));
app.post("/api/sources/:id/index", wrap((req, res) => res.json({ job: indexer.indexSource(Number(req.params.id)) })));
app.get("/api/bundles/:id/documents", wrap((req, res) => res.json(db.prepare("SELECT id, source_id, kind, locator, title, mime, bytes, page_count, char_count, ocr_pages, indexed_at, status, CASE WHEN status='error' THEN error END AS error FROM documents WHERE bundle_id=? ORDER BY kind, title LIMIT 2000").all(req.params.id))));
// Documents across the enabled bundles (or given ones), for the "ask about one document" picker.
app.get("/api/documents", wrap((req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const ids = String(req.query.bundle_ids || "").split(",").map(Number).filter(Boolean);
  const where = ids.length ? `d.bundle_id IN (${ids.map(() => "?").join(",")})` : "b.enabled=1";
  const rows = db.prepare(`SELECT d.id, d.kind, d.locator, d.title, d.mime, d.page_count, b.name AS bundle FROM documents d JOIN bundles b ON b.id=d.bundle_id WHERE d.status='ok' AND ${where} AND (? = '' OR lower(d.title) LIKE ? OR lower(d.locator) LIKE ?) ORDER BY d.title LIMIT 300`).all(...ids, q, `%${q}%`, `%${q}%`);
  res.json(rows);
}));
app.get("/api/documents/:id", wrap((req, res) => {
  const d = db.prepare("SELECT d.id, d.kind, d.locator, d.title, d.mime, d.page_count, d.status, b.name AS bundle FROM documents d JOIN bundles b ON b.id=d.bundle_id WHERE d.id=?").get(req.params.id);
  if (!d) throw new Error("That document is no longer in the index.");
  res.json(d);
}));
// A rendered PDF page for the Evidence drawer. Only indexed PDFs on disk; the
// cited chunk's text is used to place highlight boxes. Small in-memory cache.
const pageCache = new Map();
app.get("/api/documents/:id/page/:n", wrap(async (req, res) => {
  const d = db.prepare("SELECT id, kind, locator, mime FROM documents WHERE id=? AND status='ok'").get(req.params.id);
  if (!d) throw new Error("That document is no longer in the index.");
  if (d.kind !== "file" || !/pdf/i.test(d.mime || "") || !/\.pdf$/i.test(d.locator)) throw new Error("Only PDF files can be shown as pages.");
  if (!fs.existsSync(d.locator)) throw new Error("That file is not on this computer any more.");
  // Highlight from the cited chunk's full text; sessions saved before chunk ids existed send the excerpt instead.
  const chunk = req.query.chunk ? db.prepare("SELECT text FROM chunks WHERE id=? AND document_id=?").get(req.query.chunk, d.id) : null;
  const hlText = chunk ? chunk.text : String(req.query.text || "").slice(0, 2000);
  const key = `${d.id}:${req.params.n}:${req.query.chunk || ""}:${hlText.length}:${fs.statSync(d.locator).mtimeMs}`;
  let r = pageCache.get(key);
  if (!r) {
    r = await extract.renderPdfPage(fs.readFileSync(d.locator), Number(req.params.n) || 1, hlText);
    pageCache.set(key, r); if (pageCache.size > 24) pageCache.delete(pageCache.keys().next().value);
  }
  res.json({ page: r.page, pages: r.pages, width: r.width, height: r.height, boxes: r.boxes, image: "data:image/png;base64," + r.png.toString("base64") });
}));
app.get("/api/chunks/:id", wrap((req, res) => {
  const c = db.prepare("SELECT c.*, d.title, d.locator, d.kind FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.id=?").get(req.params.id);
  if (!c) throw new Error("That passage is no longer in the index.");
  res.json({ id: c.id, text: c.text, location: c.location, title: c.title, locator: c.locator, kind: c.kind });
}));

// A folder/file browser so nobody has to type a path. Returns what a file
// dialog shows: name, kind, size, modified — plus the usual shortcuts.
app.post("/api/fs/browse", wrap((req, res) => {
  const home = os.homedir();
  let dir = config.expandHome(String(req.body.path || home));
  if (!fs.existsSync(dir)) dir = home;
  let st = fs.statSync(dir); if (!st.isDirectory()) dir = path.dirname(dir);
  const { supported } = require("./src/extract");
  const entries = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    let est; try { est = fs.statSync(path.join(dir, e.name)); } catch { continue; }
    const isDir = est.isDirectory();
    if (!isDir && !supported(e.name)) continue;
    entries.push({ name: e.name, dir: isDir, size: isDir ? null : est.size, mtime: est.mtime.toISOString(), ext: isDir ? "" : path.extname(e.name).slice(1).toLowerCase() });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.dir ? -1 : 1));
  const shortcuts = [["Home", home], ["Desktop", path.join(home, "Desktop")], ["Documents", path.join(home, "Documents")], ["Downloads", path.join(home, "Downloads")]].filter(([, p]) => fs.existsSync(p)).map(([name, p]) => ({ name, path: p }));
  res.json({ path: dir, parent: path.dirname(dir), home, shortcuts, entries });
}));
// Opens a cited item with the desktop's default app. Only something that is
// actually in the index may be opened — never an arbitrary path or scheme.
app.post("/api/open", wrap((req, res) => {
  const target = String(req.body.locator || "");
  const known = db.prepare("SELECT 1 FROM documents WHERE locator=? LIMIT 1").get(target);
  if (!known) throw new Error("Only files and pages in your index can be opened from here.");
  if (/^https?:\/\//.test(target)) { /* a web page: fine */ }
  else if (!fs.existsSync(target)) throw new Error("That file is not on this computer any more.");
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [target], (err) => err && console.warn("[open]", err.message));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- indexing
app.get("/api/index/ready", wrap(async (req, res) => res.json(await indexer.embeddingReady())));
app.post("/api/index/files", wrap((req, res) => res.json({ jobs: indexer.indexFiles({ bundleId: req.body.bundle_id }) })));
app.post("/api/index/websites", wrap((req, res) => res.json({ jobs: indexer.indexWebsites({ bundleId: req.body.bundle_id }) })));
app.post("/api/index/stop", wrap((req, res) => { const was = indexer.current(); indexer.stop(); res.json({ ok: true, was_running: !!was }); }));
app.get("/api/index/jobs", wrap((req, res) => res.json({ current: indexer.current(), jobs: indexer.jobs(30) })));
app.get("/api/index/events", (req, res) => {
  const send = sse(res);
  const onJob = (j) => send("job", j);
  indexer.events.on("job", onJob);
  send("hello", { current: indexer.current(), jobs: indexer.jobs(5) });
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  res.on("close", () => { indexer.events.off("job", onJob); clearInterval(ping); });
});

// ---------------------------------------------------------------- models + settings
app.get("/api/models/status", wrap(async (req, res) => res.json(await providers.status(req.query.provider || undefined))));
app.get("/api/models/list", wrap(async (req, res) => res.json({ models: await providers.listModels(req.query.provider || undefined) })));
app.get("/api/settings", wrap((req, res) => res.json({ config: config.redacted(), restart_required: restartNeeded, config_path: config.CONFIG_PATH, presets: THEMES })));
app.put("/api/settings", wrap((req, res) => {
  const patch = config.unmaskKeys(req.body || {});
  delete patch._comment;
  const r = config.update(patch);
  restartNeeded = [...new Set([...restartNeeded, ...r.restart_required])];
  indexer.startWatchers();
  res.json({ config: config.redacted(), restart_required: restartNeeded, changed_now: r.restart_required });
}));
// Backups: bookmarks to the sources, sessions, personas, settings without keys. Never the files or the index.
app.get("/api/maintenance/backups", wrap((req, res) => res.json(backup.list())));
app.post("/api/maintenance/backups", wrap(async (req, res) => res.json(await backup.create())));
app.get("/api/maintenance/backups/:name", wrap((req, res) => res.download(backup.fileFor(req.params.name))));
app.delete("/api/maintenance/backups/:name", wrap((req, res) => { fs.rmSync(backup.fileFor(req.params.name)); res.json({ ok: true }); }));
app.post("/api/maintenance/restore", express.raw({ type: () => true, limit: "200mb" }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error("Pick a backup zip first.");
  const r = await backup.restore(req.body); indexer.startWatchers(); res.json(r);
}));
app.post("/api/maintenance/compact", wrap((req, res) => { if (indexer.current()) throw new Error("Wait for indexing to finish first."); res.json(indexer.compact()); }));
app.get("/api/maintenance/stats", wrap((req, res) => {
  const f = path.join(config.dataDir(), "depot.sqlite"); const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
  const c = db.prepare("SELECT (SELECT count(*) FROM documents WHERE status='ok') AS documents, (SELECT count(*) FROM chunks) AS chunks, (SELECT count(*) FROM bundles) AS bundles").get();
  res.json({ db_bytes: size, ...c, vec: require("./src/db").vecLoaded });
}));
app.post("/api/settings/reload", wrap((req, res) => { config.load(); indexer.startWatchers(); res.json({ config: config.redacted() }); }));
const THEMES = [
  { id: "harbor-light", name: "Harbor · light", dark: false }, { id: "harbor-dark", name: "Harbor · dark", dark: true },
  { id: "reading-room", name: "Reading room", dark: false }, { id: "ledger", name: "Ledger", dark: false },
  { id: "graphite", name: "Graphite", dark: true }, { id: "system", name: "Follow system", dark: null },
];

// ---------------------------------------------------------------- personas + sessions
app.get("/api/personas", wrap((req, res) => res.json(personas.list())));
app.post("/api/personas", wrap((req, res) => res.json(personas.save(req.body))));
app.delete("/api/personas/:id", wrap((req, res) => { personas.remove(req.params.id); res.json({ ok: true }); }));
app.get("/api/sessions", wrap((req, res) => res.json(sessions.list())));
app.post("/api/sessions", wrap((req, res) => res.json(sessions.save({ ...sessions.blank(req.body.name), ...req.body }))));
app.get("/api/sessions/:id", wrap((req, res) => res.json(sessions.load(req.params.id))));
app.put("/api/sessions/:id", wrap((req, res) => res.json(sessions.save({ ...req.body, id: req.params.id }))));
app.delete("/api/sessions/:id", wrap((req, res) => { sessions.remove(req.params.id); res.json({ ok: true }); }));
app.post("/api/sessions/import", wrap((req, res) => res.json(sessions.importJson(req.body))));
app.get("/api/sessions/:id/export", wrap((req, res) => {
  const s = sessions.load(req.params.id); const safe = s.name.replace(/[^\w.-]+/g, "_");
  if (req.query.format === "md") { res.set("content-disposition", `attachment; filename="${safe}.md"`).type("text/markdown").send(sessions.toMarkdown(s)); }
  else { res.set("content-disposition", `attachment; filename="${safe}.json"`).json(s); }
}));

// ---------------------------------------------------------------- chat (SSE)
app.post("/api/chat", wrap(async (req, res) => {
  const { message, history = [], persona = "general", bundle_ids = [], provider, model, mode, document_id } = req.body || {};
  if (!message || !String(message).trim()) throw new Error("Type a question first.");
  const send = sse(res);
  // res 'close' = the client went away. (req 'close' fires as soon as the
  // request body is consumed on modern Node, which is immediately here.)
  let closed = false; res.on("close", () => { closed = true; });
  try {
    const r = await chat.answer({ message: String(message), history, personaId: persona, bundleIds: bundle_ids.map(Number).filter(Boolean), provider, model, mode, documentId: Number(document_id) || null, onToken: (t) => { if (!closed) send("token", { text: t }); } });
    if (!closed) send("done", { text: r.text, citations: r.citations, ledger: r.ledger, notFound: r.notFound, basis: r.basis, mode: r.mode });
  } catch (e) { if (!closed) send("error", { error: e.message }); }
  res.end();
}));

app.get("/api/health", (req, res) => res.json({ ok: true, version: VERSION }));

// ---------------------------------------------------------------- start
const port = Number(process.env.PORT || cfg.server.port || 8300);
const host = process.env.HOST || cfg.server.host || "127.0.0.1";
app.listen(port, host, () => {
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  console.log(`AI Data Depot ${VERSION} — ${url}\n  config: ${config.CONFIG_PATH}\n  data:   ${config.dataDir()}\n  model:  ${cfg.models.active} (${cfg.models.providers[cfg.models.active].chat_model})`);
  indexer.recoverStaleState(); indexer.startWatchers(); indexer.startScheduler();
  if (cfg.server.open_browser && !process.env.DEPOT_NO_OPEN) { const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"; execFile(cmd, [url], () => {}); }
});
process.on("SIGINT", async () => { await require("./src/extract").shutdown(); process.exit(0); });
// A stray error in a watcher or a background job is logged, not fatal.
process.on("uncaughtException", (e) => console.error("[uncaught]", e && e.stack || e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e && e.stack || e));
