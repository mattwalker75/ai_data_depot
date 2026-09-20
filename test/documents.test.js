// Generated documents: the document model, the renderers, and the request plumbing (no model, no server).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "depot-doc-"));
process.env.DEPOT_CONFIG = path.join(scratch, "config.json");
fs.writeFileSync(process.env.DEPOT_CONFIG, JSON.stringify({ data_dir: path.join(scratch, "data"), output: { dir: "./OUT", keep_days: 30 } }));

const dm = require("../src/docmodel");
const render = require("../src/render");
const documents = require("../src/documents");

test("docmodel: Markdown becomes typed blocks; client copy loses markers, cited copy gains a renumbered Sources list", () => {
  const md = "## Summary\nThe **Q1** payment is due 2026-04-15 [3].\n\nFrom general knowledge, not your sources:\nEstimated taxes are quarterly.\n\n## Steps\n1. Pay [3]\n2. File\n\n| Step | Due |\n|---|---|\n| Pay | 2026-04-15 |\n\n```mermaid\nflowchart LR\nA-->B\n```";
  const blocks = dm.mdToBlocks(md);
  assert.deepEqual(blocks.map((b) => b.kind), ["heading", "p", "p", "heading", "numbered", "table", "diagram"]);
  assert.deepEqual(blocks[5], { kind: "table", columns: ["Step", "Due"], rows: [["Pay", "2026-04-15"]] });
  const cits = [{ n: 1, title: "unused", locator: "/u" }, { n: 3, title: "note.eml", locator: "/x/note.eml", location: null }];
  const v = dm.variants({ title: "T", markdown: md, citations: cits, marker: "From general knowledge, not your sources:" });
  assert.equal(v.client.blocks[1].text, "The **Q1** payment is due 2026-04-15.");
  assert.equal(v.client.blocks[2].text, "Estimated taxes are quarterly.", "the general-knowledge marker line is gone from the client copy");
  assert.equal(v.cited.blocks[1].text, "The **Q1** payment is due 2026-04-15 [1].", "citations renumbered 1..k in the cited copy");
  assert.deepEqual(v.cited.citations.map((c) => [c.n, c.title]), [[1, "note.eml"]], "only the source actually used is listed");
  assert.equal(v.cited.blocks.at(-2).text, "Sources");
  assert.equal(dm.variants({ title: "Poem", markdown: "Roses are red.", citations: cits }).cited, null, "nothing cited → no cited copy");
  assert.match(dm.blocksToHtml(blocks), /<sup class="cite">\[3\]<\/sup>/);
  assert.match(dm.blocksToHtml([{ kind: "p", text: "<script>x</script>" }]), /&lt;script&gt;/, "escaped");
});

test("render: PDF, Word, Excel and text come out as real files", async () => {
  const v = { title: "Henderson Q1", blocks: dm.mdToBlocks("## Summary\nDue **2026-04-15**.\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |") };
  const pdf = await render.render("pdf", v); assert.equal(pdf.slice(0, 5).toString(), "%PDF-"); assert.ok(pdf.length > 1500);
  const docx = await render.render("docx", v); assert.equal(docx.slice(0, 2).toString(), "PK");
  const JSZip = require("jszip"); const z = await JSZip.loadAsync(docx); const xml = await z.file("word/document.xml").async("string");
  assert.match(xml, /Henderson Q1/); assert.match(xml, /2026-04-15/); assert.match(xml, /<w:tbl>/, "the table is a Word table");
  const txt = (await render.render("text", v)).toString(); assert.match(txt, /^# Henderson Q1\n\n## Summary/);
  const xl = await render.render("xlsx", { title: "t", sheets: [{ name: "Items", columns: [{ name: "Item", type: "text" }, { name: "Amount", type: "currency" }, { name: "Due", type: "date" }], rows: [["Q1", "$4,250", "2026-04-15"], ["Q2", 4250, ""]] }, { name: "Sources", columns: ["#", "Source"], rows: [[1, "note.eml"]] }] });
  const XLSX = require("xlsx"); const wb = XLSX.read(xl);
  assert.deepEqual(wb.SheetNames, ["Items", "Sources"]);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Items); assert.equal(rows[0].Amount, 4250, "currency text became a number"); assert.equal(rows[1].Due, undefined, "empty stays empty");
  await assert.rejects(render.render("xlsx", v), /tabular/);
});

test("documents: request block extraction, intent detection, normalisation", () => {
  const reply = "I'll draft that memo.\n\n```depot-file\n{\"type\":\"memo\",\"format\":\"word\",\"title\":\"Henderson Q1\",\"brief\":\"due dates\"}\n```\n";
  const ex = documents.extractRequest(reply);
  assert.equal(ex.text, "I'll draft that memo."); assert.deepEqual(documents.normalizeRequest(ex.request), { type: "memo", format: "docx", title: "Henderson Q1", brief: "due dates" });
  assert.equal(documents.extractRequest("no block here").request, null);
  assert.deepEqual(documents.normalizeRequest({ type: "memo", format: "xlsx" }).format, "pdf", "a memo cannot be a spreadsheet → the type's default");
  assert.equal(documents.normalizeRequest({ type: "nonsense", brief: "a spreadsheet of all deadlines" }).type, "table");
  const h = documents.detectIntent("Can you make me a spreadsheet of every filing deadline in the Henderson file?");
  assert.equal(h.type, "table"); assert.equal(h.format, "xlsx");
  assert.equal(documents.detectIntent("create me a poem about flowers and write it to a file for me").type, "freeform");
  assert.equal(documents.detectIntent("what is the deadline for Q1?"), null);
  assert.match(documents.FILE_RULE, /```depot-file/);
});

test("documents: fromText writes files into OUTPUT, lists them, cleanup only removes expired unkept files", async () => {
  const o = await documents.fromText({ title: "Answer one", markdown: "Hello **there** [1].", citations: [{ n: 1, title: "src", locator: "/s" }], format: "pdf", sessionId: "s1" });
  assert.equal(o.files.length, 2); assert.ok(o.files.every((f) => f.exists));
  assert.equal(documents.outputDir(), path.join(scratch, "OUT"), "output dir is relative to config.json");
  assert.ok(fs.existsSync(path.join(documents.outputDir(), o.files[0].name)));
  assert.equal(documents.list("s1").length, 1); assert.equal(documents.list("other").length, 0);
  assert.match(documents.previewHtml(o.id, "cited"), /Sources/); assert.doesNotMatch(documents.previewHtml(o.id, "client"), /\[1\]/);
  assert.throws(() => documents.fileFor("../etc/passwd"), /Not a generated file name/);
  // age it: nothing happens while kept, files go when old and unkept, the row stays and says expired
  const db = require("../src/db").open();
  db.prepare("UPDATE outputs SET created_at=? WHERE id=?").run(new Date(Date.now() - 40 * 864e5).toISOString(), o.id);
  documents.setKeep(o.id, true); assert.equal(documents.cleanup(), 0);
  documents.setKeep(o.id, false); assert.equal(documents.cleanup(), 2);
  const after = documents.get(o.id); assert.equal(after.expired, true); assert.ok(after.files.every((f) => !f.exists));
  // a stray file in OUTPUT is never touched
  fs.writeFileSync(path.join(documents.outputDir(), "mine.txt"), "keep me");
  db.prepare("UPDATE outputs SET keep=0").run(); documents.cleanup(); assert.ok(fs.existsSync(path.join(documents.outputDir(), "mine.txt")));
});
