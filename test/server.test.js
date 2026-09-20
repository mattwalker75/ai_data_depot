// Boots the real server on a scratch port with a scratch config/data dir and
// checks the local-only trust boundary and the /api/open restriction.
const { test } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os");

const PORT = 8399;
let proc, tmp;
async function up() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "depot-test-"));
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ server: { port: PORT, host: "127.0.0.1", open_browser: false }, data_dir: path.join(tmp, "data") }));
  proc = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, DEPOT_CONFIG: path.join(tmp, "config.json"), DEPOT_NO_OPEN: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("server did not start");
}
// undici's fetch refuses to send a forged Host header, so use raw http for that case.
function raw(opts, body) {
  return new Promise((resolve, reject) => {
    const req = require("node:http").request({ host: "127.0.0.1", port: PORT, ...opts }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
    req.on("error", reject); if (body) req.write(body); req.end();
  });
}
function down() { if (proc) proc.kill(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }

test("local trust boundary: Host + Origin guard, /api/open restricted", async (t) => {
  await up(); t.after(down);
  const base = `http://127.0.0.1:${PORT}`;
  // DNS rebinding: a request whose Host is some other name is refused.
  let r = await raw({ path: "/api/state", headers: { host: "evil.example" } });
  assert.strictEqual(r.status, 421);
  r = await raw({ path: "/api/state", headers: { host: "localhost:8300" } }); assert.strictEqual(r.status, 200);
  r = await raw({ path: "/api/state", headers: { host: "[::1]:8300" } }); assert.strictEqual(r.status, 200);
  // Cross-site write refused; same-origin (browser headers) and header-less (curl) writes allowed.
  r = await fetch(`${base}/api/bundles`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }); assert.strictEqual(r.status, 403);
  r = await fetch(`${base}/api/bundles`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" }); assert.strictEqual(r.status, 403);
  r = await fetch(`${base}/api/bundles`, { method: "POST", headers: { "content-type": "application/json", origin: `http://localhost:${PORT}`, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ name: "T" }) }); assert.strictEqual(r.status, 200);
  // /api/open only opens what is indexed.
  r = await fetch(`${base}/api/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locator: "/etc/hosts" }) });
  assert.strictEqual(r.status, 400); assert.match((await r.json()).error, /in your index/);
  // config.json is private to the owner.
  const mode = fs.statSync(path.join(tmp, "config.json")).mode & 0o777;
  r = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat: { mode: "sources-only" } }) }); assert.strictEqual(r.status, 200);
  assert.strictEqual(fs.statSync(path.join(tmp, "config.json")).mode & 0o777, 0o600, `was ${mode.toString(8)}`);
  // maintenance endpoints answer
  r = await fetch(`${base}/api/maintenance/stats`); assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).bundles, 1);
  r = await fetch(`${base}/api/maintenance/compact`, { method: "POST" }); assert.strictEqual(r.status, 200);
});

// End to end against a fake OpenAI-compatible provider: index a folder (txt +
// eml), ask about one document, back up, restore into a fresh install.
test("end to end: index, focus on one document, backup and restore", async (t) => {
  const http = require("node:http");
  const fake = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
      if (req.url.endsWith("/embeddings")) {
        const input = JSON.parse(body).input;
        // A deterministic 8-dim "embedding": letter histogram, so similar text is near.
        const vec = (t) => { const v = new Array(8).fill(0); for (const ch of String(t).toLowerCase()) v[ch.charCodeAt(0) % 8] += 1; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: input.map((x, i) => ({ index: i, embedding: vec(x) })) }));
      } else if (req.url.endsWith("/chat/completions")) {
        const msgs = JSON.parse(body).messages; const sys = msgs[0].content; const last = msgs[msgs.length - 1].content;
        let reply = /ONE document/.test(sys) ? "Focused answer [1]." : "General answer [1].";
        if (/WRITING A DOCUMENT/.test(sys)) reply = "## Summary\nThe retainer is **$2,000** [1].\n\nFrom general knowledge, not your sources:\nRetainers are common.\n\n## Next steps\n1. Confirm the fee [1].\n2. Sign.";
        else if (/design a spreadsheet/.test(sys)) reply = JSON.stringify({ columns: [{ name: "Item", type: "text" }, { name: "Amount", type: "currency" }], one_row_is: "a fee" });
        else if (/extract rows/.test(sys)) reply = /retainer/i.test(last) ? JSON.stringify({ rows: [["Retainer", "$2,000"], ["Monthly fee", ""]] }) : JSON.stringify({ rows: [] });
        else if (/save it as a pdf/i.test(last)) reply = "I will make that memo.\n\n```depot-file\n{\"type\":\"memo\",\"format\":\"pdf\",\"title\":\"Henderson fees\",\"brief\":\"the retainer and fees\"}\n```";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`);
      } else if (req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "m" }] })); }
      else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((r) => fake.listen(8398, "127.0.0.1", r));
  t.after(() => fake.close());
  await up(); t.after(down);
  const base = `http://127.0.0.1:${PORT}`;
  const j = async (p, opts = {}) => { const r = await fetch(base + p, { headers: { "content-type": "application/json" }, ...opts, body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body }); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || r.status); return b; };
  await j("/api/settings", { method: "PUT", body: { models: { active: "custom", providers: { custom: { label: "Fake", base_url: "http://127.0.0.1:8398/v1", api_key: "k", chat_model: "m", embedding_model: "e" } } }, embeddings: { provider: "active" } } });
  // a folder with a note and an email
  const folder = path.join(tmp, "docs"); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "engagement.txt"), "Engagement letter for Henderson. Fees are billed monthly. The retainer is $2,000.");
  fs.copyFileSync(path.join(__dirname, "fixtures", "note.eml"), path.join(folder, "note.eml"));
  const { id: bundleId } = await j("/api/bundles", { method: "POST", body: { name: "Henderson" } });
  await j(`/api/bundles/${bundleId}/sources`, { method: "POST", body: { kind: "path", location: folder, index: true } });
  const t0 = Date.now(); let jobs;
  do { await new Promise((r) => setTimeout(r, 150)); jobs = await j("/api/index/jobs"); } while (jobs.current && Date.now() - t0 < 30000);
  const docs = await j("/api/documents");
  assert.equal(docs.length, 2, `both files indexed: ${JSON.stringify(jobs.jobs[0])}`);
  const email = docs.find((d) => d.locator.endsWith("note.eml")); assert.equal(email.title, "Q1 estimated payment");
  const im = (await j("/api/state")).index_models; assert.equal(im.current, "custom/e"); assert.equal(im.mismatch, 0);
  // focus: only the email's passages are offered, and the model is told so
  const sse = await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "when is the payment due", history: [], persona: "general", bundle_ids: [bundleId], mode: "sources-only", document_id: email.id }) });
  const txt = await sse.text(); const done = JSON.parse(txt.split("\n").find((l, i, a) => a[i - 1] === "event: done").slice(5));
  assert.equal(done.text, "Focused answer [1]."); assert.equal(done.ledger.focus, "Q1 estimated payment");
  assert.ok(done.citations.length === 1 && done.citations[0].locator.endsWith("note.eml"), "the citation is from the focused document");
  const gone = await (await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "x", document_id: 999999 }) })).text();
  assert.match(gone, /event: error[\s\S]*no longer in the index/, "a vanished focus document is a clear error, not an empty answer");
  // switching the embedding model is detected
  await j("/api/settings", { method: "PUT", body: { models: { providers: { custom: { embedding_model: "e2" } } } } });
  const im2 = (await j("/api/state")).index_models; assert.equal(im2.current, "custom/e2"); assert.equal(im2.mismatch, 2);
  // documents: the model hands over a request; generation writes two files; a table is built per document
  const chat2 = await (await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Write a memo about the fees and save it as a PDF", history: [], persona: "general", bundle_ids: [bundleId], mode: "sources-first" }) })).text();
  const done2 = JSON.parse(chat2.split("\n").find((l, i, a) => a[i - 1] === "event: done").slice(5));
  assert.equal(done2.text, "I will make that memo.", "the request block is stripped from the reply");
  assert.deepEqual(done2.file_request, { type: "memo", format: "pdf", title: "Henderson fees", brief: "the retainer and fees" });
  const out = await j("/api/outputs/generate", { method: "POST", body: { request: done2.file_request, session_id: "sess1", history: [], bundle_ids: [bundleId], mode: "sources-first", persona: "general" } });
  assert.equal(out.format, "pdf"); assert.equal(out.basis, "mixed"); assert.equal(out.files.length, 2, "client copy + cited copy");
  const pdfBytes = Buffer.from(await (await fetch(`${base}/output/${out.files[1].name}`)).arrayBuffer()); assert.equal(pdfBytes.slice(0, 5).toString(), "%PDF-");
  const prevC = await (await fetch(`${base}/api/outputs/${out.id}/preview?variant=client`)).text(); assert.doesNotMatch(prevC, /\[1\]|not your sources|Sources/); assert.match(prevC, /Retainers are common/, "general-knowledge content stays in the client copy, only its label goes");
  const prevS = await (await fetch(`${base}/api/outputs/${out.id}/preview?variant=cited`)).text(); assert.match(prevS, /<sup class="cite">\[1\]<\/sup>/); assert.match(prevS, /Sources/); assert.match(prevS, /engagement\.txt/);
  assert.equal((await j("/api/outputs?session=sess1")).outputs.length, 1);
  const hint = JSON.parse((await (await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "please put the fee schedule into a spreadsheet for me", bundle_ids: [bundleId] }) })).text()).split("\n").find((l, i, a) => a[i - 1] === "event: done").slice(5));
  assert.equal(hint.file_request, null); assert.equal(hint.file_hint.type, "table"); assert.equal(hint.file_hint.format, "xlsx", "no block from the model → the app offers the file from the message");
  const tbl = await j("/api/outputs/generate", { method: "POST", body: { request: { type: "table", format: "xlsx", title: "Fee schedule", brief: "every fee and amount" }, session_id: "sess1", bundle_ids: [bundleId], mode: "sources-only" } });
  assert.equal(tbl.format, "xlsx"); assert.equal(tbl.files.length, 2);
  const XLSX = require("xlsx"); const wb = XLSX.read(Buffer.from(await (await fetch(`${base}/output/${tbl.files[1].name}`)).arrayBuffer()));
  assert.deepEqual(wb.SheetNames, ["Fee schedule", "Sources"]);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Fee schedule"]); assert.equal(rows[0].Amount, 2000); assert.equal(rows[0].Source, "[1]");
  await assert.rejects(j("/api/outputs/generate", { method: "POST", body: { request: { type: "memo", format: "pdf", title: "Moon", brief: "poem about the moon" }, bundle_ids: [bundleId], document_id: 999999, mode: "sources-only" } }), /Not in your sources/, "sources-only with nothing matching refuses instead of inventing");
  assert.equal(await (await fetch(`${base}/output/..%2Fconfig.json`)).status, 400);
  // backup: bookmarks, no files, no keys
  const bk = await j("/api/maintenance/backups", { method: "POST" }); assert.equal(bk.bundles, 1); assert.ok(bk.bytes < 20000, "a backup is small");
  const dl = await fetch(`${base}/api/maintenance/backups/${bk.name}`);
  const zipBuf = Buffer.from(await dl.arrayBuffer());
  assert.equal(dl.status, 200, `download: ${zipBuf.slice(0, 200)}`); assert.equal(dl.headers.get("content-type"), "application/zip", "served as a zip");
  const JSZip = require("jszip"); const zip = await JSZip.loadAsync(zipBuf);
  assert.deepEqual(Object.keys(zip.files).filter((f) => !f.endsWith("/")).sort(), ["README.txt", "config.json", "sources.json"], "no database, no source files");
  const cfgOut = JSON.parse(await zip.file("config.json").async("string")); assert.equal(cfgOut.models.providers.custom.api_key, "", "keys stripped");
  const man = JSON.parse(await zip.file("sources.json").async("string")); assert.equal(man.bundles[0].sources[0].location, folder);
  // restore into this install: nothing duplicated; after deleting the bundle, everything comes back as bookmarks
  const restore = async () => { const r = await fetch(base + "/api/maintenance/restore", { method: "POST", headers: { "content-type": "application/zip" }, body: zipBuf }); const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; };
  assert.deepEqual(await restore(), { bundles: 0, sources: 0, sessions: 0, personas: 0 });
  await j(`/api/bundles/${bundleId}`, { method: "DELETE" });
  const r2 = await restore();
  assert.equal(r2.bundles, 1); assert.equal(r2.sources, 1);
  const st = await j("/api/state"); assert.equal(st.bundles[0].sources[0].status, "pending", "restored sources wait to be re-indexed");
});
