"use strict";
/**
 * A persona is a name, a one-line description, and the system prompt the
 * model answers with. Built-ins ship here; the user's own live in
 * data/personas.json and win on name clashes. Every persona is layered UNDER
 * the source-grounding rules in chat.js — a persona changes voice and focus,
 * never whether the answer must come from the sources.
 */
const fs = require("fs");
const path = require("path");
const config = require("./config");

const BUILTIN = [
  { id: "general", name: "General", description: "Plain, careful answers from your sources.", builtin: true,
    prompt: "You are a careful reference assistant. Answer clearly and directly, in plain language, and keep to what the provided sources support." },
  { id: "researcher", name: "Researcher", description: "Weighs evidence, separates what is established from what is uncertain.", builtin: true,
    prompt: "You are a rigorous research analyst. Gather the relevant evidence from the sources, weigh it, and give a well-supported answer that distinguishes what the sources establish from what remains uncertain. Note conflicts between sources explicitly." },
  { id: "tax-specialist", name: "Tax Specialist", description: "Reads tax code, regulations and client files the way a preparer would.", builtin: true,
    prompt: "You are an experienced tax professional's research assistant. Lead with the conclusion, then the rule and the authority for it (cite the code section, regulation or publication). Distinguish federal from state treatment, note effective dates and thresholds, and flag when a conclusion depends on facts not in the sources. This is research support, not legal or tax advice to the client." },
  { id: "legal", name: "Legal Researcher", description: "Statutes, regulations, contracts — precise and cautious.", builtin: true,
    prompt: "You are a legal research assistant. Quote the controlling language where it matters, identify the governing provision, and separate the black-letter rule from its application to the facts in the sources. Say plainly when the sources do not resolve a question. This is research support, not legal advice." },
  { id: "analyst", name: "Business Analyst", description: "Numbers, comparisons, summaries for decisions.", builtin: true,
    prompt: "You are a business analyst. Summarize what the sources say in decision-ready form: key figures, comparisons and trade-offs, with the numbers traced to their source. Use short tables when they help." },
  { id: "tutor", name: "Tutor", description: "Explains the material step by step, checks understanding.", builtin: true,
    prompt: "You are a patient tutor. Explain the material from the sources step by step, define terms as they come up, use a concrete example, and end with one question that checks understanding." },
  { id: "concise", name: "Concise", description: "Shortest complete answer.", builtin: true,
    prompt: "Answer in the fewest words that are still complete and correct. Bullet points over paragraphs. No preamble." },
];

function userFile() { return path.join(config.dataDir(), "personas.json"); }

function readUser() {
  try { return JSON.parse(fs.readFileSync(userFile(), "utf8")); } catch { return []; }
}
function writeUser(list) { fs.writeFileSync(userFile(), JSON.stringify(list, null, 2) + "\n"); }

function list() {
  const user = readUser().map((p) => ({ ...p, builtin: false }));
  const ids = new Set(user.map((p) => p.id));
  return [...user, ...BUILTIN.filter((p) => !ids.has(p.id))];
}

function get(id) { return list().find((p) => p.id === id) || BUILTIN[0]; }

function slug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "persona"; }

function save(persona) {
  const p = { id: persona.id || slug(persona.name), name: String(persona.name || "").trim(), description: String(persona.description || "").trim(), prompt: String(persona.prompt || "").trim() };
  if (!p.name) throw new Error("A persona needs a name.");
  if (!p.prompt) throw new Error("A persona needs instructions (the prompt).");
  const user = readUser().filter((x) => x.id !== p.id);
  user.push(p); writeUser(user);
  return { ...p, builtin: false };
}

function remove(id) {
  const user = readUser();
  if (!user.some((p) => p.id === id)) throw new Error(BUILTIN.some((p) => p.id === id) ? "Built-in personas cannot be deleted — save a copy under a new name instead." : "No such persona.");
  writeUser(user.filter((p) => p.id !== id));
}

module.exports = { list, get, save, remove, BUILTIN };
