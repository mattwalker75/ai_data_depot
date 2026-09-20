"use strict";
/**
 * Generated documents: the user asks in chat for a memo, a summary, a
 * spreadsheet… and gets a file in OUTPUT/ with a preview and a download.
 *
 * The TYPE is what drives the model (what it is told, how much is retrieved,
 * what shape it must return, how it is checked); the FORMAT is only how the
 * result is delivered. Prose types return Markdown; tabular types return
 * JSON sheets, built in two passes (columns first, then rows per document)
 * so a table over many documents does not silently skip one.
 *
 * Every document is written as two files when anything was cited: the
 * CLIENT copy (no markers) and the CITED copy (markers + Sources). Rows in
 * the `outputs` table are the only things the retention sweep may delete.
 */
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { open } = require("./db");
const providers = require("./providers");
const personas = require("./personas");
const { search } = require("./retrieval");
const { groundingRules, sourcesBlock, trimHistory, hrefFor } = require("./chat");
const docmodel = require("./docmodel");
const render = require("./render");
const diagrams = require("./diagrams");

let APP_URL = null;
/** The server tells us its own address once listening; the headless browser loads /diagram.html from it. */
function setAppUrl(url) { APP_URL = url; }
function diagramsEnabled() { const o = config.get().output || {}; return o.diagrams !== false; }
const DIAGRAM_RULE = `You may include ONE diagram where it genuinely helps — a process or decision flow, a sequence of steps, a timeline of dates, or a handful of figures — as a fenced block starting with \`\`\`mermaid. Use only: flowchart LR or TD, sequenceDiagram, timeline, pie, or xychart-beta. Keep it small (at most 12 nodes, short labels, no styling directives), put the block where it belongs in the text, and precede it with one sentence saying what it shows. Do not add a diagram to a document that does not need one.`;

// ---------------------------------------------------------------- types
const TYPES = {
  memo: { label: "Memo / letter", formats: ["pdf", "docx", "text"], default: "pdf", shape: "prose",
    prompt: `Write a MEMO for a client or colleague who is not an expert. Use this skeleton with Markdown headings: "To / Re" line, "Summary" (the answer in 2–4 sentences), "Discussion" (explain why before what; short paragraphs; sub-headings if it helps), "Next steps" (a numbered list of concrete actions with dates where known). Professional, warm, plain language. Cite from SOURCES where a statement rests on one.` },
  summary: { label: "Summary / briefing", formats: ["pdf", "docx", "text"], default: "pdf", shape: "prose",
    prompt: `Write a SUMMARY BRIEFING. Lead with the answer in a short paragraph, then bullet points grouped under 2–5 Markdown headings, then "Key facts" as a small Markdown table if there are figures, dates or names worth lining up. Short, scannable, no filler. Cite from SOURCES where a statement rests on one.` },
  checklist: { label: "Checklist / next steps", formats: ["pdf", "docx", "xlsx", "text"], default: "pdf", shape: "prose",
    prompt: `Write a CHECKLIST of concrete actions. One short intro sentence, then a single Markdown table with exactly these columns: Step | Owner | Due | Why. Order by due date, earliest first; use ISO dates (2026-04-15) when known, "TBD" when not; "Why" is one sentence and carries the citation. Nothing after the table except an optional "Notes" section.` },
  table: { label: "Table / data extract", formats: ["xlsx", "pdf", "docx", "text"], default: "xlsx", shape: "sheets" },
  comparison: { label: "Comparison", formats: ["xlsx", "pdf", "docx", "text"], default: "pdf", shape: "sheets", comparison: true },
  freeform: { label: "Free-form", formats: ["pdf", "docx", "text"], default: "pdf", shape: "prose",
    prompt: `Write exactly the document the user described (a letter, an outline, a poem, an explanation — whatever they asked for), in Markdown, with headings only if they help. Follow the user's wording about tone and length. Cite from SOURCES only where a factual statement rests on one.` },
};
const FORMATS = { pdf: "PDF", docx: "Word", xlsx: "Excel", text: "Text (Markdown)" };

