"use strict";
/**
 * Backup = everything needed to rebuild this installation EXCEPT the files
 * themselves and the index built from them: the bundles and where their
 * sources live (paths and URLs — bookmarks, not copies), sessions, personas,
 * and config.json with the API keys removed. Restoring means: put the source
 * folders back where they were, restore, enter the keys, re-index.
 * The database is deliberately not included; it holds the text of every
 * indexed file and can be gigabytes.
 */
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const config = require("./config");
const { open } = require("./db");
const sessions = require("./sessions");
const personas = require("./personas");

function dir() { const d = path.join(config.dataDir(), "backups"); fs.mkdirSync(d, { recursive: true }); return d; }
function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }

/** Bundles with their sources — the "bookmarks" half of the backup. */
function manifest() {
  const db = open();
  const bundles = db.prepare("SELECT id, name, description, enabled, position FROM bundles ORDER BY position, id").all();
  for (const b of bundles) {
    b.sources = db.prepare("SELECT kind, location, options FROM sources WHERE bundle_id=? ORDER BY id").all(b.id)
      .map((s) => ({ kind: s.kind, location: s.location, options: s.options ? JSON.parse(s.options) : null }));
    delete b.id;
  }
  return { app: "ai_data_depot", format: 1, created_at: new Date().toISOString(), bundles };
}

function configWithoutKeys() {
  const cfg = JSON.parse(JSON.stringify(config.get()));
  for (const p of Object.values(cfg.models.providers || {})) if (p && p.api_key) p.api_key = "";
  return cfg;
}

const README = `AI Data Depot backup
====================
What is here:
  sources.json    your bundles and where their sources live (folder paths and website
                  addresses). The files themselves are NOT included — they stay where
                  they are on your computer.
  sessions/       saved conversations
  personas.json   personas you created
  config.json     settings, with API keys removed (enter them again after restoring)

To restore: in AI Data Depot open Settings -> General -> Restore from a backup and pick
this zip. Make sure the source folders exist at the same paths, then re-index.
`;

async function create() {
  const zip = new JSZip();
  zip.file("README.txt", README);
  zip.file("sources.json", JSON.stringify(manifest(), null, 2));
  zip.file("config.json", JSON.stringify(configWithoutKeys(), null, 2));
  const pf = path.join(config.dataDir(), "personas.json");
  if (fs.existsSync(pf)) zip.file("personas.json", fs.readFileSync(pf));
  const sd = path.join(config.dataDir(), "sessions");
  if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd)) if (f.endsWith(".json")) zip.file(`sessions/${f}`, fs.readFileSync(path.join(sd, f)));
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const name = `depot-backup-${stamp()}.zip`;
  fs.writeFileSync(path.join(dir(), name), buf);
  return { name, path: path.join(dir(), name), bytes: buf.length, bundles: manifest().bundles.length, sessions: zip.folder("sessions") ? Object.keys(zip.files).filter((k) => k.startsWith("sessions/") && k.endsWith(".json")).length : 0 };
}

function list() {
  return fs.readdirSync(dir()).filter((f) => /^depot-backup-.*\.zip$/.test(f)).sort().reverse()
    .map((f) => { const st = fs.statSync(path.join(dir(), f)); return { name: f, bytes: st.size, created_at: st.mtime.toISOString() }; });
}

function fileFor(name) {
  if (!/^depot-backup-[\w-]+\.zip$/.test(name)) throw new Error("Not a backup file name.");
  const f = path.join(dir(), name); if (!fs.existsSync(f)) throw new Error("That backup is not there any more.");
  return f;
}

/**
 * Merge a backup into this installation: bundles by name (created if
 * missing), sources by location, sessions and personas that are not already
 * here, and settings other than keys/paths. Nothing is deleted or overwritten.
 */
async function restore(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (n) => (zip.file(n) ? JSON.parse(await zip.file(n).async("string")) : null);
  const man = await read("sources.json");
  if (!man || man.app !== "ai_data_depot") throw new Error("That zip is not an AI Data Depot backup.");
  const db = open();
  const out = { bundles: 0, sources: 0, sessions: 0, personas: 0 };
  db.transaction(() => {
    for (const b of man.bundles || []) {
      let row = db.prepare("SELECT id FROM bundles WHERE name=?").get(b.name);
      if (!row) {
        const pos = (db.prepare("SELECT coalesce(max(position),0) AS p FROM bundles").get().p || 0) + 1;
        row = { id: db.prepare("INSERT INTO bundles(name, description, enabled, position) VALUES (?,?,?,?)").run(b.name, b.description || "", b.enabled ? 1 : 0, pos).lastInsertRowid };
        out.bundles++;
      }
      for (const s of b.sources || []) {
        if (db.prepare("SELECT 1 FROM sources WHERE bundle_id=? AND location=?").get(row.id, s.location)) continue;
        db.prepare("INSERT INTO sources(bundle_id, kind, location, options, status) VALUES (?,?,?,?,'pending')").run(row.id, s.kind, s.location, s.options ? JSON.stringify(s.options) : null);
        out.sources++;
      }
    }
  })();
  for (const n of Object.keys(zip.files).filter((k) => /^sessions\/.+\.json$/.test(k))) {
    try { const s = JSON.parse(await zip.file(n).async("string")); if (s.id && sessions.list().some((x) => x.id === s.id)) continue; sessions.save(s); out.sessions++; } catch {}
  }
  const pers = await read("personas.json");
  if (Array.isArray(pers)) {
    const have = new Set(personas.list().filter((p) => !p.builtin).map((p) => p.id));
    for (const p of pers) { try { if (!p.id || have.has(p.id)) continue; personas.save(p); out.personas++; } catch {} }
  }
  const cfg = await read("config.json");
  if (cfg) { delete cfg.server; delete cfg.data_dir; if (cfg.models && cfg.models.providers) for (const p of Object.values(cfg.models.providers)) delete p.api_key; config.update(cfg); }
  return out;
}

module.exports = { create, list, fileFor, restore, manifest };
