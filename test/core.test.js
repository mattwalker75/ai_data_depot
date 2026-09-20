"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Point config/data at a scratch dir so tests never touch a real config.json.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "depot-test-"));
process.env.DEPOT_CONFIG = path.join(scratch, "config.json");
const config = require("../src/config");
config.load(); config.update({ data_dir: path.join(scratch, "data") });

test("config: defaults merge under an edited file, keys mask and unmask", () => {
  config.update({ models: { providers: { openai: { api_key: "sk-proj-abcdefghijklmnop-98765" } } } });
  const red = config.redacted();
  assert.equal(red.models.providers.openai.api_key, "sk-pr••••••••98765", "first 5 and last 5 visible, nothing usable");
  assert.equal(config.maskKey("short"), "••••••••rt");
  assert.equal(red.models.providers.ollama.base_url, "http://localhost:11434/v1", "untouched defaults survive");
  const patch = config.unmaskKeys({ models: { providers: { openai: { api_key: "sk-pr••••••••98765", chat_model: "gpt-x" } } } });
  assert.equal(patch.models.providers.openai.api_key, "sk-proj-abcdefghijklmnop-98765", "a masked key means unchanged");
  assert.equal(config.unmaskKeys({ models: { providers: { openai: { api_key: "sk-new" } } } }).models.providers.openai.api_key, "sk-new", "a new key is taken as typed");
  const r = config.update({ server: { port: 8311 } });
  assert.deepEqual(r.restart_required, ["server.port"]);
  assert.deepEqual(config.update({ server: { port: 8311 } }).restart_required, [], "no change, no restart");
});