/** Normalise a request from the model or the user into { type, format, title, brief }. */
function normalizeRequest(r) {
  const type = TYPES[r.type] ? r.type : guessType(`${r.type || ""} ${r.brief || ""} ${r.title || ""}`) || "freeform";
  const t = TYPES[type];
  let format = String(r.format || "").toLowerCase().replace("word", "docx").replace("excel", "xlsx").replace("spreadsheet", "xlsx").replace(/^md$|markdown|txt|plain/, "text");
  if (!t.formats.includes(format)) format = t.default;
  const title = String(r.title || "").trim().slice(0, 120) || t.label;
  const brief = String(r.brief || "").trim().slice(0, 4000);
  return { type, format, title, brief };
}
function guessType(s) {
  s = String(s).toLowerCase();
  if (/\b(spreadsheet|excel|xlsx|table of|list of all|extract)\b/.test(s)) return "table";
  if (/\b(compar|versus|vs\.?|side by side)\b/.test(s)) return "comparison";
  if (/\b(checklist|next steps|action items|to-?do)\b/.test(s)) return "checklist";
  if (/\b(memo|letter|memorandum)\b/.test(s)) return "memo";
  if (/\b(summary|summari[sz]e|briefing|brief|overview|report)\b/.test(s)) return "summary";
  return null;
}
function guessFormat(s) {
  s = String(s).toLowerCase();
  if (/\b(pdf)\b/.test(s)) return "pdf";
  if (/\b(word|docx|\.doc)\b/.test(s)) return "docx";
  if (/\b(excel|xlsx|spreadsheet)\b/.test(s)) return "xlsx";
  if (/\b(text file|markdown|\.txt|\.md)\b/.test(s)) return "text";
  return null;
}
/** Does this user message look like a request for a file? Used when the model did not emit a request block. */
function detectIntent(message) {
  const s = String(message || "");
  const asks = /\b(make|create|generate|write|produce|turn|put|save|export|give)\b[\s\S]{0,80}\b(file|document|pdf|word doc|docx|spreadsheet|excel|xlsx|memo|memorandum|letter|report|briefing|checklist|summary document)\b/i.test(s) || /\b(into|as|to) an? (pdf|word|excel|spreadsheet|file|document|memo|letter)\b/i.test(s);
  if (!asks) return null;
  const type = guessType(s) || "freeform";
  return { type, format: guessFormat(s) || TYPES[type].default, title: "", brief: s.trim() };
}

/** The rule appended to the chat system prompt so the model hands file requests to the app instead of writing them inline. */
const FILE_RULE = `FILES: if the user asks you to create, write or generate a file or document (a memo, letter, summary, briefing, checklist, spreadsheet, table, comparison, poem, PDF, Word or Excel file…), do NOT write the document in your reply. Reply with one or two sentences saying what you will make, then on its own line exactly this block:
\`\`\`depot-file
{"type":"memo|summary|checklist|table|comparison|freeform","format":"pdf|docx|xlsx|text","title":"a short title","brief":"what it must contain, specific, in the user's words plus what you know from the conversation"}
\`\`\`
Pick the type by what the document IS (a spreadsheet of items → table; actions → checklist; a poem or anything else → freeform). Pick the format the user asked for; if they did not say, leave format empty. If they only want the answer in chat, answer normally with no block.`;

/** Pull a depot-file block out of a reply. Returns { text, request } — text with the block removed. */
function extractRequest(text) {
  const m = String(text).match(/```depot-file\s*\n([\s\S]*?)```/);
  if (!m) return { text, request: null };
  let request = null;
  try { request = JSON.parse(m[1].trim()); } catch { try { request = JSON.parse(m[1].slice(m[1].indexOf("{"), m[1].lastIndexOf("}") + 1)); } catch {} }
  return { text: text.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim(), request: request && typeof request === "object" ? request : null };
}

