"use strict";
/**
 * File -> pages of text. Every popular office format, plus OCR for scanned
 * PDFs (a page with almost no extractable text is rasterised and read with
 * tesseract). Returns { title, mime, pages:[{text,label}], page_count,
 * ocr_pages }. Everything is pure npm — no system binaries to install.
 */
const fs = require("fs");
const path = require("path");
const config = require("./config");

const MIME = { ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".html": "text/html", ".htm": "text/html",
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".rtf": "application/rtf" };

function supported(file) { return Object.prototype.hasOwnProperty.call(MIME, path.extname(file).toLowerCase()); }

let pdfjsPromise = null;
function pdfjs() { return (pdfjsPromise ||= import("pdfjs-dist/legacy/build/pdf.mjs")); }

let tessWorker = null;
async function ocrImage(png) {
  if (!tessWorker) {
    const { createWorker } = require("tesseract.js");
    const cache = path.join(config.dataDir(), "tessdata");
    fs.mkdirSync(cache, { recursive: true });
    tessWorker = await createWorker("eng", 1, { cachePath: cache, logger: () => {} });
  }
  const { data } = await tessWorker.recognize(png);
  return data.text || "";
}

async function fromPdf(buffer, { ocr, ocrMinChars }) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = []; let ocrPages = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "", lastY = null;
    for (const it of content.items) {
      if (!("str" in it)) continue;
      const y = it.transform ? Math.round(it.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += "\n";
      text += it.str + (it.hasEOL ? "\n" : " ");
      lastY = y;
    }
    text = text.replace(/[ \t]+\n/g, "\n").trim();
    if (ocr && text.replace(/\s+/g, "").length < ocrMinChars) {
      try {
        const { createCanvas } = require("@napi-rs/canvas");
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const t = (await ocrImage(canvas.toBuffer("image/png"))).trim();
        if (t) { text = t; ocrPages++; }
      } catch (e) { text = text || ""; if (!fromPdf.warned) { fromPdf.warned = true; console.warn("[extract] OCR unavailable:", e.message); } }
    }
    pages.push({ text, label: `page ${i}` });
    page.cleanup();
  }
  let title = null;
  try { const m = await doc.getMetadata(); title = m.info && m.info.Title ? String(m.info.Title).trim() : null; } catch {}
  await doc.destroy();
  return { pages, title, ocrPages };
}

async function fromDocx(file) {
  const mammoth = require("mammoth");
  const r = await mammoth.extractRawText({ path: file });
  return { pages: [{ text: r.value, label: null }] };
}

function fromSheet(file) {
  const XLSX = require("xlsx");
  const wb = XLSX.readFile(file, { cellDates: true });
  const pages = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
    if (csv.trim()) pages.push({ text: csv, label: `sheet ${name}` });
  }
  return { pages };
}

async function fromPptx(file) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const pages = [];
  for (const n of names) {
    const xml = await zip.file(n).async("string");
    const text = xml.replace(/<a:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{2,}/g, "\n").trim();
    if (text) pages.push({ text, label: `slide ${n.match(/\d+/)[0]}` });
  }
  return { pages };
}

function fromHtml(html) {
  const { JSDOM } = require("jsdom");
  const { Readability } = require("@mozilla/readability");
  const dom = new JSDOM(html);
  const article = new Readability(dom.window.document).parse();
  const title = (article && article.title) || dom.window.document.title || null;
  const text = (article && article.textContent) || dom.window.document.body.textContent || "";
  return { pages: [{ text: text.replace(/\n{3,}/g, "\n\n").trim(), label: null }], title };
}

function fromRtf(s) {
  return s.replace(/\\par[d]?/g, "\n").replace(/\{\\\*[^{}]*\}/g, "").replace(/\\'[0-9a-f]{2}/g, "").replace(/\\[a-z]+-?\d* ?/g, "").replace(/[{}]/g, "").trim();
}

/** Extract a file on disk. Throws on unsupported / too large. */
async function extractFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) throw new Error(`Unsupported file type ${ext || "(none)"}`);
  const st = fs.statSync(file);
  const maxMb = config.get().indexing.files.max_file_mb || 50;
  if (st.size > maxMb * 1024 * 1024) throw new Error(`Larger than the ${maxMb} MB limit (Settings → Indexing · Files)`);
  const base = { title: path.basename(file), mime: MIME[ext], pages: [], page_count: 0, ocr_pages: 0 };
  let r;
  switch (ext) {
    case ".pdf": { const f = config.get().indexing.files; r = await fromPdf(fs.readFileSync(file), { ocr: !!f.ocr, ocrMinChars: f.ocr_min_chars_per_page || 40 }); if (r.title) base.title = r.title; base.ocr_pages = r.ocrPages; break; }
    case ".docx": r = await fromDocx(file); break;
    case ".xlsx": case ".xls": r = fromSheet(file); break;
    case ".pptx": r = await fromPptx(file); break;
    case ".html": case ".htm": r = fromHtml(fs.readFileSync(file, "utf8")); if (r.title) base.title = r.title; break;
    case ".rtf": r = { pages: [{ text: fromRtf(fs.readFileSync(file, "utf8")), label: null }] }; break;
    case ".json": { const raw = fs.readFileSync(file, "utf8"); let text = raw; try { text = JSON.stringify(JSON.parse(raw), null, 1); } catch {} r = { pages: [{ text, label: null }] }; break; }
    default: r = { pages: [{ text: fs.readFileSync(file, "utf8"), label: null }] };
  }
  base.pages = r.pages.filter((p) => p && p.text && p.text.trim());
  base.page_count = r.pages.length;
  return base;
}

/** Extract a fetched web resource (HTML or PDF) by content type. */
async function extractWeb(buffer, contentType, url) {
  if (/pdf/i.test(contentType) || /\.pdf($|\?)/i.test(url)) {
    const f = config.get().indexing.files;
    const r = await fromPdf(buffer, { ocr: !!f.ocr, ocrMinChars: f.ocr_min_chars_per_page || 40 });
    return { title: r.title || path.basename(new URL(url).pathname), mime: "application/pdf", pages: r.pages.filter((p) => p.text.trim()), page_count: r.pages.length, ocr_pages: r.ocrPages };
  }
  const r = fromHtml(buffer.toString("utf8"));
  return { title: r.title || url, mime: "text/html", pages: r.pages.filter((p) => p.text.trim()), page_count: 1, ocr_pages: 0 };
}

async function shutdown() { if (tessWorker) { await tessWorker.terminate(); tessWorker = null; } }

module.exports = { extractFile, extractWeb, supported, MIME, shutdown };
