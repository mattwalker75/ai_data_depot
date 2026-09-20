"use strict";
/**
 * Renderers: document model -> bytes. One function per format, all pure npm:
 *   text  -> Markdown            (.md)
 *   pdf   -> pdfkit              (.pdf)   headings, paragraphs, lists, tables, page numbers
 *   docx  -> docx                (.docx)  the same, as real Word structure
 *   xlsx  -> SheetJS             (.xlsx)  one sheet per table, typed cells
 * Each takes { title, blocks } (or { title, sheets } for xlsx) and returns a
 * Buffer. Nothing here talks to a model or the database.
 */
const { inlineRuns, blocksToMarkdown, sheetsToBlocks } = require("./docmodel");

const EXT = { text: ".md", pdf: ".pdf", docx: ".docx", xlsx: ".xlsx" };
const MIME = { ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

// ---------------------------------------------------------------- text
function renderText({ title, blocks }) {
  return Buffer.from(`# ${title}\n\n${blocksToMarkdown(blocks)}\n`, "utf8");
}

// ---------------------------------------------------------------- pdf
function renderPdf({ title, blocks, footer }) {
  const PDFDocument = require("pdfkit");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 64, bottom: 64, left: 64, right: 64 }, info: { Title: title, Producer: "AI Data Depot" }, bufferPages: true });
    const chunks = []; doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const body = () => doc.font("Helvetica").fontSize(10.5).fillColor("#1f2a2e");
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    // Inline runs (bold/italic/code) as one flowing text; x/y position only the first run.
    const runs = (text, opts = {}, x, y) => {
      const rs = inlineRuns(text);
      rs.forEach((r, i) => { doc.font(r.bold ? "Helvetica-Bold" : r.italic ? "Helvetica-Oblique" : r.code ? "Courier" : "Helvetica"); const o = { ...opts, continued: i < rs.length - 1 }; if (i === 0 && x !== undefined) doc.text(r.text, x, y, o); else doc.text(r.text, o); });
      doc.font("Helvetica");
    };
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#1f2a2e").text(title, { width: W });
    doc.moveDown(0.3); doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + W, doc.y).lineWidth(0.8).strokeColor("#0f6a63").stroke(); doc.moveDown(0.8);
    for (const b of blocks) {
      switch (b.kind) {
        case "heading": { const size = b.level <= 1 ? 16 : b.level === 2 ? 13.5 : 11.5; if (doc.y + 60 > bottom()) doc.addPage(); else doc.moveDown(0.6); doc.font("Helvetica-Bold").fontSize(size).fillColor(b.level <= 2 ? "#0f6a63" : "#1f2a2e").text(b.text, { width: W }); doc.moveDown(0.25); body(); break; }
        case "p": body(); runs(b.text, { width: W, lineGap: 2.5 }); doc.moveDown(0.6); break;
        case "bullets": case "numbered": {
          body();
          b.items.forEach((it, n) => {
            const marker = b.kind === "numbered" ? `${n + 1}.` : "•";
            const x = doc.page.margins.left, ind = 22;
            // keep marker and first line together: break before the item if it would not fit
            if (doc.y + doc.heightOfString(it.replace(/[*`]/g, ""), { width: W - ind }) > bottom()) doc.addPage();
            const y = doc.y;
            doc.text(marker, x + 4, y, { width: ind - 4, lineBreak: false });
            runs(it, { width: W - ind, lineGap: 2 }, x + ind, y);
            doc.x = x; doc.moveDown(0.2);
          });
          doc.x = doc.page.margins.left; doc.moveDown(0.5); break;
        }
        case "table": {
          body();
          const cols = b.columns.length || 1; const colW = W / cols; const pad = 5;
          const rowH = (cells, bold) => { doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5); return Math.max(...cells.map((c) => doc.heightOfString(String(c), { width: colW - pad * 2 }))) + pad * 2; };
          const drawRow = (cells, bold, fill) => {
            const h = rowH(cells, bold);
            if (doc.y + h > doc.page.height - doc.page.margins.bottom) { doc.addPage(); }
            const y = doc.y, x0 = doc.page.margins.left;
            if (fill) doc.rect(x0, y, W, h).fillColor(fill).fill();
            doc.fillColor("#1f2a2e").font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5);
            cells.forEach((c, i) => doc.text(String(c), x0 + i * colW + pad, y + pad, { width: colW - pad * 2 }));
            doc.moveTo(x0, y + h).lineTo(x0 + W, y + h).lineWidth(0.4).strokeColor("#ddd7c9").stroke();
            doc.x = x0; doc.y = y + h;
          };
          drawRow(b.columns, true, "#eef3f2");
          b.rows.forEach((r) => drawRow(r, false, null));
          doc.moveDown(0.8); body(); break;
        }
        case "code": case "diagram": doc.font("Courier").fontSize(9).fillColor("#1f2a2e").text(b.text, { width: W }); doc.moveDown(0.6); body(); break;
        case "rule": doc.moveDown(0.3); doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + W, doc.y).lineWidth(0.5).strokeColor("#ddd7c9").stroke(); doc.moveDown(0.6); break;
      }
    }
    // footer with page numbers — written inside the bottom margin, which pdfkit
    // would otherwise treat as overflow and answer with a new page.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      const keep = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(8.5).fillColor("#66707a");
      doc.text(`${footer || title}  ·  page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - keep + 20, { width: W, align: "center", lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}

// ---------------------------------------------------------------- docx
async function renderDocx({ title, blocks }) {
  const d = require("docx");
  const runsOf = (text, extra = {}) => inlineRuns(text).map((r) => new d.TextRun({ text: r.text, bold: !!r.bold || extra.bold, italics: !!r.italic, font: r.code ? "Courier New" : undefined, ...extra }));
  const children = [new d.Paragraph({ text: title, heading: d.HeadingLevel.TITLE })];
  const H = { 1: d.HeadingLevel.HEADING_1, 2: d.HeadingLevel.HEADING_2, 3: d.HeadingLevel.HEADING_3, 4: d.HeadingLevel.HEADING_4, 5: d.HeadingLevel.HEADING_5, 6: d.HeadingLevel.HEADING_6 };
  for (const b of blocks) {
    switch (b.kind) {
      case "heading": children.push(new d.Paragraph({ children: runsOf(b.text), heading: H[Math.min(b.level, 6)] })); break;
      case "p": children.push(new d.Paragraph({ children: runsOf(b.text), spacing: { after: 160 } })); break;
      case "bullets": b.items.forEach((it) => children.push(new d.Paragraph({ children: runsOf(it), bullet: { level: 0 } }))); break;
      case "numbered": b.items.forEach((it) => children.push(new d.Paragraph({ children: runsOf(it), numbering: { reference: "depot-numbers", level: 0 } }))); break;
      case "table": {
        const cell = (text, head) => new d.TableCell({ children: [new d.Paragraph({ children: runsOf(text, head ? { bold: true } : {}) })], shading: head ? { fill: "EEF3F2", type: d.ShadingType.CLEAR, color: "auto" } : undefined });
        const rows = [new d.TableRow({ tableHeader: true, children: b.columns.map((c) => cell(c, true)) }), ...b.rows.map((r) => new d.TableRow({ children: r.map((c) => cell(c, false)) }))];
        children.push(new d.Table({ rows, width: { size: 100, type: d.WidthType.PERCENTAGE } })); children.push(new d.Paragraph({ text: "" })); break;
      }
      case "code": case "diagram": b.text.split("\n").forEach((l) => children.push(new d.Paragraph({ children: [new d.TextRun({ text: l, font: "Courier New", size: 18 })] }))); break;
      case "rule": children.push(new d.Paragraph({ text: "", border: { bottom: { color: "DDD7C9", space: 1, style: d.BorderStyle.SINGLE, size: 6 } } })); break;
    }
  }
  const doc = new d.Document({
    creator: "AI Data Depot", title,
    numbering: { config: [{ reference: "depot-numbers", levels: [{ level: 0, format: d.LevelFormat.DECIMAL, text: "%1.", alignment: d.AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });
  return Buffer.from(await d.Packer.toBuffer(doc));
}

// ---------------------------------------------------------------- xlsx
function renderXlsx({ title, sheets }) {
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const safeName = (n, i) => { let s = String(n || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`; let k = s, j = 2; while (used.has(k)) k = `${s.slice(0, 28)} ${j++}`; used.add(k); return k; };
  sheets.forEach((s, i) => {
    const cols = s.columns.map((c) => (typeof c === "string" ? { name: c, type: "text" } : c));
    const aoa = [cols.map((c) => c.name), ...s.rows.map((r) => r.map((v, ci) => {
      const t = (cols[ci] && cols[ci].type) || "text";
      if (v == null || v === "") return null;
      if (t === "number" || t === "currency") { const n = Number(String(v).replace(/[^0-9.eE+-]/g, "")); return Number.isFinite(n) ? n : String(v); }
      return String(v);
    }))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = cols.map((c, ci) => ({ wch: Math.min(60, Math.max(10, ...aoa.map((r) => String(r[ci] == null ? "" : r[ci]).length + 2))) }));
    XLSX.utils.book_append_sheet(wb, ws, safeName(s.name, i));
  });
  wb.Props = { Title: title, Author: "AI Data Depot" };
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

/** Render one variant to bytes for `format`. Tabular documents delivered as text/pdf/docx are turned into table blocks first. */
async function render(format, variant) {
  const v = variant.sheets && !variant.blocks ? { ...variant, blocks: sheetsToBlocks(variant.sheets) } : variant;
  switch (format) {
    case "text": return renderText(v);
    case "pdf": return renderPdf(v);
    case "docx": return renderDocx(v);
    case "xlsx": if (!variant.sheets) throw new Error("A spreadsheet needs tabular content."); return renderXlsx(variant);
    default: throw new Error(`Unknown format ${format}`);
  }
}

module.exports = { render, renderText, renderPdf, renderDocx, renderXlsx, EXT, MIME };
