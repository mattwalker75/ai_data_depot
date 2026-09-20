"use strict";
/**
 * Diagrams in generated documents. The model writes Mermaid (flowchart,
 * sequence, timeline, pie, xychart…); Mermaid needs a browser to lay text
 * out, so the images embedded in PDF/Word files are made by borrowing the
 * user's installed Chromium browser headlessly for a moment: it opens this
 * app's /diagram.html, renders the code, and we capture the box as a PNG
 * over the DevTools protocol. No browser → no images (the file keeps the
 * Mermaid text with a note; the in-app preview still draws it live).
 *
 * One browser process serves one document (all its diagrams), then exits.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const config = require("./config");

const CANDIDATES = process.platform === "darwin" ? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Arc.app/Contents/MacOS/Arc",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] : process.platform === "win32" ? [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"];

/** Path of a usable Chromium browser, or null. `output.browser` in config.json overrides the search. */
function findBrowser() {
  const cfg = (config.get().output || {}).browser;
  if (cfg) return fs.existsSync(cfg) ? cfg : null;
  return CANDIDATES.find((p) => fs.existsSync(p)) || null;
}
function available() { return !!findBrowser() && typeof WebSocket === "function"; }

function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A short-lived headless browser session with a tiny DevTools client.
 *   const b = await Browser.open(appUrl); await b.render(code) → {png,width,height} | throws; await b.close()
 */
class Browser {
  static async open(appUrl) {
    const exe = findBrowser(); if (!exe) throw new Error("No Chromium browser installed (Chrome, Edge, Brave or Arc) — diagrams cannot be drawn into files.");
    if (typeof WebSocket !== "function") throw new Error("Node 22 or newer is needed to draw diagrams into files.");
    const port = await freePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "depot-diagram-"));
    const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    const b = new Browser(proc, profile, port, appUrl);
    try {
      let version = null;
      for (let i = 0; i < 100 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(100); } }
      if (!version) throw new Error("The browser did not start.");
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl + "/diagram.html")}`, { method: "PUT" })).json();
      b.targetId = target.id;
      await b.connect(target.webSocketDebuggerUrl);
      await b.send("Page.enable"); await b.send("Runtime.enable");
      await b.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1200, deviceScaleFactor: 2, mobile: false });
      // wait for the page (and mermaid) to be ready
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) { ready = await b.eval(`typeof window.renderDiagram === "function" && typeof mermaid === "object"`); if (!ready) await sleep(100); }
      if (!ready) throw new Error("The diagram page did not load.");
      return b;
    } catch (e) { await b.close(); throw e; }
  }
  constructor(proc, profile, port, appUrl) { this.proc = proc; this.profile = profile; this.port = port; this.appUrl = appUrl; this.id = 0; this.pending = new Map(); this.n = 0; }
  connect(url) {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error("DevTools connection failed"));
      this.ws.onmessage = (m) => { const j = JSON.parse(m.data); const p = this.pending.get(j.id); if (!p) return; this.pending.delete(j.id); j.error ? p.rej(new Error(j.error.message)) : p.res(j.result); };
    });
  }
  send(method, params = {}) {
    return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method} timed out`)); } }, 20000); });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text);
    return r.result.value;
  }
  /** Render one Mermaid diagram → { png: Buffer, width, height } (pixel size at 2×). Throws with Mermaid's message on bad syntax. */
  async render(code) {
    const r = await this.eval(`window.renderDiagram(${JSON.stringify(code)}, ${++this.n})`);
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : "Diagram could not be drawn.");
    const shot = await this.send("Page.captureScreenshot", { format: "png", clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }, captureBeyondViewport: true });
    return { png: Buffer.from(shot.data, "base64"), width: r.width * 2, height: r.height * 2 };
  }
  async close() {
    try { if (this.ws && this.ws.readyState === 1) { if (this.targetId) await this.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {}); this.ws.close(); } } catch {}
    try { this.proc.kill(); } catch {}
    await sleep(200); try { this.proc.kill("SIGKILL"); } catch {}
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Render every diagram block in place: on success the block gains
 * { image: base64 PNG, width, height }; a failure is returned so the caller
 * can ask the model to fix the code once. `appUrl` is this server's own URL.
 * Returns { rendered, failed: [{ index, error }], reason } — reason is set
 * when nothing could be rendered at all (no browser).
 */
async function renderBlocks(blocks, appUrl) {
  const idx = blocks.map((b, i) => (b.kind === "diagram" && !b.image ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return { rendered: 0, failed: [] };
  if (!available()) return { rendered: 0, failed: [], reason: "no-browser" };
  let browser;
  try { browser = await Browser.open(appUrl); } catch (e) { return { rendered: 0, failed: [], reason: e.message }; }
  const failed = []; let rendered = 0;
  try {
    for (const i of idx) {
      try { const r = await browser.render(blocks[i].text); blocks[i].image = r.png.toString("base64"); blocks[i].width = r.width; blocks[i].height = r.height; rendered++; }
      catch (e) { failed.push({ index: i, error: e.message }); }
    }
  } finally { await browser.close(); }
  return { rendered, failed };
}

module.exports = { findBrowser, available, Browser, renderBlocks };
