"use strict";
/**
 * A scoped crawler, deliberately NOT a search engine. Given a root URL it
 * follows links only on the same host and under the root's path, breadth
 * first, up to a page cap and a depth cap, one request at a time with a
 * polite delay, honouring robots.txt. HTML pages are reduced to their
 * readable article text; PDFs linked within scope are downloaded and read
 * too (tax authorities publish as PDF). Nothing outside the scope is ever
 * requested.
 */
const config = require("./config");
const { extractWeb } = require("./extract");

const SKIP_EXT = /\.(jpe?g|png|gif|svg|webp|ico|css|js|mjs|json|xml|rss|zip|gz|tar|mp[34]|mov|avi|woff2?|ttf|eot|docx?|xlsx?|pptx?)($|\?)/i;
const TRACKING = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];

/** The scope a root URL defines: same origin, path prefix. */
function scopeOf(rootUrl) {
  const u = new URL(rootUrl);
  const pagePath = u.pathname.replace(/\/+$/, "");
  const seg = firstSegment(u.pathname);
  return { origin: u.origin, pagePath: pagePath || "/", langPrefix: !!seg && LANG_SEG.test(seg) };
}

function normalize(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = "";
  for (const t of TRACKING) u.searchParams.delete(t);
  u.searchParams.sort();
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  return s;
}

/**
 * Scope modes (per website source):
 *   section  the page and everything under its path   /privacy-disclosure/…
 *   linked   any page on the same site within N link-hops of the start page
 *   site     any page on the same site
 *   page     the start page only
 * Other hosts are never in scope, whatever the mode.
 */
const SCOPES = ["section", "linked", "site", "page"];
// Sites like irs.gov link every page to its translations (/es/, /zh-hans/,
// /ko/ …). Those are duplicates that would eat the page budget, so a link
// whose first path segment is a language code is skipped unless the start
// page itself lives under one.
const LANG_SEG = /^(?:[a-z]{2}|zh-han[st]|pt-br|es-mx|fr-ca)$/i;
function firstSegment(pathname) { return (pathname.split("/").filter(Boolean)[0] || "").toLowerCase(); }
function isTranslationCopy(url, scope) {
  const seg = firstSegment(new URL(url).pathname);
  return !!seg && LANG_SEG.test(seg) && !scope.langPrefix;
}
function inScope(url, scope, mode = "section") {
  const u = new URL(url);
  if (u.origin !== scope.origin) return false;
  const p = u.pathname.replace(/\/+$/, "") || "/";
  if (mode === "page") return p === scope.pagePath;
  if (isTranslationCopy(url, scope) && p !== scope.pagePath) return false;
  if (mode === "site" || mode === "linked") return true;
  // section: under the root path, or the root page itself.
  return p === scope.pagePath || p.startsWith(scope.pagePath + "/") || (scope.pagePath === "/");
}

async function fetchWithTimeout(url, { timeout, userAgent, headers = {} }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, { headers: { "user-agent": userAgent, accept: "text/html,application/pdf;q=0.9,*/*;q=0.5", ...headers }, redirect: "follow", signal: ctl.signal });
  } finally { clearTimeout(t); }
}

async function robotsFor(origin, opts) {
  if (!opts.respect_robots) return null;
  try {
    const r = await fetchWithTimeout(origin + "/robots.txt", opts);
    if (!r.ok) return null;
    return require("robots-parser")(origin + "/robots.txt", await r.text());
  } catch { return null; }
}

/** All links on a page with their visible text: [{url, text}], deduped by url. */
function extractLinks(html, base) {
  const cheerio = require("cheerio");
  const $ = cheerio.load(html);
  const out = new Map();
  $("a[href]").each((_, a) => { const n = normalize($(a).attr("href"), base); if (!n) return; const text = $(a).text().replace(/\s+/g, " ").trim().slice(0, 120); if (!out.has(n) || (!out.get(n) && text)) out.set(n, text); });
  return [...out].map(([url, text]) => ({ url, text }));
}

