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

const cfg = config.load();
const db = open();
const app = express();
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
app.delete("/api/bundles/:id", wrap((req, res) => { db.prepare("DELETE FROM bundles WHERE id=?").run(req.params.id); indexer.startWatchers(); res.json({ ok: true }); }));
app.post("/api/bundles/:id/sources", wrap((req, res) => {
  const b = db.prepare("SELECT * FROM bundles WHERE id=?").get(req.params.id); if (!b) throw new Error("No such bundle.");
  const kind = req.body.kind === "website" ? "website" : "path";
  let location = String(req.body.location || "").trim();
  if (!location) throw new Error(kind === "website" ? "Enter the website address." : "Enter a folder or file path.");
  if (kind === "website") { if (!/^https?:\/\//i.test(location)) location = "https://" + location; new URL(location); }
  else { const abs = config.expandHome(location); if (!fs.existsSync(abs)) throw new Error(`"${location}" does not exist on this computer.`); }
  const id = db.prepare("INSERT INTO sources(bundle_id, kind, location) VALUES (?,?,?)").run(b.id, kind, location).lastInsertRowid;
  if (kind === "path") indexer.startWatchers();
  if (req.body.index !== false) indexer.indexSource(id);
  res.json({ id });
}));
app.delete("/api/sources/:id", wrap((req, res) => { db.prepare("DELETE FROM sources WHERE id=?").run(req.params.id); indexer.startWatchers(); res.json({ ok: true }); }));
app.post("/api/sources/:id/index", wrap((req, res) => res.json({ job: indexer.indexSource(Number(req.params.id)) })));
app.get("/api/bundles/:id/documents", wrap((req, res) => res.json(db.prepare("SELECT id, source_id, kind, locator, title, mime, bytes, page_count, char_count, ocr_pages, indexed_at, status, CASE WHEN status='error' THEN error END AS error FROM documents WHERE bundle_id=? ORDER BY kind, title LIMIT 2000").all(req.params.id))));
app.get("/api/chunks/:id", wrap((req, res) => {
  const c = db.prepare("SELECT c.*, d.title, d.locator, d.kind FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.id=?").get(req.params.id);
  if (!c) throw new Error("That passage is no longer in the index.");
  res.json({ id: c.id, text: c.text, location: c.location, title: c.title, locator: c.locator, kind: c.kind });
}));

// A plain folder browser so nobody has to type a path.
app.post("/api/fs/browse", wrap((req, res) => {
  let dir = config.expandHome(String(req.body.path || os.homedir()));
  if (!fs.existsSync(dir)) dir = os.homedir();
  const st = fs.statSync(dir); if (!st.isDirectory()) dir = path.dirname(dir);
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).map((e) => ({ name: e.name, dir: e.isDirectory(), supported: e.isFile() && require("./src/extract").supported(e.name) }))
    .filter((e) => e.dir || e.supported).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  res.json({ path: dir, parent: path.dirname(dir), entries });
}));
app.post("/api/open", wrap((req, res) => {
  const target = String(req.body.locator || "");
  if (!/^https?:\/\//.test(target) && !fs.existsSync(target)) throw new Error("That file is not on this computer any more.");
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [target], (err) => err && console.warn("[open]", err.message));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- indexing
app.post("/api/index/files", wrap((req, res) => res.json({ jobs: indexer.indexFiles({ bundleId: req.body.bundle_id }) })));
app.post("/api/index/websites", wrap((req, res) => res.json({ jobs: indexer.indexWebsites({ bundleId: req.body.bundle_id }) })));
app.post("/api/index/stop", wrap((req, res) => { indexer.stop(); res.json({ ok: true }); }));
app.get("/api/index/jobs", wrap((req, res) => res.json({ current: indexer.current(), jobs: indexer.jobs(30) })));
app.get("/api/index/events", (req, res) => {
  const send = sse(res);
  const onJob = (j) => send("job", j);
  indexer.events.on("job", onJob);
  send("hello", { current: indexer.current() });
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
  const { message, history = [], persona = "general", bundle_ids = [], provider, model } = req.body || {};
  if (!message || !String(message).trim()) throw new Error("Type a question first.");
  const send = sse(res);
  // res 'close' = the client went away. (req 'close' fires as soon as the
  // request body is consumed on modern Node, which is immediately here.)
  let closed = false; res.on("close", () => { closed = true; });
  try {
    const r = await chat.answer({ message: String(message), history, personaId: persona, bundleIds: bundle_ids.map(Number).filter(Boolean), provider, model, onToken: (t) => { if (!closed) send("token", { text: t }); } });
    if (!closed) send("done", { text: r.text, citations: r.citations, ledger: r.ledger, notFound: r.notFound });
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
  indexer.startWatchers(); indexer.startScheduler();
  if (cfg.server.open_browser && !process.env.DEPOT_NO_OPEN) { const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"; execFile(cmd, [url], () => {}); }
});
process.on("SIGINT", async () => { await require("./src/extract").shutdown(); process.exit(0); });
