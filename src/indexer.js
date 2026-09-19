"use strict";
/**
 * Turns sources into searchable chunks. One job at a time, progress in the
 * `jobs` table and on an event emitter for the UI. Files and websites are
 * separate jobs with separate buttons — re-reading a folder never triggers a
 * crawl and vice versa. A document whose content hash is unchanged is
 * skipped, so re-indexing is cheap; files that vanished are removed.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const EventEmitter = require("events");
const config = require("./config");
const { open, ensureVec, toBlob } = require("./db");
const { extractFile, supported } = require("./extract");
const { chunkPages } = require("./chunk");
const providers = require("./providers");
const { crawl } = require("./crawler");

const events = new EventEmitter();
const queue = [];
let running = null;
let stopRequested = false;
const watchers = new Map();

function sha(s) { return crypto.createHash("sha1").update(s).digest("hex"); }
function now() { return new Date().toISOString(); }

// ---------------------------------------------------------------- jobs
function enqueue(kind, target, runner) {
  const db = open();
  const id = db.prepare("INSERT INTO jobs(kind, target, status) VALUES (?,?, 'queued')").run(kind, target).lastInsertRowid;
  queue.push({ id, kind, target, runner });
  events.emit("job", { id, kind, target, status: "queued" });
  setImmediate(pump);
  return id;
}

async function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job; stopRequested = false;
  const db = open();
  const progress = (done, total, message) => {
    db.prepare("UPDATE jobs SET progress_done=?, progress_total=?, message=?, status='running' WHERE id=?").run(done, total, message || null, job.id);
    events.emit("job", { id: job.id, kind: job.kind, target: job.target, status: "running", done, total, message });
  };
  db.prepare("UPDATE jobs SET status='running', started_at=? WHERE id=?").run(now(), job.id);
  try {
    const summary = await job.runner(progress);
    db.prepare("UPDATE jobs SET status=?, finished_at=?, message=? WHERE id=?").run(stopRequested ? "stopped" : "done", now(), summary || null, job.id);
    events.emit("job", { id: job.id, kind: job.kind, target: job.target, status: stopRequested ? "stopped" : "done", message: summary });
  } catch (e) {
    db.prepare("UPDATE jobs SET status='failed', finished_at=?, error=? WHERE id=?").run(now(), e.message, job.id);
    events.emit("job", { id: job.id, kind: job.kind, target: job.target, status: "failed", error: e.message });
  } finally { running = null; setImmediate(pump); }
}

function stop() { stopRequested = true; queue.length = 0; }
function current() { return running ? { id: running.id, kind: running.kind, target: running.target, queued: queue.length } : null; }

// ---------------------------------------------------------------- embedding + storage
async function storeDocument({ source, kind, locator, title, mime, bytes, pages, page_count, ocr_pages, fetched_at }, progressNote) {
  const db = open();
  const f = config.get().indexing.files;
  const text = pages.map((p) => p.text).join("\n");
  const hash = sha(text);
  const existing = db.prepare("SELECT id, content_hash, status FROM documents WHERE source_id=? AND locator=?").get(source.id, locator);
  if (existing && existing.content_hash === hash && existing.status === "ok") {
    db.prepare("UPDATE documents SET fetched_at=? WHERE id=?").run(fetched_at || now(), existing.id);
    return { id: existing.id, skipped: true };
  }
  const chunks = chunkPages(pages, { chunkChars: f.chunk_chars, overlapChars: f.chunk_overlap_chars });
  let vectors = [], embModel = null;
  if (chunks.length) {
    const p = providers.embeddingProvider();
    embModel = `${p.key}/${p.embedding_model}`;
    vectors = await providers.embed(chunks.map((c) => c.text));
  }
  const write = db.transaction(() => {
    let docId;
    if (existing) {
      docId = existing.id;
      db.prepare("DELETE FROM chunks WHERE document_id=?").run(docId);
      if (require("./db").vecLoaded && vectors.length) { try { db.prepare(`DELETE FROM chunk_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)`).run(docId); } catch {} }
      db.prepare("UPDATE documents SET title=?, mime=?, bytes=?, content_hash=?, page_count=?, char_count=?, ocr_pages=?, fetched_at=?, indexed_at=?, status='ok', error=NULL WHERE id=?")
        .run(title, mime, bytes || null, hash, page_count || null, text.length, ocr_pages || 0, fetched_at || now(), now(), docId);
    } else {
      docId = db.prepare("INSERT INTO documents(source_id, bundle_id, kind, locator, title, mime, bytes, content_hash, page_count, char_count, ocr_pages, fetched_at, indexed_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ok')")
        .run(source.id, source.bundle_id, kind, locator, title, mime, bytes || null, hash, page_count || null, text.length, ocr_pages || 0, fetched_at || now(), now()).lastInsertRowid;
    }
    const ins = db.prepare("INSERT INTO chunks(document_id, bundle_id, seq, text, location, embedding, embedding_model) VALUES (?,?,?,?,?,?,?)");
    const dim = vectors[0] ? vectors[0].length : 0;
    const useVec = ensureVec(dim);
    const insVec = useVec ? db.prepare("INSERT INTO chunk_vec(chunk_id, embedding) VALUES (?, ?)") : null;
    chunks.forEach((c, i) => {
      const blob = vectors[i] ? toBlob(vectors[i]) : null;
      const cid = ins.run(docId, source.bundle_id, c.seq, c.text, c.location, blob, embModel).lastInsertRowid;
      if (insVec && blob) insVec.run(BigInt(cid), blob);
    });
    return docId;
  });
  const id = write();
  return { id, skipped: false, chunks: chunks.length };
}

function markDocError(source, locator, kind, title, error) {
  const db = open();
  const ex = db.prepare("SELECT id FROM documents WHERE source_id=? AND locator=?").get(source.id, locator);
  if (ex) db.prepare("UPDATE documents SET status='error', error=?, indexed_at=? WHERE id=?").run(error, now(), ex.id);
  else db.prepare("INSERT INTO documents(source_id, bundle_id, kind, locator, title, status, error, indexed_at) VALUES (?,?,?,?,?,'error',?,?)").run(source.id, source.bundle_id, kind, locator, title, error, now());
}

function refreshSourceCounts(sourceId) {
  const db = open();
  const r = db.prepare("SELECT count(*) AS docs, coalesce(sum(page_count),0) AS pages FROM documents WHERE source_id=? AND status='ok'").get(sourceId);
  db.prepare("UPDATE sources SET doc_count=?, page_count=? WHERE id=?").run(r.docs, r.pages, sourceId);
}

// ---------------------------------------------------------------- files
function walk(root, exts, out = []) {
  const st = fs.statSync(root);
  if (st.isFile()) { if (exts.includes(path.extname(root).toLowerCase())) out.push(root); return out; }
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
    const full = path.join(root, ent.name);
    try { if (ent.isDirectory()) walk(full, exts, out); else if (ent.isFile() && exts.includes(path.extname(ent.name).toLowerCase())) out.push(full); } catch {}
  }
  return out;
}

async function indexPathSource(source, progress, { only } = {}) {
  const db = open();
  const root = config.expandHome(source.location);
  if (!fs.existsSync(root)) { db.prepare("UPDATE sources SET status='error', last_error=? WHERE id=?").run("Not found on disk", source.id); throw new Error(`${source.location} does not exist`); }
  const exts = config.get().indexing.files.extensions;
  const files = only ? only.filter((f) => exts.includes(path.extname(f).toLowerCase()) && fs.existsSync(f)) : walk(root, exts);
  db.prepare("UPDATE sources SET status='indexing', last_error=NULL WHERE id=?").run(source.id);
  let done = 0, added = 0, unchanged = 0, failed = 0;
  progress(0, files.length, `Scanning ${source.location}`);
  for (const file of files) {
    if (stopRequested) break;
    const rel = path.relative(root, file) || path.basename(file);
    try {
      const st = fs.statSync(file);
      // Cheap pre-check: same size + mtime as last time => skip without reading.
      const ex = db.prepare("SELECT id, content_hash, status, bytes, fetched_at FROM documents WHERE source_id=? AND locator=?").get(source.id, file);
      if (ex && ex.status === "ok" && ex.bytes === st.size && ex.fetched_at === st.mtime.toISOString()) { unchanged++; done++; progress(done, files.length, rel); continue; }
      const doc = await extractFile(file);
      const r = await storeDocument({ source, kind: "file", locator: file, title: doc.title, mime: doc.mime, bytes: st.size, pages: doc.pages, page_count: doc.page_count, ocr_pages: doc.ocr_pages, fetched_at: st.mtime.toISOString() });
      if (r.skipped) unchanged++; else added++;
    } catch (e) { failed++; markDocError(source, file, "file", path.basename(file), e.message); }
    done++; progress(done, files.length, rel);
  }
  if (!only) {
    // Files that are gone from disk leave the index too.
    const present = new Set(files);
    const stale = db.prepare("SELECT id, locator FROM documents WHERE source_id=?").all(source.id).filter((d) => !present.has(d.locator));
    for (const d of stale) db.prepare("DELETE FROM documents WHERE id=?").run(d.id);
  }
  db.prepare("UPDATE sources SET status=?, last_indexed_at=?, last_error=? WHERE id=?").run(stopRequested ? "stopped" : (failed && !added && !unchanged ? "error" : "ok"), now(), failed ? `${failed} file(s) could not be read` : null, source.id);
  refreshSourceCounts(source.id);
  return `${added} indexed, ${unchanged} unchanged, ${failed} failed`;
}

// ---------------------------------------------------------------- websites
async function indexWebsiteSource(source, progress) {
  const db = open();
  db.prepare("UPDATE sources SET status='indexing', last_error=NULL WHERE id=?").run(source.id);
  const cap = config.get().indexing.websites.max_pages_per_site;
  const known = {};
  for (const d of db.prepare("SELECT locator, content_hash, error FROM documents WHERE source_id=?").all(source.id)) {
    try { const meta = d.error && d.error.startsWith("{") ? JSON.parse(d.error) : {}; known[d.locator] = { etag: meta.etag, lastModified: meta.lastModified, links: meta.links, hash: d.content_hash }; } catch {}
  }
  let n = 0, added = 0, unchanged = 0, failed = 0;
  const seenNow = new Set();
  const stats = await crawl(source.location, {
    known, shouldStop: () => stopRequested,
    log: (m) => progress(n, cap, m),
    onPage: async (page) => {
      n++; seenNow.add(page.url);
      try {
        const r = await storeDocument({ source, kind: "web", locator: page.url, title: page.title, mime: page.mime, bytes: page.bytes, pages: page.pages, page_count: page.page_count, ocr_pages: page.ocr_pages, fetched_at: now() });
        // Conditional-request metadata rides in `error` (JSON) for ok docs — a small abuse, kept local to this file.
        db.prepare("UPDATE documents SET error=? WHERE id=? AND status='ok'").run(JSON.stringify({ etag: page.etag, lastModified: page.lastModified, links: page.links.slice(0, 500) }), r.id);
        if (r.skipped) unchanged++; else added++;
      } catch (e) { failed++; markDocError(source, page.url, "web", page.title || page.url, e.message); }
    },
  });
  unchanged += stats.notModified;
  db.prepare("UPDATE sources SET status=?, last_indexed_at=?, last_error=? WHERE id=?").run(stopRequested ? "stopped" : "ok", now(), stats.errors.length ? `${stats.errors.length} page(s) failed, e.g. ${stats.errors[0].url}: ${stats.errors[0].error}` : null, source.id);
  refreshSourceCounts(source.id);
  return `${stats.fetched} pages fetched (${added} new/changed, ${unchanged} unchanged, ${failed} failed)${stats.remaining ? `, stopped at the ${cap}-page cap with ${stats.remaining} links unvisited` : ""}`;
}

// ---------------------------------------------------------------- public API
function sourcesOfKind(kind, { bundleId, sourceId } = {}) {
  const db = open();
  let sql = "SELECT s.*, b.name AS bundle_name FROM sources s JOIN bundles b ON b.id=s.bundle_id WHERE s.kind=?";
  const args = [kind];
  if (bundleId) { sql += " AND s.bundle_id=?"; args.push(bundleId); }
  if (sourceId) { sql += " AND s.id=?"; args.push(sourceId); }
  return db.prepare(sql + " ORDER BY s.id").all(...args);
}

function indexFiles(opts = {}) {
  const list = sourcesOfKind("path", opts);
  return list.map((s) => enqueue("files", s.location, (progress) => indexPathSource(s, progress)));
}
function indexWebsites(opts = {}) {
  const list = sourcesOfKind("website", opts);
  return list.map((s) => enqueue("website", s.location, (progress) => indexWebsiteSource(s, progress)));
}
function indexSource(sourceId) {
  const s = open().prepare("SELECT * FROM sources WHERE id=?").get(sourceId);
  if (!s) throw new Error("No such source.");
  return s.kind === "path" ? indexFiles({ sourceId })[0] : indexWebsites({ sourceId })[0];
}

// ---------------------------------------------------------------- watching + schedule
// How many directories one source may have before we stop watching it live
// (macOS hands out a file descriptor per watched directory; past this it is
// EMFILE and, unhandled, a dead process). Such sources are still indexed on
// demand and on the schedule — they just don't pick up new files instantly.
const WATCH_MAX_DIRS = 1500;

function countDirs(root, limit) {
  let n = 0;
  (function walk(d, depth) {
    if (n > limit || depth > 16) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") { n++; walk(path.join(d, e.name), depth + 1); if (n > limit) return; } }
  })(root, 0);
  return n;
}

function startWatchers() {
  stopWatchers();
  if (!config.get().indexing.files.watch) return;
  let chokidar; try { chokidar = require("chokidar"); } catch { return; }
  for (const s of sourcesOfKind("path")) {
    const root = config.expandHome(s.location);
    if (!fs.existsSync(root)) continue;
    const dirs = fs.statSync(root).isDirectory() ? countDirs(root, WATCH_MAX_DIRS) : 0;
    if (dirs > WATCH_MAX_DIRS) { console.warn(`[watch] ${s.location} has more than ${WATCH_MAX_DIRS} folders — not watched live; use Re-index`); continue; }
    const pending = new Set(); let timer = null;
    const w = chokidar.watch(root, { ignoreInitial: true, ignored: /(^|[\/\\])(\.|node_modules)/, awaitWriteFinish: { stabilityThreshold: 1500 }, depth: 16 });
    const flush = () => { const files = [...pending].filter(supported); pending.clear(); if (files.length) enqueue("files", `${s.location} (${files.length} changed)`, (p) => indexPathSource(s, p, { only: files })); };
    const onChange = (f) => { pending.add(f); clearTimeout(timer); timer = setTimeout(flush, 2000); };
    w.on("add", onChange).on("change", onChange).on("unlink", () => { clearTimeout(timer); timer = setTimeout(() => enqueue("files", s.location, (p) => indexPathSource(s, p)), 2000); });
    // A watcher error (EMFILE, a vanished mount) must never take the server
    // down: stop watching that source and say so.
    w.on("error", (e) => { console.warn(`[watch] ${s.location}: ${e.code || e.message} — live watching stopped for this source`); w.close().catch(() => {}); watchers.delete(s.id); });
    watchers.set(s.id, w);
  }
}
function stopWatchers() { for (const w of watchers.values()) w.close().catch(() => {}); watchers.clear(); }

let recheckTimer = null;
function startScheduler() {
  clearInterval(recheckTimer);
  recheckTimer = setInterval(() => {
    const hours = config.get().indexing.websites.recheck_hours;
    if (!hours) return;
    const db = open();
    const due = db.prepare("SELECT * FROM sources WHERE kind='website' AND (last_indexed_at IS NULL OR last_indexed_at < datetime('now', ?))").all(`-${hours} hours`);
    for (const s of due) if (!queue.some((j) => j.target === s.location) && !(running && running.target === s.location)) enqueue("website", s.location, (p) => indexWebsiteSource(s, p));
  }, 10 * 60 * 1000);
}

function jobs(limit = 20) { return open().prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit); }

/** On startup: anything left 'running' or 'indexing' by a previous process died with it. */
function recoverStaleState() {
  const db = open();
  const n = db.prepare("UPDATE jobs SET status='stopped', finished_at=?, error=coalesce(error,'interrupted — the app was restarted') WHERE status IN ('queued','running')").run(now()).changes;
  db.prepare("UPDATE sources SET status = CASE WHEN doc_count > 0 THEN 'ok' ELSE 'pending' END, last_error = coalesce(last_error, 'Indexing was interrupted — run it again') WHERE status='indexing'").run();
  if (n) console.warn(`[index] ${n} job(s) were interrupted by a restart`);
}

module.exports = { recoverStaleState, events, indexFiles, indexWebsites, indexSource, stop, current, jobs, startWatchers, stopWatchers, startScheduler, walk };
