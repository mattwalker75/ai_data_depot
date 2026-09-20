"use strict";
/**
 * SQLite is the whole persistence layer: bundles, sources, documents, chunks,
 * chunk vectors (sqlite-vec when it loads, a plain BLOB fallback otherwise),
 * a full-text index for keyword hits, and crawl/index job state. One file
 * under data/. Sessions and personas are JSON files beside it, on purpose:
 * a session is something a person copies to a colleague.
 */
const path = require("path");
const Database = require("better-sqlite3");
const config = require("./config");

let db = null;
let vecLoaded = false;
let vecDim = 0;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bundles (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('path','website')), location TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', last_indexed_at TEXT, last_error TEXT,
  doc_count INTEGER NOT NULL DEFAULT 0, page_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (bundle_id, kind, location));
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, locator TEXT NOT NULL, title TEXT, mime TEXT, bytes INTEGER, content_hash TEXT,
  page_count INTEGER, char_count INTEGER, ocr_pages INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT, indexed_at TEXT, status TEXT NOT NULL DEFAULT 'ok', error TEXT,
  UNIQUE (source_id, locator));
CREATE INDEX IF NOT EXISTS ix_documents_bundle ON documents(bundle_id);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  bundle_id INTEGER NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, location TEXT,
  embedding BLOB, embedding_model TEXT);
CREATE INDEX IF NOT EXISTS ix_chunks_document ON chunks(document_id);
CREATE INDEX IF NOT EXISTS ix_chunks_bundle ON chunks(bundle_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text); END;
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT, status TEXT NOT NULL DEFAULT 'queued',
  progress_done INTEGER NOT NULL DEFAULT 0, progress_total INTEGER NOT NULL DEFAULT 0, message TEXT,
  started_at TEXT, finished_at TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

function open() {
  if (db) return db;
  const file = path.join(config.dataDir(), "depot.sqlite");
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    require("sqlite-vec").load(db);
    vecLoaded = true;
  } catch (e) {
    vecLoaded = false;
    console.warn("[db] sqlite-vec did not load (%s); using in-process vector search", e.message);
  }
  db.exec(SCHEMA);
  // Per-source options (website scope/depth), added after the first release.
  try { db.exec("ALTER TABLE sources ADD COLUMN options TEXT"); } catch {}
  return db;
}

/** Vector table is created lazily once we know the embedding dimension. */
function ensureVec(dim) {
  if (!vecLoaded || !dim) return false;
  if (vecDim === dim) return true;
  const row = db.prepare("SELECT value FROM meta WHERE key='vec_dim'").get();
  if (row && Number(row.value) !== dim) {
    // A different embedding model: rebuild the vector table.
    db.exec("DROP TABLE IF EXISTS chunk_vec");
  }
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dim}])`);
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('vec_dim', ?)").run(String(dim));
  vecDim = dim;
  return true;
}

function toBlob(vec) { return Buffer.from(new Float32Array(vec).buffer); }
function fromBlob(blob) { return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4); }

module.exports = { open, ensureVec, toBlob, fromBlob, get vecLoaded() { return vecLoaded; } };
