"use strict";
/**
 * Split extracted text into overlapping chunks that fit comfortably in a
 * model's context beside a dozen others. Boundaries prefer paragraph, then
 * sentence, then word breaks, so a chunk rarely starts mid-thought. Each
 * chunk keeps a human-readable `location` (page, sheet, heading) so a
 * citation can say where in the document the passage lives.
 */
function chunkText(text, { chunkChars = 2800, overlapChars = 300 } = {}) {
  const clean = String(text || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const out = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + chunkChars);
    if (end < clean.length) {
      // Prefer the best boundary KIND that still leaves a decently sized
      // chunk: paragraph, then sentence, then line, then word.
      const window = clean.slice(start, end);
      for (const [needle, keep] of [["\n\n", 1], [". ", 1], ["\n", 1], [" ", 0]]) {
        const cut = window.lastIndexOf(needle);
        if (cut > chunkChars * 0.5) { end = start + cut + keep; break; }
      }
    }
    const piece = clean.slice(start, end).trim();
    if (piece) out.push({ text: piece, start, end });
    if (end >= clean.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return out;
}

/**
 * Pages -> chunks. `pages` is [{text, label}] (label like "page 3" or
 * "sheet Q2"); each chunk carries the label(s) it spans.
 */
function chunkPages(pages, opts) {
  const out = [];
  let seq = 0;
  for (const page of pages) {
    for (const c of chunkText(page.text, opts)) out.push({ seq: seq++, text: c.text, location: page.label || null });
  }
  return out;
}

module.exports = { chunkText, chunkPages };
