"use strict";
/**
 * Find the passages that answer a question, restricted to the enabled
 * bundles. Two searches are fused: vector similarity (meaning) and full-text
 * keywords (exact terms like "§1.263(a)-1" or a client's name, which
 * embeddings blur). Reciprocal-rank fusion merges them without tuning.
 */
const { open, fromBlob } = require("./db");
const providers = require("./providers");

function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }

/** WHERE fragment + params restricting chunks to the enabled bundles, or to one document when the user is asking about it alone. */
function scopeSql(bundleIds, documentId, col = "c") {
  if (documentId) return { sql: `${col}.document_id = ?`, params: [documentId] };
  return { sql: `${col}.bundle_id IN (${bundleIds.map(() => "?").join(",")})`, params: bundleIds };
}

function vectorSearch(qvec, bundleIds, k, documentId) {
  const db = open();
  const dbmod = require("./db");
  const scope = scopeSql(bundleIds, documentId);
  if (dbmod.vecLoaded) {
    try {
      // A single document is small: pull all its vectors and rank exactly rather than hoping the global top-N hits it.
      if (documentId) {
        const rows = db.prepare(`SELECT c.id, v.embedding FROM chunks c JOIN chunk_vec v ON v.chunk_id=c.id WHERE c.document_id=?`).all(documentId);
        return rows.map((r) => ({ id: r.id, score: cosine(qvec, fromBlob(r.embedding)) })).sort((a, b) => b.score - a.score).slice(0, k).map((r, i) => ({ ...r, rank: i + 1 }));
      }
      const rows = db.prepare(`SELECT v.chunk_id AS id, v.distance FROM chunk_vec v WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`).all(dbmod.toBlob(qvec), Math.max(k * 8, 100));
      const ids = rows.map((r) => Number(r.id));
      if (!ids.length) return [];
      const keep = new Set(db.prepare(`SELECT c.id FROM chunks c WHERE c.id IN (${ids.map(() => "?").join(",")}) AND ${scope.sql}`).all(...ids, ...scope.params).map((r) => r.id));
      return rows.filter((r) => keep.has(Number(r.id))).slice(0, k).map((r, i) => ({ id: Number(r.id), rank: i + 1, score: 1 - r.distance }));
    } catch (e) { /* fall through to the in-process scan */ }
  }
  const rows = db.prepare(`SELECT c.id, c.embedding FROM chunks c WHERE ${scope.sql} AND c.embedding IS NOT NULL`).all(...scope.params);
  return rows.map((r) => ({ id: r.id, score: cosine(qvec, fromBlob(r.embedding)) })).sort((a, b) => b.score - a.score).slice(0, k).map((r, i) => ({ ...r, rank: i + 1 }));
}

function ftsQuery(q) {
  // Keep it robust: each word becomes a prefix term; FTS syntax characters are dropped.
  const terms = String(q).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 1);
  return terms.length ? terms.map((t) => `"${t}"*`).join(" OR ") : null;
}

function keywordSearch(q, bundleIds, k, documentId) {
  const db = open();
  const match = ftsQuery(q);
  if (!match) return [];
  const scope = scopeSql(bundleIds, documentId);
  try {
    return db.prepare(`SELECT c.id, bm25(chunks_fts) AS s FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ? AND ${scope.sql} ORDER BY s LIMIT ?`)
      .all(match, ...scope.params, k).map((r, i) => ({ id: r.id, rank: i + 1, score: -r.s }));
  } catch { return []; }
}

/** Hybrid search -> [{chunk, document, bundle, score}] best first. `documentId` narrows everything to one document. */
async function search(query, { bundleIds, k = 12, documentId = null } = {}) {
  if ((!bundleIds || !bundleIds.length) && !documentId) return [];
  const [qvec] = await providers.embed([query]);
  const vec = vectorSearch(qvec, bundleIds || [], k * 2, documentId);
  const kw = keywordSearch(query, bundleIds || [], k * 2, documentId);
  const fused = new Map();
  const add = (list, w) => list.forEach((r) => fused.set(r.id, (fused.get(r.id) || 0) + w / (60 + r.rank)));
  add(vec, 1.0); add(kw, 0.8);
  const top = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  if (!top.length) return [];
  const db = open();
  const rows = db.prepare(`SELECT c.id, c.text, c.location, c.seq, d.id AS document_id, d.kind, d.locator, d.title, d.mime, b.id AS bundle_id, b.name AS bundle_name
                           FROM chunks c JOIN documents d ON d.id=c.document_id JOIN bundles b ON b.id=c.bundle_id WHERE c.id IN (${top.map(() => "?").join(",")})`).all(...top.map((t) => t[0]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return top.map(([id, score]) => ({ ...byId.get(id), score })).filter((r) => r.text);
}

module.exports = { search, cosine, ftsQuery };
