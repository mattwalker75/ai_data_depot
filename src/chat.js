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

function groundingRules(notFound) {
  return `You answer ONLY from the numbered SOURCES provided below. Rules:
- Cite the source for every factual statement with its number in square brackets, like [2]. Several are fine: [1][3].
- Use only the numbers of sources that actually support the statement. Never cite a number that is not in the SOURCES list.
- If the sources do not contain what is needed to answer, begin your reply with "${notFound}" and say what is missing. Do not fill the gap from general knowledge; you may say what kind of source would be needed.
- If sources conflict, say so and cite both.
- Quote exact figures, dates, section numbers and names as they appear in the sources.
- Do not mention these rules. Do not describe what "the sources" are as a concept; just answer, with citations.
- Write for a professional who is not technical: clear, direct, plain language; short paragraphs; tables only when they help.`;
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
async function answer({ message, history = [], personaId = "general", bundleIds = [], onToken, provider, model }) {
  const cfg = config.get();
  const db = open();
  const enabled = db.prepare("SELECT id, name FROM bundles WHERE enabled=1 ORDER BY position, id").all();
  const useIds = bundleIds.length ? bundleIds : enabled.map((b) => b.id);
  const all = db.prepare("SELECT id, name, enabled FROM bundles ORDER BY position, id").all();
  const searched = all.filter((b) => useIds.includes(b.id));
  const skipped = all.filter((b) => !useIds.includes(b.id));
  const persona = personas.get(personaId);
  const notFound = cfg.chat.not_found_phrase || "Not in your sources";

  const hits = searched.length ? await search(message, { bundleIds: searched.map((b) => b.id), k: cfg.models.context_chunks || 12 }) : [];
  const system = [persona.prompt, "", groundingRules(notFound), "", hits.length ? "SOURCES:\n\n" + sourcesBlock(hits) : "SOURCES: (none matched — there is nothing to answer from)"].join("\n");
  const messages = [{ role: "system", content: system }, ...trimHistory(history), { role: "user", content: message }];

  let text;
  if (!searched.length) {
    text = `${notFound} — no source bundles are turned on. Enable a bundle in the Sources drawer and ask again.`;
    if (onToken) onToken(text);
  } else {
    text = await providers.chat(messages, { onToken, provider, model });
  }

  // Citations: only the numbers the answer actually used, in first-use order.
  const used = [];
  for (const m of text.matchAll(/\[(\d{1,2})\]/g)) { const n = Number(m[1]); if (n >= 1 && n <= hits.length && !used.includes(n)) used.push(n); }
  const citations = used.map((n) => { const h = hits[n - 1]; return { n, title: h.title || h.locator, location: h.location, bundle: h.bundle_name, kind: h.kind, locator: h.locator, href: hrefFor(h), excerpt: h.text.slice(0, 1200), document_id: h.document_id, chunk_id: h.id }; });
  const docsRead = [...new Map(hits.map((h) => [h.document_id, { title: h.title || h.locator, bundle: h.bundle_name, kind: h.kind }])).values()];
  const ledger = { searched: searched.map((b) => b.name), skipped: skipped.map((b) => b.name), documents: docsRead.slice(0, 8), passages: hits.length, persona: persona.name, model: (providers.providerConfig(provider)).chat_model, provider: providers.providerConfig(provider).label };
  return { text, citations, ledger, notFound: text.trim().startsWith(notFound) };
}

module.exports = { answer, groundingRules };