/**
 * Crawl. onPage({url, title, pages, mime, links, status, etag, lastModified}) is awaited per page.
 * `known` = {url: {etag,lastModified,hash}} lets a re-check send conditional requests.
 * Returns {visited, fetched, skipped, notModified, errors:[{url,error}]}.
 */
async function crawl(rootUrl, { onPage, known = {}, shouldStop = () => false, log = () => {}, mode = "section", depth } = {}) {
  const opts = { ...config.get().indexing.websites };
  if (!SCOPES.includes(mode)) mode = "section";
  if (mode === "page") opts.max_depth = 0;
  else if (mode === "linked") opts.max_depth = Math.max(0, Number(depth) || 2);
  const scope = scopeOf(rootUrl);
  const robots = await robotsFor(scope.origin, opts);
  const start = normalize(rootUrl, rootUrl);
  const queue = [{ url: start, depth: 0 }];
  const seen = new Set([start]);
  const stats = { visited: 0, fetched: 0, skipped: 0, notModified: 0, errors: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (queue.length && stats.visited < opts.max_pages_per_site && !shouldStop()) {
    const { url, depth } = queue.shift();
    if (robots && !robots.isAllowed(url, opts.user_agent)) { stats.skipped++; continue; }
    stats.visited++;
    const prior = known[url] || {};
    const cond = {}; if (prior.etag) cond["if-none-match"] = prior.etag; if (prior.lastModified) cond["if-modified-since"] = prior.lastModified;
    let resp;
    try { resp = await fetchWithTimeout(url, { ...opts, timeout: opts.timeout_ms, userAgent: opts.user_agent, headers: cond }); }
    catch (e) { stats.errors.push({ url, error: e.name === "AbortError" ? "timed out" : e.message }); continue; }
    if (resp.status === 304) {
      stats.notModified++;
      // Stored links are every same-site link the page had; the CURRENT scope decides which to follow.
      for (const l of prior.links || []) { const u = typeof l === "string" ? l : l.url; if (!seen.has(u) && inScope(u, scope, mode) && !SKIP_EXT.test(u) && depth + 1 <= opts.max_depth) { seen.add(u); queue.push({ url: u, depth: depth + 1 }); } }
      continue;
    }
    if (!resp.ok) { stats.errors.push({ url, error: `HTTP ${resp.status}` }); continue; }
    const ctype = resp.headers.get("content-type") || "";
    if (!/html|pdf/i.test(ctype)) { stats.skipped++; continue; }
    const buf = Buffer.from(await resp.arrayBuffer());
    let doc, siteLinks = [];
    try {
      doc = await extractWeb(buf, ctype, url);
      // Keep every same-site link (with its text) so the page's navigation is searchable and a later scope change can follow it; follow only those in the current scope.
      if (/html/i.test(ctype)) siteLinks = extractLinks(buf.toString("utf8"), resp.url || url).filter((l) => { try { return new URL(l.url).origin === scope.origin; } catch { return false; } });
    } catch (e) { stats.errors.push({ url, error: e.message }); continue; }
    stats.fetched++;
    const follow = siteLinks.map((l) => l.url).filter((l) => (inScope(l, scope, mode) && !SKIP_EXT.test(l)) || (/\.pdf($|\?)/i.test(l) && inScope(l, scope, mode)));
    for (const l of follow) if (!seen.has(l) && depth + 1 <= opts.max_depth) { seen.add(l); queue.push({ url: l, depth: depth + 1 }); }
    if (onPage) await onPage({ url, title: doc.title, pages: doc.pages, mime: doc.mime, page_count: doc.page_count, ocr_pages: doc.ocr_pages, links: siteLinks, etag: resp.headers.get("etag"), lastModified: resp.headers.get("last-modified"), bytes: buf.length });
    log(`${stats.visited}/${opts.max_pages_per_site} ${url}`);
    if (queue.length) await sleep(opts.delay_ms);
  }
  stats.remaining = queue.length;
  return stats;
}

module.exports = { crawl, scopeOf, inScope, normalize, SCOPES };
