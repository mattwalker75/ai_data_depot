"use strict";
/**
 * The document model every generated file is rendered from.
 *
 * The model (LLM) writes Markdown for prose types and JSON sheets for
 * tabular ones; this module turns Markdown into a flat list of typed blocks
 * that the text / PDF / Word / HTML renderers all consume, and produces the
 * two variants of a document: the CLIENT copy (no citation markers, no
 * general-knowledge marker lines) and the CITED copy (markers kept, a
 * Sources section appended).
 *
 * Blocks:  { kind:"heading", level, text }   { kind:"p", text }
 *          { kind:"bullets", items:[text] }    { kind:"numbered", items:[text] }
 *          { kind:"table", columns:[text], rows:[[text]] }
 *          { kind:"code", lang, text }         { kind:"diagram", lang:"mermaid", text }   (rendered later)
 *          { kind:"rule" }
 * Inline text keeps **bold**, *italic*, `code` and [n] markers as-is; each
 * renderer decides what to do with them (PDF and Word render bold/italic,
 * text leaves them).
 */

function mdToBlocks(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^```\s*(\w*)\s*$/))) {
      const lang = (m[1] || "").toLowerCase(); const buf = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push(lang === "mermaid" ? { kind: "diagram", lang, text: buf.join("\n") } : { kind: "code", lang, text: buf.join("\n") });
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { blocks.push({ kind: "heading", level: m[1].length, text: m[2] }); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ kind: "rule" }); i++; continue; }
    if (isTableLine(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const columns = cells(line); i += 2; const rows = [];
      while (i < lines.length && isTableLine(lines[i])) { const r = cells(lines[i]); while (r.length < columns.length) r.push(""); rows.push(r.slice(0, columns.length)); i++; }
      blocks.push({ kind: "table", columns, rows }); continue;
    }
    if (/^\s*([-*+•]|\d+[.)])\s+/.test(line)) {
      const numbered = /^\s*\d+[.)]\s+/.test(line); const items = [];
      while (i < lines.length && /^\s*([-*+•]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*+•]|\d+[.)])\s+/, ""); i++;
        // continuation lines (indented) belong to the item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+•]|\d+[.)])\s+/.test(lines[i])) item += " " + lines[i].trim(), i++;
        items.push(item);
      }
      blocks.push({ kind: numbered ? "numbered" : "bullets", items }); continue;
    }
    // paragraph: consecutive non-empty, non-special lines
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+•]|\d+[.)])\s+)/.test(lines[i]) && !(isTableLine(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1]))) buf.push(lines[i].trim()), i++;
    if (buf.length) blocks.push({ kind: "p", text: buf.join(" ") });
  }
  return blocks;
}

/** Remove [n] markers and the general-knowledge marker; tidy the spacing they leave behind. */
function stripCitations(text, marker) {
  let t = String(text || "").replace(/\s*\[\d{1,2}\](?=[\s.,;:!?)]|$)/g, "");
  if (marker) t = t.split(marker).join("").replace(/\n{3,}/g, "\n\n");
  return t.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

function mapText(blocks, fn) {
  return blocks.map((b) => {
    if (b.kind === "p" || b.kind === "heading") return { ...b, text: fn(b.text) };
    if (b.kind === "bullets" || b.kind === "numbered") return { ...b, items: b.items.map(fn) };
    if (b.kind === "table") return { ...b, columns: b.columns.map(fn), rows: b.rows.map((r) => r.map(fn)) };
    return b;
  });
}

/** Renumber citations so the cited copy lists only the sources actually referenced, 1..k in first-use order. */
function usedCitations(markdown, citations) {
  const used = [];
  for (const m of String(markdown).matchAll(/\[(\d{1,2})\]/g)) { const n = Number(m[1]); if (citations.some((c) => c.n === n) && !used.includes(n)) used.push(n); }
  const map = new Map(used.map((n, i) => [n, i + 1]));
  const text = String(markdown).replace(/\[(\d{1,2})\]/g, (s, n) => (map.has(Number(n)) ? `[${map.get(Number(n))}]` : ""));
  const list = used.map((n) => ({ ...citations.find((c) => c.n === n), n: map.get(n) }));
  return { text, citations: list };
}

/**
 * Build both variants from a prose document.
 *   { client: { title, blocks }, cited: { title, blocks, citations } | null }
 * `cited` is null when nothing was cited (a poem, a general explanation).
 */
function variants({ title, markdown, citations = [], marker }) {
  const { text, citations: used } = usedCitations(markdown, citations);
  const client = { title, blocks: mapText(mdToBlocks(stripCitations(text, marker)), (t) => stripCitations(t, marker)) };
  if (!used.length) return { client, cited: null };
  const sources = { kind: "numbered", items: used.map((c) => `${c.title || c.locator}${c.location ? ` — ${c.location}` : ""} — ${c.locator}`) };
  const blocks = [...mdToBlocks(text), { kind: "heading", level: 2, text: "Sources" }, sources];
  return { client, cited: { title, blocks, citations: used } };
}

// ---------------------------------------------------------------- inline + HTML
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Inline Markdown (bold, italic, code, links, [n]) -> HTML. Escapes first. */
function inlineHtml(text) {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>').replace(/\[(\d{1,2})\]/g, '<sup class="cite">[$1]</sup>');
  return t;
}

/** Inline Markdown -> runs [{text, bold, italic, code}] for PDF/Word renderers. */
function inlineRuns(text) {
  const runs = []; const re = /(\*\*[^*]+\*\*|`[^`]+`|(?:^|(?<=[^*]))\*[^*\n]+\*)/g;
  let last = 0, m;
  const s = String(text);
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**")) runs.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("`")) runs.push({ text: tok.slice(1, -1), code: true });
    else runs.push({ text: tok.slice(1, -1), italic: true });
    last = m.index + tok.length;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs.length ? runs : [{ text: "" }];
}

/** Blocks -> a self-contained HTML fragment (the in-app preview for Word/Excel/text). */
function blocksToHtml(blocks) {
  return blocks.map((b) => {
    switch (b.kind) {
      case "heading": return `<h${Math.min(b.level + 1, 6)}>${inlineHtml(b.text)}</h${Math.min(b.level + 1, 6)}>`;
      case "p": return `<p>${inlineHtml(b.text)}</p>`;
      case "bullets": return `<ul>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</ul>`;
      case "numbered": return `<ol>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</ol>`;
      case "table": return `<table><thead><tr>${b.columns.map((c) => `<th>${inlineHtml(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      case "code": return `<pre>${escapeHtml(b.text)}</pre>`;
      case "diagram": return `<pre class="mermaid">${escapeHtml(b.text)}</pre>`;
      case "rule": return "<hr>";
      default: return "";
    }
  }).join("\n");
}

/** Plain text with light Markdown structure kept (the .txt / .md renderer). */
function blocksToMarkdown(blocks) {
  return blocks.map((b) => {
    switch (b.kind) {
      case "heading": return `${"#".repeat(b.level)} ${b.text}`;
      case "p": return b.text;
      case "bullets": return b.items.map((i) => `- ${i}`).join("\n");
      case "numbered": return b.items.map((i, n) => `${n + 1}. ${i}`).join("\n");
      case "table": return [`| ${b.columns.join(" | ")} |`, `| ${b.columns.map(() => "---").join(" | ")} |`, ...b.rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
      case "code": return "```" + (b.lang || "") + "\n" + b.text + "\n```";
      case "diagram": return "```mermaid\n" + b.text + "\n```";
      case "rule": return "---";
      default: return "";
    }
  }).join("\n\n");
}

/** Sheets ({name, columns:[{name,type}], rows:[[..]]}) -> blocks, for previews and PDF/Word delivery of tabular documents. */
function sheetsToBlocks(sheets) {
  const out = [];
  for (const s of sheets) {
    if (sheets.length > 1) out.push({ kind: "heading", level: 2, text: s.name });
    out.push({ kind: "table", columns: s.columns.map((c) => (typeof c === "string" ? c : c.name)), rows: s.rows.map((r) => r.map((v) => (v == null ? "" : String(v)))) });
  }
  return out;
}

module.exports = { mdToBlocks, stripCitations, usedCitations, variants, inlineHtml, inlineRuns, blocksToHtml, blocksToMarkdown, sheetsToBlocks, escapeHtml };