test("chunk: overlapping pieces that end on a boundary and cover the text", () => {
  const { chunkText, chunkPages } = require("../src/chunk");
  const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says something useful about depreciation.`).join(" ");
  const pieces = chunkText(text, { chunkChars: 400, overlapChars: 80 });
  assert.ok(pieces.length > 3);
  assert.ok(pieces.every((p) => p.text.length <= 400));
  assert.ok(pieces.slice(0, -1).every((p) => /\.$/.test(p.text)), "chunks end at a sentence");
  assert.ok(pieces[1].start < pieces[0].end, "consecutive chunks overlap");
  assert.equal(chunkText("   ").length, 0);
  const paged = chunkPages([{ text: "a".repeat(10), label: "page 1" }, { text: "b".repeat(10), label: "page 2" }]);
  assert.deepEqual(paged.map((c) => c.location), ["page 1", "page 2"]);
});

test("crawler: scope is same host under the root path, nothing else", () => {
  const { scopeOf, inScope, normalize } = require("../src/crawler");
  const s = scopeOf("https://www.irs.gov/privacy-disclosure");
  assert.equal(inScope("https://www.irs.gov/privacy-disclosure", s), true);
  assert.equal(inScope("https://www.irs.gov/privacy-disclosure/tax-code-regulations-and-official-guidance", s), true);
  assert.equal(inScope("https://www.irs.gov/privacy-disclosure-other", s), false, "a prefix of the name is not the path");
  assert.equal(inScope("https://www.irs.gov/forms", s), false);
  assert.equal(inScope("https://irs.gov/privacy-disclosure/x", s), false, "another host, even the apex");
  assert.equal(inScope("http://www.irs.gov/privacy-disclosure/x", s), false, "another scheme is another origin");
  const root = scopeOf("https://docs.example.com/");
  assert.equal(inScope("https://docs.example.com/anything/here", root), true, "a bare host allows the whole site");
  assert.equal(normalize("/a/b?utm_source=x&z=1&a=2#frag", "https://h.test/"), "https://h.test/a/b?a=2&z=1", "tracking params and fragments dropped, query sorted");
  assert.equal(normalize("mailto:x@y", "https://h.test/"), null);
});

test("retrieval: FTS query is robust to punctuation and section symbols", () => {
  const { ftsQuery, cosine } = require("../src/retrieval");
  assert.equal(ftsQuery("Section 179 HVAC §1.263(a)-1(f)"), '"section"* OR "179"* OR "hvac"* OR "263"*');
  assert.equal(ftsQuery("a"), null, "single letters are not worth a query");
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9 && Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});

test("sessions: save, list, export markdown, import gets a fresh id on clash", () => {
  const sessions = require("../src/sessions");
  const s = sessions.save({ ...sessions.blank("Henderson — 2025"), messages: [{ role: "user", content: "Q?" }, { role: "assistant", content: "A [1]", citations: [{ n: 1, title: "Pub 946", location: "page 2", href: "https://irs.gov/p946" }] }] });
  assert.ok(sessions.list().some((x) => x.id === s.id && x.message_count === 2));
  const mdText = sessions.toMarkdown(sessions.load(s.id));
  assert.match(mdText, /# Henderson — 2025/); assert.match(mdText, /1\. Pub 946 — page 2 <https:\/\/irs.gov\/p946>/);
  const imported = sessions.importJson(JSON.parse(JSON.stringify(s)));
  assert.notEqual(imported.id, s.id, "an import never overwrites an existing session");
  assert.throws(() => sessions.importJson({ nope: true }), /not an AI Data Depot session/);
  sessions.remove(s.id); sessions.remove(imported.id);
});

test("personas: built-ins are protected, user personas win by id", () => {
  const personas = require("../src/personas");
  assert.throws(() => personas.remove("general"), /Built-in/);
  const mine = personas.save({ name: "Estate Planner", description: "x", prompt: "Answer as an estate planner." });
  assert.equal(mine.id, "estate-planner");
  assert.ok(personas.list().some((p) => p.id === "estate-planner" && !p.builtin));
  assert.throws(() => personas.save({ name: "No prompt" }), /instructions/);
  personas.remove("estate-planner");
});

test("chat: the two modes — strict refuses, sources-first converses and labels general knowledge", () => {
  const { groundingRules } = require("../src/chat");
  const strict = groundingRules("Not in your sources", "sources-only");
  assert.match(strict, /ONLY from the numbered SOURCES/); assert.match(strict, /"Not in your sources"/); assert.match(strict, /\[2\]/);
  const first = groundingRules("Not in your sources", "sources-first", "From general knowledge, not your sources:");
  assert.match(first, /Converse naturally/); assert.match(first, /small talk/); assert.match(first, /"From general knowledge, not your sources:"/);
  assert.match(first, /never make up a citation/i);
  assert.doesNotMatch(first, /ONLY from the numbered SOURCES/);
});

test("crawler: scope modes — section, linked/site, page", () => {
  const { scopeOf, inScope } = require("../src/crawler");
  const s = scopeOf("https://www.irs.gov/individuals/get-transcript");
  const other = "https://www.irs.gov/forms-pubs/about-form-4506";
  assert.equal(inScope(other, s, "section"), false, "section: a sibling path is out");
  assert.equal(inScope(other, s, "linked"), true, "linked: same site is in (depth limits it)");
  assert.equal(inScope(other, s, "site"), true);
  assert.equal(inScope(other, s, "page"), false);
  assert.equal(inScope("https://www.irs.gov/individuals/get-transcript", s, "page"), true);
  assert.equal(inScope("https://example.org/individuals/get-transcript", s, "site"), false, "another host never");
  assert.equal(inScope("https://www.irs.gov/es/individuals/get-transcript", s, "linked"), false, "a translated copy is skipped");
  assert.equal(inScope("https://www.irs.gov/zh-hans/individuals", s, "site"), false);
  const es = scopeOf("https://www.irs.gov/es/individuals/get-transcript");
  assert.equal(inScope("https://www.irs.gov/es/forms", es, "site"), true, "…unless the start page itself is a translation");
});

test("embeddings: rate limits retry, oversized batches halve, other errors surface", async () => {
  const providers = require("../src/providers");
  config.update({ models: { active: "custom", providers: { custom: { label: "Fake", base_url: "http://fake.test/v1", api_key: "k", chat_model: "c", embedding_model: "e" } } }, embeddings: { batch_size: 4 } });
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body); const n = body.input.length; calls.push(n);
    const ok = (k) => new Response(JSON.stringify({ data: Array.from({ length: k }, (_, i) => ({ index: i, embedding: [i, 1] })) }), { status: 200, headers: { "content-type": "application/json" } });
    if (calls.length === 1) return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } });
    if (n === 4) return new Response(JSON.stringify({ error: { message: "Request too large for e" } }), { status: 429, headers: { "content-type": "application/json" } });
    return ok(n);
  };
  try {
    const out = await providers.embed(["a", "b", "c", "d"]);
    assert.equal(out.length, 4, "every text embedded after the retry and the halving");
    assert.deepEqual(calls, [4, 4, 2, 2], "429 retried once, 'too large' split into two halves");
    global.fetch = async () => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401, headers: { "content-type": "application/json" } });
    await assert.rejects(providers.embed(["x"]), /401/, "a non-transient error is not retried into oblivion");
  } finally { global.fetch = realFetch; }
});