// ---------------------------------------------------------------- storage
function outputDir() {
  const d = config.get().output && config.get().output.dir || "./OUTPUT";
  const abs = path.isAbsolute(d) ? d : path.resolve(path.dirname(config.CONFIG_PATH), d);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document"; }
function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
/** A file name inside OUTPUT/, or throw — never a path. */
function fileFor(name) {
  if (!/^[\w.-]+$/.test(name) || name.includes("..")) throw new Error("Not a generated file name.");
  const f = path.join(outputDir(), name);
  if (!fs.existsSync(f)) throw new Error("That file has been removed (files expire after " + keepDays() + " days).");
  return f;
}
function keepDays() { const o = config.get().output || {}; return Number.isFinite(o.keep_days) ? o.keep_days : 30; }
function now() { return new Date().toISOString(); }

function rowOut(r) {
  if (!r) return null;
  const files = JSON.parse(r.files || "[]").map((f) => ({ ...f, exists: fs.existsSync(path.join(outputDir(), f.name)) }));
  return { id: r.id, session_id: r.session_id, title: r.title, type: r.type, type_label: TYPES[r.type] ? TYPES[r.type].label : r.type, format: r.format, format_label: FORMATS[r.format] || r.format, basis: r.basis, created_at: r.created_at, keep: !!r.keep, expires_at: r.keep ? null : new Date(new Date(r.created_at).getTime() + keepDays() * 864e5).toISOString(), files, expired: files.length > 0 && files.every((f) => !f.exists) };
}
function list(sessionId) {
  const db = open();
  const rows = sessionId ? db.prepare("SELECT * FROM outputs WHERE session_id=? ORDER BY id DESC").all(sessionId) : db.prepare("SELECT * FROM outputs ORDER BY id DESC LIMIT 500").all();
  return rows.map(rowOut);
}
function get(id) { return rowOut(open().prepare("SELECT * FROM outputs WHERE id=?").get(id)); }
function model(id) { const r = open().prepare("SELECT model FROM outputs WHERE id=?").get(id); return r ? JSON.parse(r.model) : null; }
function setKeep(id, keep) { open().prepare("UPDATE outputs SET keep=? WHERE id=?").run(keep ? 1 : 0, id); return get(id); }
function remove(id) {
  const r = get(id); if (!r) return;
  for (const f of r.files) { try { fs.rmSync(path.join(outputDir(), f.name), { force: true }); } catch {} }
  open().prepare("DELETE FROM outputs WHERE id=?").run(id);
}
/** Startup sweep: files of unkept outputs older than keep_days go; the rows stay (the card says "expired"). Only files this table knows about are touched. */
function cleanup() {
  const db = open(); const cutoff = Date.now() - keepDays() * 864e5; let removed = 0;
  for (const r of db.prepare("SELECT * FROM outputs WHERE keep=0").all()) {
    if (new Date(r.created_at).getTime() > cutoff) continue;
    for (const f of JSON.parse(r.files || "[]")) { const p = path.join(outputDir(), f.name); if (fs.existsSync(p)) { try { fs.rmSync(p); removed++; } catch {} } }
  }
  return removed;
}

// ---------------------------------------------------------------- generation
function chatModel(provider) { return providers.providerConfig(provider); }

/** Ask the model once, no streaming; strip an outer ``` fence if it wrapped the whole thing. */
async function ask(messages, provider) {
  let out = await providers.chat(messages, { provider, max_tokens: Math.max(config.get().models.max_tokens || 2000, 4000) });
  out = out.trim();
  const fence = out.match(/^```(?:markdown|md|json)?\s*\n([\s\S]*?)\n```$/);
  return fence ? fence[1].trim() : out;
}
function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}

