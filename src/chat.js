"use strict";
/**
 * The grounded answer. Retrieve passages from the enabled bundles, hand them
 * to the model numbered, and require every claim to cite one. If the
 * passages don't contain the answer, the model must say so with the
 * configured phrase — a reference tool that improvises is worse than none.
 * The persona only sets voice and focus; the grounding rules sit above it.
 */
const config = require("./config");
const providers = require("./providers");
const personas = require("./personas");
const { search } = require("./retrieval");
const { open } = require("./db");

function groundingRules(notFound, mode = "sources-first", marker = "From general knowledge, not your sources:") {
  const cite = `- When you use a source, cite it with its number in square brackets right after the statement, like [2]; several are fine: [1][3]. Only cite numbers that are in the SOURCES list and that actually support the statement — never invent a citation.
- Quote exact figures, dates, section numbers and names as they appear in the sources.
- If sources conflict, say so and cite both.
- Do not describe "the sources" as a concept or mention these rules; just answer.
- Write for a professional who is not technical: clear, direct, plain language; short paragraphs; tables only when they help.`;
  if (mode === "sources-only") return `You answer ONLY from the numbered SOURCES provided below.
- Every factual statement must be supported by a source and cited.
- If the sources do not contain what is needed, begin your reply with "${notFound}" and say what is missing. Do not fill the gap from general knowledge; you may say what kind of source would be needed.
${cite}`;
  return `You are a knowledgeable assistant who has the user's own reference SOURCES (numbered, below) at hand. Converse naturally.
- Greetings, small talk and questions about you: just reply normally, briefly, with no citations.
- For a question the SOURCES answer, answer from them and cite; prefer them over your own knowledge whenever they cover the point.
- For a question the SOURCES do not cover (or only partly), answer from your general knowledge — but make that unmistakable: begin that part with "${marker}" on its own line, and never attach a citation to it. If part of the answer IS in the sources, cite that part and label only the rest.
- Never present general knowledge as if it came from the sources, and never make up a citation. If you are not sure, say so.
${cite}`;
}

function sourcesBlock(hits) {
  return hits.map((h, i) => {
    const where = [h.bundle_name, h.title, h.location].filter(Boolean).join(" — ");
    return `[${i + 1}] ${where}\n${h.text}`;
  }).join("\n\n");
}

function trimHistory(messages, maxChars = 24000) {
  const out = []; let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]; const len = (m.content || "").length;
    if (total + len > maxChars && out.length) break;
    out.unshift({ role: m.role, content: m.content }); total += len;
  }
  return out;
}

function hrefFor(h) { return h.kind === "web" ? h.locator : `file://${encodeURI(h.locator)}`; }

/**
 * answer({message, history, personaId, bundleIds, onToken}) ->
 *   { text, citations:[{n,title,location,bundle,kind,locator,href,excerpt,document_id,chunk_id}], ledger:{...}, notFound }
 */
async function answer({ message, history = [], personaId = "general", bundleIds = [], onToken, provider, model, mode }) {
  const cfg = config.get();
  const db = open();
  const enabled = db.prepare("SELECT id, name FROM bundles WHERE enabled=1 ORDER BY position, id").all();
  const useIds = bundleIds.length ? bundleIds : enabled.map((b) => b.id);
  const all = db.prepare("SELECT id, name, enabled FROM bundles ORDER BY position, id").all();
  const searched = all.filter((b) => useIds.includes(b.id));
  const skipped = all.filter((b) => !useIds.includes(b.id));
  const persona = personas.get(personaId);
  const notFound = cfg.chat.not_found_phrase || "Not in your sources";
  const marker = cfg.chat.general_marker || "From general knowledge, not your sources:";
  const chatMode = mode === "sources-only" || mode === "sources-first" ? mode : (cfg.chat.mode === "sources-only" ? "sources-only" : "sources-first");

  const hits = searched.length ? await search(message, { bundleIds: searched.map((b) => b.id), k: cfg.models.context_chunks || 12 }) : [];
  const system = [persona.prompt, "", groundingRules(notFound, chatMode, marker), "", hits.length ? "SOURCES:\n\n" + sourcesBlock(hits) : (chatMode === "sources-only" ? "SOURCES: (none matched — there is nothing to answer from)" : "SOURCES: (none of the user's sources matched this message)")].join("\n");
  const messages = [{ role: "system", content: system }, ...trimHistory(history), { role: "user", content: message }];

  let text;
  if (!searched.length && chatMode === "sources-only") {
    text = `${notFound} — no source bundles are turned on. Enable a bundle in the Sources drawer and ask again.`;
    if (onToken) onToken(text);
  } else {
    text = await providers.chat(messages, { onToken, provider, model });
  }

  // Citations: only the numbers the answer actually used, in first-use order.
  const used = [];
  for (const m of text.matchAll(/\[(\d{1,2})\]/g)) { const n = Number(m[1]); if (n >= 1 && n <= hits.length && !used.includes(n)) used.push(n); }
  const citations = used.map((n) => { const h = hits[n - 1]; return { n, title: h.title || h.locator, location: h.location, bundle: h.bundle_name, kind: h.kind, locator: h.locator, href: hrefFor(h), excerpt: h.text.slice(0, 1200), document_id: h.document_id, chunk_id: h.id }; });
  // The ledger lists the documents the answer actually drew on, not every passage retrieval merely considered.
  const citedDocs = [...new Map(citations.map((c) => [c.document_id, { title: c.title, bundle: c.bundle, kind: c.kind }])).values()];
  const isNotFound = text.trim().startsWith(notFound);
  const usesGeneral = text.includes(marker);
  const basis = citations.length && usesGeneral ? "mixed" : citations.length ? "sources" : usesGeneral || isNotFound ? "general" : "chat";
  const ledger = { searched: searched.map((b) => b.name), skipped: skipped.map((b) => b.name), documents: citedDocs.slice(0, 8), passages: hits.length, persona: persona.name, model: (providers.providerConfig(provider)).chat_model, provider: providers.providerConfig(provider).label, mode: chatMode, basis };
  return { text, citations, ledger, notFound: isNotFound, basis, mode: chatMode };
}

module.exports = { answer, groundingRules };