function conversationBlock(history) {
  const msgs = trimHistory(history.filter((m) => m.role === "user" || m.role === "assistant"), 16000);
  if (!msgs.length) return "";
  return "CONVERSATION SO FAR (context only — cite the SOURCES below, not this):\n" + msgs.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${docmodel.stripCitations(m.content)}`).join("\n\n");
}

/**
 * generate(request, ctx) -> output record.
 * ctx: { sessionId, history, bundleIds, documentId, mode, personaId, provider }
 */
async function generate(rawRequest, ctx = {}) {
  const req = normalizeRequest(rawRequest || {});
  const t = TYPES[req.type];
  const cfg = config.get();
  const mode = ctx.mode === "sources-only" ? "sources-only" : "sources-first";
  const notFound = cfg.chat.not_found_phrase || "Not in your sources";
  const marker = cfg.chat.general_marker || "From general knowledge, not your sources:";
  const db = open();
  const bundleIds = (ctx.bundleIds && ctx.bundleIds.length ? ctx.bundleIds : db.prepare("SELECT id FROM bundles WHERE enabled=1").all().map((b) => b.id));
  const persona = personas.get(ctx.personaId || "general");
  const query = [req.title, req.brief].filter(Boolean).join(". ");
  const result = t.shape === "sheets"
    ? await generateSheets(req, { ...ctx, bundleIds, mode, notFound, persona, query, cfg })
    : await generateProse(req, { ...ctx, bundleIds, mode, notFound, marker, persona, query, cfg });
  // render + write
  const dir = outputDir(); const base = `${slug(req.title)}-${stamp()}`; const ext = render.EXT[req.format];
  const files = [];
  const write = async (variant, tag) => {
    const buf = await render.render(req.format, variant);
    const name = `${base}${tag ? "-" + tag : ""}${ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    files.push({ variant: tag ? "cited" : "client", name, bytes: buf.length });
  };
  await write(result.client, "");
  if (result.cited) await write(result.cited, "cited");
  const info = db.prepare("INSERT INTO outputs(session_id, title, type, format, basis, created_at, keep, model, files) VALUES (?,?,?,?,?,?,0,?,?)")
    .run(ctx.sessionId || null, req.title, req.type, req.format, result.basis, now(), JSON.stringify({ client: result.client, cited: result.cited, citations: result.citations || [] }), JSON.stringify(files));
  return get(info.lastInsertRowid);
}

async function generateProse(req, c) {
  const k = (c.cfg.output && c.cfg.output.context_chunks) || 24;
  const hits = (c.bundleIds.length || c.documentId) ? await search(c.query, { bundleIds: c.bundleIds, k, documentId: c.documentId || null }) : [];
  if (c.mode === "sources-only" && !hits.length) throw new Error(`${c.notFound} — nothing in your enabled bundles matches "${req.title}". Switch off Sources only to write it from general knowledge.`);
  const system = [c.persona.prompt, "", groundingRules(c.notFound, c.mode, c.marker), "",
    `You are now WRITING A DOCUMENT, not chatting. ${TYPES[req.type].prompt}`,
    `Output only the document body in Markdown — no preamble, no closing remark, no title line (the title "${req.title}" is added by the app). Use headings with #, lists with -, tables with |.`,
    diagramsEnabled() && req.type !== "checklist" ? DIAGRAM_RULE : "Do not include diagrams or code blocks.",
    c.mode === "sources-only" ? "Every factual statement must cite a SOURCE; leave out anything the sources do not support and say so in one line at the end under a heading \"Not covered by the sources\"." : `Where you rely on general knowledge rather than the SOURCES, start that paragraph with "${c.marker}".`,
    "", hits.length ? "SOURCES:\n\n" + sourcesBlock(hits) : "SOURCES: (none matched)"].join("\n");
  const user = [conversationBlock(c.history || []), "", `DOCUMENT TO WRITE — title: ${req.title}`, req.brief ? `What it must contain: ${req.brief}` : ""].filter(Boolean).join("\n");
  let md = await ask([{ role: "system", content: system }, { role: "user", content: user }], c.provider);
  if (!md.trim()) throw new Error("The model returned an empty document. Try again or rephrase.");
  // drop a duplicated title line
  md = md.replace(new RegExp(`^#\\s+${req.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`), "");
  const citations = hits.map((h, i) => ({ n: i + 1, title: h.title || h.locator, location: h.location, bundle: h.bundle_name, kind: h.kind, locator: h.locator, href: hrefFor(h), document_id: h.document_id, chunk_id: h.id }));
  md = await drawDiagrams(md, c.provider);
  const v = docmodel.variants({ title: req.title, markdown: md, citations, marker: c.marker });
  attachDiagramImages(v);
  if (c.mode === "sources-only" && !v.cited) throw new Error(`${c.notFound} — the model could not support "${req.title}" from your sources.`);
  const basis = v.cited ? (md.includes(c.marker) ? "mixed" : "sources") : "general";
  // xlsx delivery of a prose type (checklist): tables become sheets
  if (req.format === "xlsx") {
    const toSheets = (blocks) => { const tables = blocks.filter((b) => b.kind === "table"); if (!tables.length) throw new Error("The document has no table to put in a spreadsheet — ask for it as PDF or Word, or as a table."); return tables.map((b, i) => ({ name: i === 0 ? req.title.slice(0, 31) : `Table ${i + 1}`, columns: b.columns.map((n) => ({ name: n, type: "text" })), rows: b.rows })); };
    v.client = { title: req.title, sheets: toSheets(v.client.blocks) };
    if (v.cited) v.cited = { title: req.title, sheets: [...toSheets(v.cited.blocks), { name: "Sources", columns: [{ name: "#", type: "number" }, { name: "Source", type: "text" }, { name: "Where", type: "text" }], rows: v.cited.citations.map((x) => [x.n, x.title, `${x.location ? x.location + " — " : ""}${x.locator}`]) }] };
  }
  return { client: v.client, cited: v.cited, basis, citations: v.cited ? v.cited.citations : [] };
}

// ---------------------------------------------------------------- diagrams
const diagramImages = new Map(); // normalised mermaid code → { image, width, height } for the document being built
const diagKey = (t) => String(t).replace(/\s+/g, " ").trim();
/**
 * Render the Mermaid blocks of a Markdown document with the headless browser.
 * A block that fails to parse is sent back to the model once with the error;
 * if it still fails (or no browser is available) the block stays as text and
 * the renderers print a note instead of an image. Returns the (possibly
 * corrected) Markdown; images are kept in `diagramImages` for attachDiagramImages().
 */
async function drawDiagrams(md, provider) {
  diagramImages.clear();
  if (!diagramsEnabled() || !/```mermaid/.test(md)) return md;
  const blocks = docmodel.mdToBlocks(md).filter((b) => b.kind === "diagram");
  if (!blocks.length) return md;
  if (!APP_URL || !diagrams.available()) return md;
  const r = await diagrams.renderBlocks(blocks, APP_URL);
  for (const b of blocks) if (b.image) diagramImages.set(diagKey(b.text), { image: b.image, width: b.width, height: b.height });
  if (r.failed.length) {
    // one correction round
    const fixes = [];
    for (const f of r.failed) {
      const bad = blocks[f.index].text;
      const fixed = await ask([{ role: "system", content: "You fix Mermaid diagram syntax. Return ONLY the corrected Mermaid code, no fences, no commentary. Keep the meaning; simplify labels if that is what it takes (no parentheses or special characters inside node labels unless quoted)." },
        { role: "user", content: `This Mermaid code fails with: ${f.error}

${bad}` }], provider);
      fixes.push({ bad, fixed: fixed.replace(/^```\w*\n?|```$/g, "").trim() });
    }
    const retry = fixes.map((x) => ({ kind: "diagram", text: x.fixed }));
    const r2 = await diagrams.renderBlocks(retry, APP_URL);
    fixes.forEach((x, i) => { if (retry[i].image) { diagramImages.set(diagKey(x.fixed), { image: retry[i].image, width: retry[i].width, height: retry[i].height }); md = md.replace("```mermaid\n" + x.bad + "\n```", "```mermaid\n" + x.fixed + "\n```"); } });
    void r2;
  }
  return md;
}
/** Put rendered images on the diagram blocks of both variants (they were built from the same Markdown). */
function attachDiagramImages(v) {
  const put = (blocks) => { for (const b of blocks || []) if (b.kind === "diagram") { const im = diagramImages.get(diagKey(b.text)); if (im) Object.assign(b, im); else b.note = diagrams.available() && APP_URL ? "Diagram could not be drawn (the Mermaid below did not parse):" : "Diagram not drawn — no Chromium browser is installed to render it. The Mermaid source:"; } };
  put(v.client && v.client.blocks); put(v.cited && v.cited.blocks);
}

/** Tabular documents: columns first, then rows per document, then merge. */
async function generateSheets(req, c) {
  const maxDocs = (c.cfg.output && c.cfg.output.max_documents) || 12;
  const db = open();
  // 1. columns
  const colSys = `You design a spreadsheet. Given what the user wants, return ONLY JSON: {"columns":[{"name":"...","type":"text|number|date|currency"}], "one_row_is":"what one row represents, in a few words"}. 3 to 8 columns; names written as a person would write a column header ("Transcript types", not "transcript_types"); the first column identifies the item. ${TYPES[req.type].comparison ? 'This is a COMPARISON: the first column is "Criterion" and there is one further column per thing being compared.' : ""}`;
  const colUser = [conversationBlock(c.history || []), "", `SPREADSHEET — title: ${req.title}`, req.brief ? `What it must contain: ${req.brief}` : ""].filter(Boolean).join("\n");
  let spec = parseJson(await ask([{ role: "system", content: colSys }, { role: "user", content: colUser }], c.provider));
  if (!spec || !Array.isArray(spec.columns) || !spec.columns.length) spec = parseJson(await ask([{ role: "system", content: colSys }, { role: "user", content: colUser + "\n\nYour previous answer was not valid JSON with a non-empty columns array. Return only the JSON." }], c.provider));
  if (!spec || !Array.isArray(spec.columns) || !spec.columns.length) throw new Error("The model could not decide the columns for this table. Try describing the rows you want.");
  const columns = spec.columns.slice(0, 8).map((x) => ({ name: String(x.name || "").slice(0, 40) || "Item", type: ["number", "date", "currency"].includes(x.type) ? x.type : "text" }));
  // 2. candidate documents
  let docs;
  if (c.documentId) docs = db.prepare("SELECT id, title, locator, kind FROM documents WHERE id=? AND status='ok'").all(c.documentId);
  else {
    const hits = c.bundleIds.length ? await search(c.query, { bundleIds: c.bundleIds, k: maxDocs * 6 }) : [];
    const seen = new Map(); for (const h of hits) if (!seen.has(h.document_id)) seen.set(h.document_id, { id: h.document_id, title: h.title, locator: h.locator, kind: h.kind });
    docs = [...seen.values()].slice(0, maxDocs);
  }
  if (!docs.length) {
    if (c.mode === "sources-only") throw new Error(`${c.notFound} — nothing in your enabled bundles matches "${req.title}".`);
    // general knowledge table (e.g. "a table of the planets")
    const gSys = `Fill a spreadsheet from your general knowledge. Columns: ${JSON.stringify(columns)}. Return ONLY JSON {"rows":[[...],[...]]} with values in column order; ISO dates; numbers as numbers; empty string when unknown. No commentary.`;
    const g = parseJson(await ask([{ role: "system", content: gSys }, { role: "user", content: colUser }], c.provider));
    const rows = g && Array.isArray(g.rows) ? g.rows.filter(Array.isArray).map((r) => columns.map((_, i) => r[i] == null ? "" : r[i])) : [];
    if (!rows.length) throw new Error("The model produced no rows for this table.");
    return { client: { title: req.title, sheets: [{ name: req.title.slice(0, 31), columns, rows }] }, cited: null, basis: "general", citations: [] };
  }
  // 3. rows per document
  const rowSys = `You extract rows for a spreadsheet from ONE document. Columns: ${JSON.stringify(columns)}. One row is: ${spec.one_row_is || "one item"}. Return ONLY JSON {"rows":[[...]]} — values in column order, taken from the document text; ISO dates (2026-04-15); numbers as plain numbers; "" when the document does not say. Do not invent values. If the document has nothing relevant, return {"rows":[]}. No commentary.`;
  const allRows = []; const citations = []; let n = 0;
  for (const d of docs) {
    const chunks = db.prepare("SELECT text, location FROM chunks WHERE document_id=? ORDER BY seq").all(d.id);
    let text = "", budget = 14000; for (const ch of chunks) { if (budget <= 0) break; const piece = (ch.location ? `[${ch.location}] ` : "") + ch.text + "\n"; text += piece.slice(0, budget); budget -= piece.length; }
    if (!text.trim()) continue;
    const r = parseJson(await ask([{ role: "system", content: rowSys }, { role: "user", content: `DOCUMENT: ${d.title || d.locator}\n\n${text}\n\nWhat the spreadsheet is for: ${req.title}. ${req.brief || ""}` }], c.provider));
    const rows = r && Array.isArray(r.rows) ? r.rows.filter(Array.isArray).map((row) => columns.map((_, i) => row[i] == null ? "" : row[i])).filter((row) => row.some((v) => String(v).trim())) : [];
    if (!rows.length) continue;
    n++; citations.push({ n, title: d.title || d.locator, location: null, bundle: null, kind: d.kind, locator: d.locator, href: hrefFor(d), document_id: d.id });
    for (const row of rows) allRows.push({ row, n });
  }
  if (!allRows.length) throw new Error(`${c.notFound} — none of the ${docs.length} documents examined had rows for "${req.title}".`);
  const sheetName = req.title.slice(0, 31);
  const client = { title: req.title, sheets: [{ name: sheetName, columns, rows: allRows.map((x) => x.row) }] };
  const cited = { title: req.title, citations, sheets: [
    { name: sheetName, columns: [...columns, { name: "Source", type: "text" }], rows: allRows.map((x) => [...x.row, `[${x.n}]`]) },
    { name: "Sources", columns: [{ name: "#", type: "number" }, { name: "Source", type: "text" }, { name: "Where", type: "text" }], rows: citations.map((x) => [x.n, x.title, x.locator]) }] };
  return { client, cited, basis: "sources", citations };
}

/** Render text the user already has (a chat reply) as a file, no model involved. */
async function fromText({ title, markdown, citations = [], format = "pdf", sessionId, basis }) {
  const req = normalizeRequest({ type: "freeform", format: format === "xlsx" ? "pdf" : format, title: title || "Answer" });
  const marker = config.get().chat.general_marker || "From general knowledge, not your sources:";
  const v = docmodel.variants({ title: req.title, markdown, citations, marker });
  const dir = outputDir(); const base = `${slug(req.title)}-${stamp()}`; const ext = render.EXT[req.format]; const files = [];
  const write = async (variant, tag) => { const buf = await render.render(req.format, variant); const name = `${base}${tag ? "-" + tag : ""}${ext}`; fs.writeFileSync(path.join(dir, name), buf); files.push({ variant: tag ? "cited" : "client", name, bytes: buf.length }); };
  await write(v.client, ""); if (v.cited) await write(v.cited, "cited");
  const info = open().prepare("INSERT INTO outputs(session_id, title, type, format, basis, created_at, keep, model, files) VALUES (?,?,?,?,?,?,0,?,?)")
    .run(sessionId || null, req.title, "freeform", req.format, basis || (v.cited ? "sources" : "general"), now(), JSON.stringify({ client: v.client, cited: v.cited, citations: v.cited ? v.cited.citations : [] }), JSON.stringify(files));
  return get(info.lastInsertRowid);
}

/** HTML fragment for the in-app preview of one variant. */
function previewHtml(id, variant) {
  const m = model(id); if (!m) throw new Error("No such document.");
  const v = variant === "cited" ? m.cited : m.client; if (!v) throw new Error("This document has no cited copy.");
  const blocks = v.blocks || docmodel.sheetsToBlocks(v.sheets);
  return `<h1>${docmodel.escapeHtml(v.title)}</h1>\n${docmodel.blocksToHtml(blocks)}`;
}

module.exports = { setAppUrl, diagramsEnabled, attachDiagramImages, _diagramImages: diagramImages, TYPES, FORMATS, FILE_RULE, normalizeRequest, detectIntent, extractRequest, generate, fromText, list, get, remove, setKeep, cleanup, fileFor, outputDir, previewHtml, keepDays };
