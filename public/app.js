/* AI Data Depot — UI. Vanilla JS, no build step. */
(() => {
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const state = { config: null, bundles: [], personas: [], sessions: [], session: null, view: "chat", sec: "models", streaming: null, lastCitations: [], modelsCache: {}, presets: [] };
const store = { get(k, d) { try { const v = localStorage.getItem("depot." + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem("depot." + k, JSON.stringify(v)); } catch {} } };

function toast(msg, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts, body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const guard = (fn) => (...a) => Promise.resolve(fn(...a)).catch((e) => toast(e.message, 5000));

// ---------------------------------------------------------------- theme
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const TOKENS = { bg: ["--bg", "Page background"], panel: ["--panel", "Panels"], ink: ["--ink", "Text"], mute: ["--mute", "Muted text"], line: ["--line", "Lines & borders"], acc: ["--acc", "Accent"], accInk: ["--acc-ink", "Text on accent"], accSoft: ["--acc-soft", "Accent tint"], accText: ["--acc-text", "Accent text"], nav: ["--nav", "Rail"], navtxt: ["--navtxt", "Rail text"], user: ["--user", "Your messages"], mark: ["--mark", "Highlight"] };
function customTheme(id) { return ((state.config && state.config.appearance.custom_themes) || []).find((t) => t.id === id); }
function applyTheme(id, preview) {
  const root = document.documentElement;
  for (const [v] of Object.values(TOKENS)) root.style.removeProperty(v);
  const ct = preview || customTheme(id);
  if (ct) { root.dataset.theme = "custom"; root.style.colorScheme = ct.dark ? "dark" : "light"; for (const [k, [v]] of Object.entries(TOKENS)) if (ct.tokens && ct.tokens[k]) root.style.setProperty(v, ct.tokens[k]); return; }
  root.style.colorScheme = "";
  root.dataset.theme = id === "system" ? (mq.matches ? "harbor-dark" : "harbor-light") : (id || "harbor-light");
}
/** Read a preset's colours out of the stylesheet, so a custom theme can start from one. */
function presetTokens(id) {
  const probe = document.createElement("div"); probe.dataset.theme = id === "system" ? (mq.matches ? "harbor-dark" : "harbor-light") : id; probe.hidden = true; document.body.appendChild(probe);
  const cs = getComputedStyle(probe); const out = {}; for (const [k, [v]] of Object.entries(TOKENS)) out[k] = toHex(cs.getPropertyValue(v).trim()); probe.remove(); return out;
}
function toHex(c) { if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase(); const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (m) return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join(""); if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c.slice(1).split("").map((x) => x + x).join("").toLowerCase(); return "#888888"; }
mq.addEventListener("change", () => state.config && applyTheme(state.config.appearance.theme));

// ---------------------------------------------------------------- drawers
function wireDrawers() {
  const app = $("#app");
  const saved = store.get("drawers", {});
  const width = { l: saved.lw || 270, r: saved.rw || 340 };
  // The width is an inline CSS variable, so collapsing must set it to 0
  // explicitly — a class rule cannot override an inline value.
  const apply = (side, w) => { app.style.setProperty(side === "l" ? "--lw" : "--rw", w + "px"); app.classList.toggle(side === "l" ? "lc" : "rc", w === 0); };
  const persist = () => store.set("drawers", { lw: width.l, rw: width.r, lc: app.classList.contains("lc"), rc: app.classList.contains("rc") });
  apply("l", saved.lc ? 0 : width.l); apply("r", saved.rc ? 0 : width.r);
  function wire(handle, side) {
    const cls = side === "l" ? "lc" : "rc";
    const glyph = () => { const c = app.classList.contains(cls); handle.querySelector("b").textContent = side === "l" ? (c ? "›" : "‹") : (c ? "‹" : "›"); };
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault(); const startX = e.clientX; let moved = false;
      const startW = app.classList.contains(cls) ? 0 : width[side];
      app.classList.add("rs");
      const mv = (ev) => { const dx = ev.clientX - startX; if (Math.abs(dx) > 8) moved = true;
        let w = side === "l" ? startW + dx : startW - dx; w = Math.max(0, Math.min(Math.round(window.innerWidth * 0.5), w));
        if (w < 60) apply(side, 0); else { width[side] = w; apply(side, w); } glyph(); };
      const up = () => { app.classList.remove("rs"); document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
        if (!moved) { apply(side, app.classList.contains(cls) ? width[side] : 0); glyph(); } persist(); };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
    glyph();
  }
  wire($("#handle-l"), "l"); wire($("#handle-r"), "r");
  wireDrawers.open = (side) => { if (app.classList.contains(side === "l" ? "lc" : "rc")) { apply(side, width[side]); $(side === "l" ? "#handle-l b" : "#handle-r b").textContent = side === "l" ? "‹" : "›"; persist(); } };
}
function openRightDrawer() { wireDrawers.open("r"); }

// ---------------------------------------------------------------- state
async function refresh() {
  const s = await api("/api/state");
  Object.assign(state, { config: s.config, bundles: s.bundles, personas: s.personas, sessions: s.sessions, presets: s.presets || state.presets, meta: { version: s.version, config_path: s.config_path, data_dir: s.data_dir, sqlite_vec: s.sqlite_vec, restart_required: s.restart_required } });
  applyTheme(state.config.appearance.theme);
  renderBundles(); renderPersonaSelect(); renderSessionsMenu(); renderWelcome(); renderIndexNotice();
  if (s.job) showJob({ status: "running", ...s.job }); else if (!$("#jobcard").hidden) showJob(null);
}
function enabledBundleIds() { return state.bundles.filter((b) => b.enabled).map((b) => b.id); }

// ---------------------------------------------------------------- bundles drawer
function bundleStatus(b) {
  if (!b.sources.length) return "none";
  if (b.sources.some((s) => s.status === "indexing")) return "busy";
  if (b.sources.some((s) => s.status === "error")) return "err";
  return "ok";
}
/** What, if anything, needs a look on this bundle: unindexed or failed sources, files that could not be read. */
function bundleIssues(b) {
  const out = [];
  for (const s of b.sources) {
    const short = s.kind === "website" ? s.location.replace(/^https?:\/\//, "") : s.location.split("/").pop() || s.location;
    if (s.status === "pending") out.push(`${short}: not indexed yet`);
    else if (s.status === "error") out.push(`${short}: indexing failed${s.last_error ? " — " + s.last_error : ""}`);
    else if (s.last_error) out.push(`${short}: ${s.last_error}`);
  }
  if (!b.sources.length) out.push("no sources yet");
  return out;
}
function bundleSummary(b) {
  const f = b.sources.filter((s) => s.kind === "path").length, w = b.sources.filter((s) => s.kind === "website").length;
  return [f ? `${f} folder${f > 1 ? "s" : ""}` : "", w ? `${w} website${w > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ") || "no sources yet";
}
function renderBundles() {
  const el = $("#bundle-list");
  if (!state.bundles.length) { el.innerHTML = `<div class="hint">No bundles yet. A bundle is a set of folders and websites you can switch on or off together.</div>`; return; }
  el.innerHTML = state.bundles.map((b) => { const issues = bundleIssues(b); return `<div class="bd ${b.enabled ? "" : "off"}">
    <div class="bdrow"><input type="checkbox" data-bundle="${b.id}" ${b.enabled ? "checked" : ""} aria-label="Enable ${esc(b.name)}" title="${b.enabled ? "On — the assistant may read this bundle" : "Off"}">
      <button class="bdname" data-goto="${b.id}" title="Open this bundle in Sources">${esc(b.name)}</button>
      ${issues.length ? `<button class="bdwarn" data-goto="${b.id}" title="${esc(issues.join("\n"))}">⚠</button>` : `<span class="st ${bundleStatus(b)}" title="ok"></span>`}</div>
    <small class="bddesc" title="${esc(b.description || bundleSummary(b))}">${esc(b.description || bundleSummary(b))}</small></div>`; }).join("");
  $$("input[data-bundle]", el).forEach((cb) => cb.addEventListener("change", guard(async () => { await api(`/api/bundles/${cb.dataset.bundle}`, { method: "PATCH", body: { enabled: cb.checked } }); await refresh(); if (state.view === "sources") renderSources(); })));
  $$("[data-goto]", el).forEach((b) => b.addEventListener("click", () => gotoBundle(Number(b.dataset.goto))));
}
/** Jump to a bundle's card on the Sources page and flash it. */
function gotoBundle(id) {
  showView("sources");
  setTimeout(() => { const card = $(`.card[data-bundle="${id}"]`); if (!card) return; card.scrollIntoView({ behavior: "smooth", block: "start" }); card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1800); }, 60);
}
function renderWelcome() {
  // The welcome block leaves the thread after the first message; nothing to update then.
  const hint = $("#welcome-hint"); if (!hint) return;
  const docs = state.bundles.reduce((a, b) => a + b.sources.reduce((x, s) => x + (s.doc_count || 0), 0), 0);
  const on = state.bundles.filter((b) => b.enabled).length;
  hint.textContent = state.bundles.length ? `${on} of ${state.bundles.length} bundles on · ${docs.toLocaleString()} documents indexed` : "Start by adding a bundle in Sources.";
}
async function newBundle() {
  const v = await formDialog({ title: "New bundle", submit: "Create", fields: [
    { id: "name", label: "Name", placeholder: "e.g. Federal tax code 2026, or Client · Henderson", autofocus: true },
    { id: "description", label: "Description (optional)", placeholder: "What this bundle is for" }],
    onSubmit: async (v) => { if (!v.name) throw new Error("Give the bundle a name."); await api("/api/bundles", { method: "POST", body: { name: v.name, description: v.description } }); } });
  if (!v) return;
  await refresh(); showView("sources"); renderSources(); toast(`Bundle “${v.name}” created — now add a folder, a file or a website to it.`);
}
const SCOPE_OPTIONS = [
  { value: "linked", label: "Linked pages — this page and pages it links to, on the same site, up to N hops" },
  { value: "section", label: "This section — this page and everything under its address (/section/…)" },
  { value: "site", label: "Whole site — any page on this website" },
  { value: "page", label: "This page only" }];
const SCOPE_LABEL = { linked: "linked pages", section: "this section", site: "whole site", page: "page only" };
const scopeFields = (o = {}) => [
  { id: "scope", type: "select", label: "What to read", value: o.scope || "linked", options: SCOPE_OPTIONS, help: "Other websites are never followed. Every mode stops at the pages-per-website cap in Settings → Indexing · Websites." },
  { id: "depth", type: "number", label: "Link hops (Linked pages only)", value: o.depth ?? 2, min: 0, max: 10, help: "1 = the page and what it links to; 2 = one step further. Each hop multiplies the pages." }];
async function addWebsite(bundleId) {
  const v = await formDialog({ title: "Add a website", submit: "Add", fields: [
    { id: "url", label: "Website address", mono: true, placeholder: "https://www.irs.gov/individuals/get-transcript", autofocus: true },
    ...scopeFields(),
    { id: "index", type: "checkbox", label: "Read it right away", value: false, help: "otherwise click Index on the source when you are ready — until then the assistant cannot read it" }],
    onSubmit: async (v) => { if (!v.url) throw new Error("Enter the website address."); await api(`/api/bundles/${bundleId}/sources`, { method: "POST", body: { kind: "website", location: v.url, index: false, options: { scope: v.scope, depth: Number(v.depth) } } }); } });
  if (!v) return;
  await refresh(); renderSources();
  if (v.index) { if (await ensureModelReady()) { const src = state.bundles.flatMap((b) => b.sources).find((x) => x.location === v.url || x.location === "https://" + v.url); if (src) await api(`/api/sources/${src.id}/index`, { method: "POST" }); toast("Added — reading the site now."); } }
  else toast("Added. Click Index on it when you are ready.");
}
/** Pick one item from a list in a sub-window. The search box starts EMPTY so
 * the whole list shows; typing narrows it. Resolves with the item or null. */
function pickFromList({ title, items, current = "", hint = "" }) {
  return new Promise((resolve) => {
    const dlg = $("#pick-dialog"), list = $("#pick-list"), search = $("#pick-search");
    $("#pick-title").textContent = title; $("#pick-hint").textContent = hint; search.value = "";
    let done = false; const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    const render = () => { const q = search.value.trim().toLowerCase(); const shown = items.filter((m) => !q || m.toLowerCase().includes(q));
      list.innerHTML = shown.map((m) => `<button type="button" data-m="${esc(m)}" class="${m === current ? "on" : ""}">${esc(m)}${m === current ? `<span class="cur">current</span>` : ""}</button>`).join("") || `<div class="hint" style="padding:12px">Nothing matches “${esc(search.value)}”.</div>`;
      $$("button[data-m]", list).forEach((b) => (b.onclick = () => finish(b.dataset.m))); };
    search.oninput = render; render();
    $("#pick-cancel").onclick = () => finish(null); $(".x", dlg).onclick = () => finish(null); dlg.onclose = () => finish(null);
    dlg.showModal(); search.focus();
    const cur = list.querySelector("button.on"); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "center" });
  });
}
/** Small modal form. Resolves with the values on submit, null on cancel; onSubmit may throw to show an error inline. */
function formDialog({ title, fields = [], submit = "Save", cancel = "Cancel", message = "", onSubmit }) {
  return new Promise((resolve) => {
    const dlg = $("#form-dialog"), form = $("#form-dialog-form"), err = $("#form-error");
    $("#form-title").textContent = title; $("#form-submit").textContent = submit; $("#form-cancel").textContent = cancel; err.hidden = true;
    $("#form-fields").innerHTML = (message ? `<p style="margin:0;font-size:14px;line-height:1.5">${message}</p>` : "") + fields.map((f) => f.type === "checkbox"
      ? `<label class="chk" style="color:var(--ink);font-weight:500;font-size:13px"><input type="checkbox" id="ff-${f.id}" ${f.value ? "checked" : ""}> ${esc(f.label)}${f.help ? ` <span class="hint">${esc(f.help)}</span>` : ""}</label>`
      : f.type === "select"
      ? `<div><label for="ff-${f.id}">${esc(f.label)}</label><select class="fld" id="ff-${f.id}">${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>${f.help ? `<div class="help">${esc(f.help)}</div>` : ""}</div>`
      : `<div><label for="ff-${f.id}">${esc(f.label)}</label><input class="fld${f.mono ? " mono" : ""}" id="ff-${f.id}" type="${f.type === "number" ? "number" : "text"}" ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.max !== undefined ? `max="${f.max}"` : ""} value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder || "")}">${f.help ? `<div class="help">${esc(f.help)}</div>` : ""}</div>`).join("");
    const values = () => Object.fromEntries(fields.map((f) => [f.id, f.type === "checkbox" ? $(`#ff-${f.id}`).checked : $(`#ff-${f.id}`).value.trim()]));
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    form.onsubmit = async (e) => { e.preventDefault(); const v = values(); $("#form-submit").disabled = true;
      try { if (onSubmit) await onSubmit(v); finish(v); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { $("#form-submit").disabled = false; } };
    $("#form-cancel").onclick = () => finish(null);
    $(".x", dlg).onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal(); const first = $("#form-fields input"); if (first) first.focus();
  });
}
function renderIndexNotice() {
  const el = $("#index-notice"); if (!el) return;
  const pending = state.bundles.filter((b) => b.enabled).flatMap((b) => b.sources.filter((s) => s.status === "pending" || (s.status === "error" && !s.doc_count)).map((s) => ({ ...s, bundle: b.name })));
  if (!pending.length) { el.hidden = true; return; }
  el.hidden = false;
  const n = pending.length;
  el.innerHTML = `<span>⚠ ${n} source${n > 1 ? "s" : ""} in your enabled bundles ${n > 1 ? "are" : "is"} not indexed yet, so the assistant cannot read ${n > 1 ? "them" : "it"}: <b>${pending.slice(0, 3).map((s) => esc(s.location)).join("</b>, <b>")}</b>${n > 3 ? "…" : ""}</span><span class="sp"></span><button class="btn sm pri" id="notice-index">Index now</button>`;
  $("#notice-index").onclick = guard(async () => { if (!(await ensureModelReady())) return; for (const s of pending) await api(`/api/sources/${s.id}/index`, { method: "POST" }); toast("Indexing started."); el.hidden = true; });
}

// ---------------------------------------------------------------- privacy badge
async function renderPrivacy() {
  const badge = $("#priv-badge"), txt = $("#priv-text");
  const p = state.config.models.providers[state.config.models.active];
  txt.textContent = `${p.chat_model || "no model"} · ${p.label}`; badge.className = "priv " + (p.local ? "" : "cloud");
  badge.title = p.local ? "Local model — nothing leaves this computer" : "Cloud model — your question and the matching passages are sent to " + p.label;
  try { const st = await api(`/api/models/status`); if (!st.reachable) { badge.className = "priv bad"; badge.title = st.error || "Not reachable"; txt.textContent = `${p.label} — not reachable`; } else if (st.chat_model_found === false) { badge.className = "priv bad"; txt.textContent = `${p.chat_model} not found on ${p.label}`; badge.title = "Pick a model in Settings → Models"; } else { txt.textContent = `${p.chat_model} · ${p.local ? "local — nothing leaves this Mac" : p.label}`; } } catch {}
}

// ---------------------------------------------------------------- personas select
function renderPersonaSelect() {
  const sel = $("#persona-select"); const cur = state.session ? state.session.persona : (store.get("persona", "general"));
  sel.innerHTML = state.personas.map((p) => `<option value="${esc(p.id)}" ${p.id === cur ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}

// ---------------------------------------------------------------- markdown + citations
/** Turn bare http(s) URLs in already-escaped text into links (trailing punctuation stays outside). */
function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<>"']+?)([.,;:!?)\]]*)(?=\s|$|<)/g, (m, url, tail) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>${tail}`);
}
function md(src) {
  const lines = String(src).replace(/\r/g, "").split("\n");
  let html = "", i = 0, para = [];
  const inline = (s) => linkify(esc(s).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>").replace(/\[(\d{1,2})\]/g, '<button class="r" data-cite="$1">$1</button>');
  const marker = (state.config && state.config.chat.general_marker) || "From general knowledge, not your sources:";
  const flush = () => { if (para.length) { let t = para.join(" "); if (t.startsWith(marker)) { html += `<div class="gk"><b style="font-size:12px;color:var(--warn)">${esc(marker.replace(/:$/, ""))}</b><br>${inline(t.slice(marker.length).trim())}</div>`; } else html += `<p>${inline(t)}</p>`; para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { flush(); let code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; html += `<pre>${esc(code.join("\n"))}</pre>`; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) { flush(); const rows = []; while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()); if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells); i++; }
      html += `<table>${rows.map((r, ri) => `<tr>${r.map((c) => `<${ri ? "td" : "th"}>${inline(c)}</${ri ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`; continue; }
    if (/^#{1,4}\s/.test(l)) { flush(); const lvl = l.match(/^#+/)[0].length; html += `<h${lvl + 2}>${inline(l.replace(/^#+\s*/, ""))}</h${lvl + 2}>`; i++; continue; }
    if (/^\s*([-*]|\d+[.)])\s+/.test(l)) { flush(); const ordered = /^\s*\d/.test(l); let items = []; while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, "")); html += `<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`; continue; }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush(); return html;
}

// ---------------------------------------------------------------- chat
function personaName(id) { const p = state.personas.find((x) => x.id === id); return p ? p.name : id; }
function appendUser(text) { $("#welcome") && $("#welcome").remove(); const d = document.createElement("div"); d.className = "u"; d.textContent = text; $("#thread").appendChild(d); scrollThread(); return d; }
function appendAssistant() { const d = document.createElement("div"); d.className = "ai"; d.innerHTML = `<div class="who"><i></i>${esc(personaName(currentPersona()))}</div><div class="body cursor"></div>`; $("#thread").appendChild(d); scrollThread(); return d; }
function scrollThread() { const t = $("#thread"); t.scrollTop = t.scrollHeight; }
function currentPersona() { return $("#persona-select").value || "general"; }
function basisPill(basis) {
  return basis === "sources" ? `<span class="basis sources">From your sources</span>` : basis === "mixed" ? `<span class="basis mixed">Sources + general knowledge</span>` : basis === "general" ? `<span class="basis general">General knowledge — not from your sources</span>` : "";
}
function ledgerHtml(l) {
  if (!l || !state.config.chat.show_reasoning_ledger) return "";
  const docs = l.documents.map((d) => `${esc(d.title)} <span style="color:var(--mute)">(${esc(d.bundle)})</span>`).join(", ");
  const used = l.basis === "sources" || l.basis === "mixed";
  return `<details class="steps"><summary>How I answered</summary>${l.searched.length ? `<span class="ok">Searched ${l.searched.map(esc).join(", ")} — ${l.passages} passages considered${used ? "" : ", none used"}</span>` : `<span class="skip">No bundles were on</span>`}${docs ? `<span class="ok">Drew on ${docs}</span>` : ""}${l.basis === "general" ? `<span class="skip">Answered from the model's general knowledge — your sources did not cover it</span>` : ""}${l.basis === "chat" ? `<span class="skip">Conversational reply — no sources needed</span>` : ""}${l.skipped.length ? `<span class="skip">Skipped ${l.skipped.map(esc).join(", ")} (turned off)</span>` : ""}<span class="skip">${esc(l.persona)} · ${esc(l.model)} · ${esc(l.provider)} · ${l.mode === "sources-only" ? "sources only" : "sources first"}</span></details>`;
}
function finishAssistant(el, r) {
  el.classList.toggle("nf", !!r.notFound);
  const basis = r.basis || (r.ledger && r.ledger.basis) || (r.citations && r.citations.length ? "sources" : "chat");
  const who = el.querySelector(".who"); if (who && !who.querySelector(".basis")) who.insertAdjacentHTML("beforeend", basisPill(basis));
  el.querySelector(".body").classList.remove("cursor");
  el.querySelector(".body").innerHTML = ledgerHtml(r.ledger) + md(r.text);
  wireCitations(el, r.citations);
}
function wireCitations(el, citations) {
  el.dataset.citations = JSON.stringify(citations || []);
  $$(".r[data-cite]", el).forEach((b) => { const c = (citations || []).find((x) => x.n === Number(b.dataset.cite)); if (!c) { b.classList.add("dead"); b.title = "Not a source"; return; } b.addEventListener("click", () => { $$(".r.on").forEach((x) => x.classList.remove("on")); b.classList.add("on"); showCitation(c, citations); }); });
}
async function send() {
  const ta = $("#composer"); const text = ta.value.trim(); if (!text || state.streaming) return;
  if (!state.session) state.session = newSessionObject();
  ta.value = ""; ta.style.height = "auto";
  appendUser(text);
  const el = appendAssistant();
  const body = el.querySelector(".body");
  const history = state.session.messages.map((m) => ({ role: m.role, content: m.content }));
  state.session.messages.push({ role: "user", content: text, at: new Date().toISOString() });
  const ctl = new AbortController(); state.streaming = ctl; $("#send-btn").hidden = true; $("#stop-btn").hidden = false;
  let acc = "";
  try {
    const resp = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text, history, persona: currentPersona(), bundle_ids: enabledBundleIds(), mode: $("#strict-mode").checked ? "sources-only" : "sources-first" }), signal: ctl.signal });
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `Request failed (${resp.status})`);
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = "", ev = null;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) { const d = JSON.parse(line.slice(5));
          if (ev === "token") { acc += d.text; body.textContent = acc; scrollThread(); }
          else if (ev === "done") { finishAssistant(el, d); state.lastCitations = d.citations; renderAllSources(d.citations); state.session.messages.push({ role: "assistant", content: d.text, citations: d.citations, ledger: d.ledger, basis: d.basis, at: new Date().toISOString() }); }
          else if (ev === "error") { throw new Error(d.error); } }
      }
    }
    if (state.session.messages.length === 2 && state.session.name === "New session") { state.session.name = text.slice(0, 60); $("#session-name").value = state.session.name; }
    await autosave();
  } catch (e) {
    if (e.name === "AbortError") { body.classList.remove("cursor"); body.innerHTML = md(acc) + `<p class="hint">Stopped.</p>`; if (acc) state.session.messages.push({ role: "assistant", content: acc, citations: [], at: new Date().toISOString() }); }
    else { body.classList.remove("cursor"); body.innerHTML = `<div class="err">${esc(e.message)}</div>`; state.session.messages.pop(); }
  } finally { state.streaming = null; $("#send-btn").hidden = false; $("#stop-btn").hidden = true; scrollThread(); ta.focus(); }
}

// ---------------------------------------------------------------- evidence
function showCitation(c, all) {
  openRightDrawer(); switchTab("passage");
  const ev = $("#evidence");
  const where = [c.bundle, c.location].filter(Boolean).join(" · ");
  ev.innerHTML = `<div class="doc"><div class="nx" style="margin:0 0 10px"><button class="btn sm" id="ev-prev">‹ Prev</button><button class="btn sm" id="ev-next">Next ›</button><span class="sp" style="flex:1"></span><button class="btn sm pri" id="ev-open">${c.kind === "web" ? "Open page" : "Open file"}</button></div>
    <div class="t">${esc(c.title)}</div><div class="w">${c.kind === "web" ? `<a href="${esc(c.locator)}" target="_blank" rel="noopener">${esc(c.locator)}</a>` : esc(c.locator)}${where ? " · " + esc(where) : ""}</div><div class="pg">${linkify(esc(c.excerpt))}</div></div>`;
  const list = all || state.lastCitations; const idx = list.findIndex((x) => x.n === c.n);
  $("#ev-prev").disabled = idx <= 0; $("#ev-next").disabled = idx < 0 || idx >= list.length - 1;
  $("#ev-prev").onclick = () => showCitation(list[idx - 1], list); $("#ev-next").onclick = () => showCitation(list[idx + 1], list);
  $("#ev-open").onclick = guard(async () => { if (c.kind === "web") window.open(c.locator, "_blank"); else await api("/api/open", { method: "POST", body: { locator: c.locator } }); });
}
function renderAllSources(citations) {
  $("#src-count").textContent = citations && citations.length ? `(${citations.length})` : "";
  const el = $("#evidence-all");
  el.innerHTML = citations && citations.length ? citations.map((c) => `<div class="srow" data-n="${c.n}"><span class="n">${c.n}</span><span class="tt" title="${esc(c.locator)}">${esc(c.title)}${c.location ? " · " + esc(c.location) : ""}</span><span class="st">${c.kind === "web" ? "web" : "file"}</span></div>`).join("") : `<div class="empty">The sources the last answer cited will be listed here.</div>`;
  $$(".srow", el).forEach((r) => r.addEventListener("click", () => showCitation(citations.find((c) => c.n === Number(r.dataset.n)), citations)));
}
function switchTab(tab) { $$(".dr .tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab)); $("#evidence").hidden = tab !== "passage"; $("#evidence-all").hidden = tab !== "all"; }

// ---------------------------------------------------------------- sessions
function newSessionObject() { return { id: null, name: "New session", persona: currentPersona(), messages: [], bundles: state.bundles.filter((b) => b.enabled).map((b) => b.name) }; }
function loadSessionIntoUi(s) {
  state.session = s; $("#session-name").value = s.name; $("#session-saved").textContent = s.id ? `saved ${fmtWhen(s.updated_at)}` : "unsaved";
  renderPersonaSelect(); $("#persona-select").value = s.persona || "general";
  const t = $("#thread"); t.innerHTML = "";
  if (!s.messages.length) { t.innerHTML = `<div class="welcome" id="welcome"><h2>Ask about your sources</h2><p>Ask anything. When your sources (the bundles turned on in the Reading-from drawer) can answer, they are used and cited; anything from general knowledge is labelled. Tick <b>Sources only</b> to refuse everything else.</p><p class="hint" id="welcome-hint"></p></div>`; renderWelcome(); }
  $("#strict-mode").checked = s.mode === "sources-only" || (!s.mode && state.config.chat.mode === "sources-only");
  for (const m of s.messages) { if (m.role === "user") appendUser(m.content); else { const el = appendAssistant(); finishAssistant(el, { text: m.content, citations: m.citations || [], ledger: m.ledger, basis: m.basis, notFound: false }); } }
  const last = [...s.messages].reverse().find((m) => m.role === "assistant" && m.citations && m.citations.length); state.lastCitations = last ? last.citations : []; renderAllSources(state.lastCitations);
  if (Array.isArray(s.bundles) && s.bundles.length) applyBundleNames(s.bundles);
  showView("chat");
}
async function applyBundleNames(names) {
  let changed = false;
  for (const b of state.bundles) { const want = names.includes(b.name); if (want !== b.enabled) { await api(`/api/bundles/${b.id}`, { method: "PATCH", body: { enabled: want } }); changed = true; } }
  if (changed) { await refresh(); toast("Bundles set the way this session had them."); }
}
async function autosave() { if (state.session && state.session.id) await saveSession(true); }
async function saveSession(quiet) {
  if (!state.session) state.session = newSessionObject();
  const s = state.session; s.name = $("#session-name").value.trim() || s.name; s.persona = currentPersona(); s.bundles = state.bundles.filter((b) => b.enabled).map((b) => b.name); s.mode = $("#strict-mode").checked ? "sources-only" : "sources-first";
  const p = state.config.models.providers[state.config.models.active]; s.provider = state.config.models.active; s.model = p.chat_model;
  const saved = s.id ? await api(`/api/sessions/${s.id}`, { method: "PUT", body: s }) : await api("/api/sessions", { method: "POST", body: s });
  state.session = saved; $("#session-saved").textContent = `saved ${fmtWhen(saved.updated_at)}`;
  state.sessions = await api("/api/sessions"); renderSessionsMenu(); if (state.view === "sessions") renderSessionsPage();
  if (!quiet) toast(`Saved “${saved.name}”.`);
}
function fmtWhen(iso) { if (!iso) return ""; const d = new Date(iso), now = new Date(); const same = d.toDateString() === now.toDateString(); return same ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }); }
function renderSessionsMenu() {
  $("#sessions-recent").innerHTML = state.sessions.slice(0, 6).map((s) => `<button class="mi" data-load="${s.id}"><span class="tt">${esc(s.name)}</span><span class="when">${fmtWhen(s.updated_at)}</span></button>`).join("") || `<div class="hint" style="padding:4px 10px">No saved sessions yet.</div>`;
  $$("[data-load]", $("#sessions-recent")).forEach((b) => b.addEventListener("click", guard(async () => { $("#sessions-menu").hidden = true; loadSessionIntoUi(await api(`/api/sessions/${b.dataset.load}`)); })));
}
async function renderSessionsPage() {
  state.sessions = await api("/api/sessions");
  const el = $("#sessions-page");
  el.innerHTML = state.sessions.length ? `<div class="card"><table class="tbl"><tr><th>Session</th><th>Persona</th><th>Messages</th><th>Updated</th><th></th></tr>${state.sessions.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(personaName(s.persona))}</td><td>${s.message_count}</td><td>${fmtWhen(s.updated_at)}</td><td class="r"><button class="btn sm pri" data-open="${s.id}">Open</button> <a class="btn sm" href="/api/sessions/${s.id}/export?format=md" download>.md</a> <a class="btn sm" href="/api/sessions/${s.id}/export" download>.json</a> <button class="btn sm danger" data-del="${s.id}">Delete</button></td></tr>`).join("")}</table></div>` : `<div class="card"><div class="hint">No saved sessions yet. Save the current conversation from the Sessions ▾ menu in Chat.</div></div>`;
  $$("[data-open]", el).forEach((b) => b.addEventListener("click", guard(async () => loadSessionIntoUi(await api(`/api/sessions/${b.dataset.open}`)))));
  $$("[data-del]", el).forEach((b) => b.addEventListener("click", guard(async () => { if (!confirm("Delete this session? This cannot be undone.")) return; await api(`/api/sessions/${b.dataset.del}`, { method: "DELETE" }); if (state.session && state.session.id === b.dataset.del) { state.session = null; loadSessionIntoUi(newSessionObject()); showView("sessions"); } await renderSessionsPage(); renderSessionsMenu(); })));
}
async function importSessionFile(file) { const text = await file.text(); let obj; try { obj = JSON.parse(text); } catch { throw new Error("That file is not valid JSON."); } const s = await api("/api/sessions/import", { method: "POST", body: obj }); state.sessions = await api("/api/sessions"); renderSessionsMenu(); loadSessionIntoUi(s); toast(`Imported “${s.name}”.`); }

// ---------------------------------------------------------------- sources page
function srcMeta(s) {
  if (s.status === "indexing") return `<span class="pill busy">indexing</span>`;
  if (s.status === "error") return `<span class="pill err" title="${esc(s.last_error || "")}">error</span>`;
  if (s.status === "pending") return `<span class="pill">not indexed</span>`;
  return `<span class="pill ok" title="${s.kind === "website" ? "pages read and indexed" : "files read and indexed"}">${Number(s.doc_count).toLocaleString()} ${s.kind === "website" ? "pages" : "files"} indexed</span> ${s.last_indexed_at ? `<span class="meta">${fmtWhen(s.last_indexed_at)}</span>` : ""}${s.last_error ? ` <button class="errbtn" data-errors="${s.id}" title="Click to see which files and why">⚠ ${esc(s.last_error)}</button>` : ""}`;
}
/** Before any indexing starts: a quick "hello" to the embedding model. If it
 * fails, an error window says what to set up and nothing is queued. */
async function ensureModelReady() {
  const r = await api("/api/index/ready");
  if (r.ok) return true;
  const p = state.config.models.providers[state.config.models.active];
  const v = await formDialog({ title: "No model is connected", submit: "Open Settings → Models", cancel: "Close",
    message: `Indexing needs a working model, and the current one — <b>${esc(p.label)}</b>${p.embedding_model ? ` (${esc(p.embedding_model)})` : ""} — did not answer:<br><br><i>${esc(r.error)}</i><br><br>Configure a model before indexing anything: pick a provider with an embedding model in Settings → Models (Ollama with <code>nomic-embed-text</code>, or OpenAI with an API key) and check that its status says Connected.`,
    onSubmit: async () => {} });
  if (v) { state.sec = "models"; $$("#smenu button").forEach((x) => x.classList.toggle("on", x.dataset.sec === "models")); showView("settings"); }
  return false;
}
async function renderReadyNotice() {
  const el = $("#ready-notice"); if (!el) return;
  try {
    const r = await api("/api/index/ready");
    if (r.ok) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<span>⚠ <b>Indexing needs a model and none is working:</b> ${esc(r.error)} Indexing will refuse to start until this is fixed.</span><span class="sp"></span><button class="btn sm pri" id="ready-settings">Open Settings → Models</button>`;
    $("#ready-settings").onclick = () => { state.sec = "models"; $$("#smenu button").forEach((x) => x.classList.toggle("on", x.dataset.sec === "models")); showView("settings"); };
  } catch { el.hidden = true; }
}
function parseOpts(s) { try { return JSON.parse(s.options || "{}") || {}; } catch { return {}; } }
async function showSourceErrors(sourceId) {
  const r = await api(`/api/sources/${sourceId}/errors`);
  const body = r.total ? r.groups.map((g) => `<details style="margin:6px 0"><summary style="cursor:pointer"><b>${g.count}</b> — ${esc(g.reason)}</summary><div style="font-family:var(--mono);font-size:11.5px;max-height:160px;overflow:auto;margin:6px 0 0 12px;color:var(--mute)">${g.files.map(esc).join("<br>")}${g.count > g.files.length ? `<br>… and ${g.count - g.files.length} more` : ""}</div></details>`).join("")
    : "No failed files any more.";
  const rateLimited = r.groups.some((g) => /429|rate limit|too large/i.test(g.reason));
  // The window's Retry counts X of <failed>, unlike Re-index which walks every file.
  const v = await formDialog({ title: `${r.total} file${r.total === 1 ? "" : "s"} could not be read`, submit: "Retry the failed files", cancel: "Close",
    message: `${body}${rateLimited ? `<p class="hint" style="margin-top:10px">Rate-limit and "too large" failures are the provider being busy or a batch being too big — they are retried automatically now, so a Retry should clear them.</p>` : ""}`, onSubmit: async () => {} });
  if (v) { if (!(await ensureModelReady())) return; await api(`/api/sources/${sourceId}/retry-failed`, { method: "POST" }); toast(`Retrying the ${r.total} failed file${r.total === 1 ? "" : "s"} — only those.`); }
}
async function editScope(sourceId) {
  const src = state.bundles.flatMap((b) => b.sources).find((x) => x.id === sourceId); if (!src) return;
  const v = await formDialog({ title: "What to read from this website", submit: "Save", fields: scopeFields(parseOpts(src)),
    message: `<span style="font-family:var(--mono);font-size:12px">${esc(src.location)}</span>`,
    onSubmit: async (v) => { await api(`/api/sources/${sourceId}`, { method: "PATCH", body: { options: { scope: v.scope, depth: Number(v.depth) } } }); } });
  if (v) { await refresh(); renderSources(); toast("Saved — click Re-index to read the site with the new scope."); }
}
function renderSources() {
  renderReadyNotice();
  const el = $("#sources-page");
  if (!state.bundles.length) { el.innerHTML = `<div class="card"><div class="ct">No bundles yet</div><p class="hint">A bundle groups folders and websites you switch on or off together — “Federal tax code”, “Client · Henderson”. Create one, then add a folder or a website to it.</p><button class="btn pri" id="nb-inline">+ New bundle</button></div>`; $("#nb-inline").addEventListener("click", guard(newBundle)); return; }
  el.innerHTML = state.bundles.map((b) => `<div class="card" data-bundle="${b.id}">
    <div class="ct"><button class="toggle ${b.enabled ? "on" : ""}" data-toggle="${b.id}" title="${b.enabled ? "On — the assistant may read this bundle" : "Off"}" aria-label="Enable bundle"></button><input class="session-name" data-rename="${b.id}" value="${esc(b.name)}" aria-label="Bundle name"><span class="sp"></span>
      <button class="btn sm" data-addpath="${b.id}">+ Folder or file</button><button class="btn sm" data-addweb="${b.id}">+ Website</button><button class="btn sm" data-docs="${b.id}">Documents</button><button class="btn sm danger" data-delbundle="${b.id}">Delete</button></div>
    <input class="bdescfld" data-descr="${b.id}" value="${esc(b.description || "")}" placeholder="Describe what is in this bundle — shown under its name in Chat (e.g. “2024–2026 federal tax code, IRS publications and the Henderson client file”)" aria-label="Bundle description">
    ${b.sources.length ? b.sources.map((s) => `<div class="srcline ${s.status === "indexing" ? "busy" : ""}" data-loc="${esc(s.location)}"><span class="k">${s.kind === "website" ? "website" : "folder"}</span><span class="loc" title="${esc(s.location)}">${esc(s.location)}</span>${s.kind === "website" ? `<button class="pill scope" data-scope="${s.id}" title="Change what is read from this site (then Re-index)">${esc(SCOPE_LABEL[(parseOpts(s).scope) || "linked"])}${parseOpts(s).scope === "linked" || !parseOpts(s).scope ? ` · ${parseOpts(s).depth ?? 2} hops` : ""} ▾</button>` : ""}${srcMeta(s)}<span class="live"></span><button class="btn sm ${s.status === "pending" ? "pri" : ""}" data-reindex="${s.id}" data-label="${s.status === "pending" ? "Index" : "Re-index"}" ${s.status === "indexing" ? "disabled" : ""}>${s.status === "indexing" ? `<span class="spin"></span>Indexing…` : s.status === "pending" ? "Index" : "Re-index"}</button><button class="btn sm danger" data-delsrc="${s.id}">Remove</button></div>`).join("") : `<div class="hint">No sources yet — add a folder, a file, or a website.</div>`}
    <div class="docs" id="docs-${b.id}" hidden></div></div>`).join("");
  $$("[data-toggle]", el).forEach((t) => t.addEventListener("click", guard(async () => { await api(`/api/bundles/${t.dataset.toggle}`, { method: "PATCH", body: { enabled: !t.classList.contains("on") } }); await refresh(); renderSources(); })));
  $$("[data-rename]", el).forEach((i) => i.addEventListener("change", guard(async () => { await api(`/api/bundles/${i.dataset.rename}`, { method: "PATCH", body: { name: i.value } }); await refresh(); })));
  $$("[data-descr]", el).forEach((i) => i.addEventListener("change", guard(async () => { await api(`/api/bundles/${i.dataset.descr}`, { method: "PATCH", body: { description: i.value.trim() } }); await refresh(); toast("Description saved."); })));
  $$("[data-addpath]", el).forEach((b) => b.addEventListener("click", guard(async () => { const p = await browse(); if (!p) return; const ready = p.index ? await ensureModelReady() : false; await api(`/api/bundles/${b.dataset.addpath}/sources`, { method: "POST", body: { kind: "path", location: p.path, index: ready } }); toast(ready ? "Added — indexing has started." : "Added. Click Index on it when you are ready."); await refresh(); renderSources(); })));
  $$("[data-addweb]", el).forEach((b) => b.addEventListener("click", guard(() => addWebsite(b.dataset.addweb))));
  $$("[data-reindex]", el).forEach((b) => b.addEventListener("click", guard(async () => { if (!(await ensureModelReady())) return; b.disabled = true; b.innerHTML = `<span class="spin"></span>Starting…`; await api(`/api/sources/${b.dataset.reindex}/index`, { method: "POST" }); })));
  $$("[data-errors]", el).forEach((b) => b.addEventListener("click", guard(() => showSourceErrors(Number(b.dataset.errors)))));
  $$("[data-scope]", el).forEach((b) => b.addEventListener("click", guard(() => editScope(Number(b.dataset.scope)))));
  $$("[data-delsrc]", el).forEach((b) => b.addEventListener("click", guard(async () => { if (!confirm("Remove this source and everything indexed from it?")) return; await api(`/api/sources/${b.dataset.delsrc}`, { method: "DELETE" }); await refresh(); renderSources(); })));
  $$("[data-delbundle]", el).forEach((b) => b.addEventListener("click", guard(async () => { if (!confirm("Delete this bundle, its sources and everything indexed from them?")) return; await api(`/api/bundles/${b.dataset.delbundle}`, { method: "DELETE" }); await refresh(); renderSources(); })));
  $$("[data-docs]", el).forEach((b) => b.addEventListener("click", guard(async () => { const box = $(`#docs-${b.dataset.docs}`); if (!box.hidden) { box.hidden = true; return; } const docs = await api(`/api/bundles/${b.dataset.docs}/documents`); box.hidden = false;
    box.innerHTML = docs.length ? `<table class="tbl" style="margin-top:10px"><tr><th>Document</th><th>Where</th><th>Pages</th><th>Status</th></tr>${docs.map((d) => `<tr><td>${esc(d.title || d.locator)}${d.ocr_pages ? ` <span class="pill" title="pages read with OCR">OCR ${d.ocr_pages}</span>` : ""}</td><td class="loc" style="font-family:var(--mono);font-size:11.5px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(d.locator)}">${esc(d.locator)}</td><td class="r">${d.page_count || ""}</td><td>${d.status === "ok" ? `<span class="pill ok">indexed</span>` : `<span class="pill err" title="${esc(d.error || "")}">${esc(d.error || "error")}</span>`}</td></tr>`).join("")}</table>` : `<div class="hint" style="margin-top:8px">Nothing indexed yet.</div>`; })));
}
// folder / file picker — looks and behaves like a file dialog
function browse() {
  return new Promise((resolve) => {
    const dlg = $("#browse-dialog"); let cur = store.get("browsePath", null), selected = null, entries = [];
    const join = (a, b) => (a.endsWith("/") ? a : a + "/") + b;
    const fmtSize = (n) => n == null ? "—" : n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB";
    const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
    const KIND = { pdf: "PDF", docx: "Word", xlsx: "Excel", xls: "Excel", csv: "CSV", tsv: "TSV", pptx: "PowerPoint", md: "Markdown", markdown: "Markdown", txt: "Text", html: "HTML", htm: "HTML", json: "JSON", rtf: "RTF" };
    const kind = (e) => (e.dir ? "Folder" : KIND[e.ext] || e.ext.toUpperCase());
    const chooseBtn = $("#browse-choose");
    const setSel = (name) => { selected = name; $$("#browse-rows tr").forEach((r) => r.classList.toggle("on", r.dataset.name === name)); const e = entries.find((x) => x.name === name); chooseBtn.textContent = !e ? "Use this folder" : e.dir ? `Use folder “${e.name}”` : `Use file “${e.name}”`; };
    let done = false;
    const finish = (v) => { if (done) return; done = true; store.set("browsePath", cur); if (dlg.open) dlg.close(); resolve(v ? { ...v, index: $("#browse-index").checked } : null); };
    async function go(p) {
      const r = await api("/api/fs/browse", { method: "POST", body: { path: p } }); cur = r.path; entries = r.entries;
      $("#browse-input").value = r.path;
      const parts = r.path.split("/").filter(Boolean); let acc = "";
      $("#browse-crumbs").innerHTML = `<button type="button" data-go="/">/</button>` + parts.map((seg) => { acc += "/" + seg; return `<span class="sep">›</span><button type="button" data-go="${esc(acc)}">${esc(seg)}</button>`; }).join("");
      $$("#browse-crumbs button").forEach((b) => (b.onclick = () => go(b.dataset.go)));
      $("#browse-shortcuts").innerHTML = `<div class="h">Places</div>` + r.shortcuts.map((sc) => `<button type="button" data-go="${esc(sc.path)}" class="${sc.path === r.path ? "on" : ""}">${esc(sc.name)}</button>`).join("");
      $$("#browse-shortcuts button").forEach((b) => (b.onclick = () => go(b.dataset.go)));
      $("#browse-up").onclick = () => go(r.parent);
      $("#browse-rows").innerHTML = entries.map((e) => `<tr data-name="${esc(e.name)}" data-dir="${e.dir ? 1 : 0}"><td class="ico">${e.dir ? "▸" : "·"}</td><td class="nm">${esc(e.name)}</td><td class="kd">${kind(e)}</td><td class="r">${fmtSize(e.size)}</td><td class="mt">${fmtDate(e.mtime)}</td></tr>`).join("") || `<tr><td colspan="5" class="hint" style="padding:16px">Nothing here that can be indexed.</td></tr>`;
      $$("#browse-rows tr[data-name]").forEach((tr) => { tr.addEventListener("click", () => setSel(tr.dataset.name)); tr.addEventListener("dblclick", () => { if (tr.dataset.dir === "1") go(join(cur, tr.dataset.name)); else finish({ path: join(cur, tr.dataset.name) }); }); });
      setSel(null);
    }
    $("#browse-go").onclick = () => go($("#browse-input").value.trim() || cur);
    $("#browse-input").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go($("#browse-input").value.trim() || cur); } };
    chooseBtn.onclick = () => finish({ path: selected ? join(cur, selected) : cur });
    $("#browse-cancel").onclick = () => finish(null);
    $(".x", dlg).onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    $("#browse-index").checked = false;
    go(cur).then(() => dlg.showModal()).catch((e) => { toast(e.message); resolve(null); });
  });
}
// Index progress (SSE). A pulsing badge on the Sources rail icon says
// "something is indexing"; the detail — files done of total, the current
// file, an estimate of time left, Stop — lives on the Sources page, on a card
// at the top and on the row being worked on.
const jobStats = { id: null, t0: 0, d0: 0 };
function fmtLeft(sec) { if (!isFinite(sec) || sec < 0) return ""; if (sec < 60) return "under a minute left"; if (sec < 3600) return `about ${Math.round(sec / 60)} min left`; return `about ${(sec / 3600).toFixed(1)} h left`; }
function showJob(j) {
  const strip = $("#idx-strip"), badge = $("#sources-badge"), card = $("#jobcard");
  const finished = !j || ["done", "failed", "stopped"].includes(j.status);
  if (finished) {
    strip.hidden = true; badge.hidden = true; card.hidden = true; jobStats.id = null;
    $$(".srcline.busy").forEach((r) => r.classList.remove("busy"));
    if (j) toast(j.status === "failed" ? `Indexing failed: ${j.error}` : `${j.target}: ${j.message || j.status}`, 6000);
    refresh().then(() => state.view === "sources" && renderSources()).catch(() => {});
    return;
  }
  const now = Date.now(); if (jobStats.id !== j.id) { jobStats.id = j.id; jobStats.t0 = now; jobStats.d0 = j.done || 0; }
  const elapsed = (now - jobStats.t0) / 1000, rate = elapsed > 3 ? ((j.done || 0) - jobStats.d0) / elapsed : 0;
  const left = j.total && rate > 0 ? fmtLeft((j.total - j.done) / rate) : (j.total ? "estimating…" : "");
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
  const verb = j.kind === "website" ? "Reading" : "Indexing", unit = j.kind === "website" ? "pages" : "files";
  badge.hidden = false; badge.title = `${verb} ${j.target}${j.total ? ` — ${j.done} of ${j.total} ${unit}` : ""}`;
  strip.hidden = false; $("#idx-fill").style.width = pct + "%"; $("#idx-msg").textContent = `${verb}… ${j.total ? `${j.done}/${j.total} ${unit}` : ""} ${left}`.trim();
  card.hidden = false;
  card.innerHTML = `<div class="ct"><span class="spin"></span>${verb} ${esc(j.target)}<span class="sp"></span><button class="btn sm" id="jc-stop">Stop after this ${unit.slice(0, -1)}</button></div>
    <div class="prog"><i style="width:${pct}%"></i></div>
    <div class="meta"><span><b>${Number(j.done || 0).toLocaleString()}</b> of <b>${j.total ? Number(j.total).toLocaleString() : "?"}</b> ${unit} ${j.kind === "website" ? "read" : /retry \d+ failed/.test(String(j.target)) ? "retried" : "checked (every file in the folder — unchanged ones are skipped quickly)"}</span><span>${pct}%</span><span>${esc(left)}</span>${j.queued ? `<span>${j.queued} more job${j.queued > 1 ? "s" : ""} queued</span>` : ""}</div>
    ${j.message ? `<div class="cur" title="${esc(j.message)}">${esc(j.message)}</div>` : ""}`;
  $("#jc-stop").onclick = guard(async () => { $("#jc-stop").disabled = true; $("#jc-stop").textContent = "Stopping…"; const r = await api("/api/index/stop", { method: "POST" }); if (!r.was_running) showJob(null); });
  $$(".srcline[data-loc]").forEach((row) => {
    const busy = String(j.target).startsWith(row.dataset.loc);
    row.classList.toggle("busy", busy);
    const live = row.querySelector(".live"); if (live) live.textContent = busy && j.total ? `${j.done}/${j.total} ${unit}` : "";
    const btn = row.querySelector("[data-reindex]");
    if (btn) { if (busy) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span>Indexing…`; } else if (btn.disabled) { btn.disabled = false; btn.textContent = btn.dataset.label || "Re-index"; } }
  });
}
function wireIndexEvents() {
  const es = new EventSource("/api/index/events");
  es.addEventListener("job", (e) => showJob(JSON.parse(e.data)));
  // On (re)connect the server says what is actually running — after a
  // restart that is usually nothing, and the page must not keep showing a
  // job that died with the old process.
  es.addEventListener("hello", (e) => { const h = JSON.parse(e.data); showJob(h.current ? { status: "running", ...h.current } : null); });
  es.onerror = () => {};
}

// ---------------------------------------------------------------- personas page
let editing = null;
function renderPersonas() {
  const cur = currentPersona();
  $("#persona-list").innerHTML = `<div class="plist">${state.personas.map((p) => `<div class="card pcard ${p.id === cur ? "on" : ""}" data-pid="${esc(p.id)}"><div class="ct">${esc(p.name)} <span class="tag">${p.builtin ? "built-in" : "yours"}</span>${p.id === cur ? `<span class="pill ok">Active — in use for chat</span>` : ""}</div><div class="d">${esc(p.description)}</div></div>`).join("")}</div>`;
  $$("[data-pid]").forEach((c) => c.addEventListener("click", () => editPersona(state.personas.find((p) => p.id === c.dataset.pid))));
  if (editing) editPersona(state.personas.find((p) => p.id === editing.id) || editing); else $("#persona-editor").hidden = true;
}
function editPersona(p, fresh) {
  editing = p; const ed = $("#persona-editor"); ed.hidden = false;
  ed.innerHTML = `<div class="ct">${fresh ? "New persona" : esc(p.name)}<span class="sp"></span>${!fresh && p.id === currentPersona() ? `<span class="pill ok">in use</span>` : `<button class="btn sm" id="pe-use">Use in chat</button>`}</div>
    <div class="row"><label>Name</label><input class="fld" id="pe-name" value="${esc(p.name)}" ${p.builtin && !fresh ? "readonly" : ""}></div>
    <div class="row"><label>One line</label><input class="fld" id="pe-desc" value="${esc(p.description)}" ${p.builtin && !fresh ? "readonly" : ""}></div>
    <div class="row wide"><label>Instructions — how it should answer. The source rules (answer only from sources, cite everything, say when it isn't there) always apply on top.</label><textarea class="fld" id="pe-prompt" ${p.builtin && !fresh ? "readonly" : ""}>${esc(p.prompt)}</textarea></div>
    <div class="row wide" style="display:flex;gap:8px">${p.builtin && !fresh ? `<button class="btn pri" id="pe-copy">Save a copy I can edit</button>` : `<button class="btn pri" id="pe-save">Save</button>${fresh ? "" : `<button class="btn danger" id="pe-del">Delete</button>`}`}</div>`;
  const val = () => ({ name: $("#pe-name").value, description: $("#pe-desc").value, prompt: $("#pe-prompt").value });
  $("#pe-use") && $("#pe-use").addEventListener("click", () => { $("#persona-select").value = p.id; store.set("persona", p.id); if (state.session) state.session.persona = p.id; renderPersonas(); toast(`Chat will answer as ${p.name}.`); });
  $("#pe-save") && $("#pe-save").addEventListener("click", guard(async () => { const saved = await api("/api/personas", { method: "POST", body: { ...(fresh ? {} : { id: p.id }), ...val() } }); editing = saved; await refresh(); renderPersonas(); toast("Persona saved."); }));
  $("#pe-copy") && $("#pe-copy").addEventListener("click", guard(async () => { const v = val(); const saved = await api("/api/personas", { method: "POST", body: { ...v, name: v.name + " (mine)" } }); editing = saved; await refresh(); renderPersonas(); toast("Copy saved — edit away."); }));
  $("#pe-del") && $("#pe-del").addEventListener("click", guard(async () => { if (!confirm(`Delete “${p.name}”?`)) return; await api(`/api/personas/${p.id}`, { method: "DELETE" }); editing = null; await refresh(); renderPersonas(); }));
}

// ---------------------------------------------------------------- settings
const SEC_TITLES = { models: ["Models", "The chat model answers; the embedding model builds the index. Both come from the provider you choose."], appearance: ["Appearance", "Applies immediately."], files: ["Indexing · Files", "Folders and files in your bundles."], websites: ["Indexing · Websites", "Websites in your bundles are read within their scope and re-checked on a schedule."], general: ["General", "Where the tool listens and keeps its data."], about: ["About", ""] };
async function renderSettings() {
  const cfg = (await api("/api/settings"));
  state.config = cfg.config; state.presets = cfg.presets; state.meta.restart_required = cfg.restart_required;
  const pane = $("#spane"); const [title, sub] = SEC_TITLES[state.sec];
  let html = `<h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ""}`;
  if (state.meta.restart_required && state.meta.restart_required.length) html += `<div class="warn">⚠ Restart AI Data Depot for ${state.meta.restart_required.join(", ")} to take effect (./DEPOT.sh restart).</div>`;
  const m = state.config.models, ix = state.config.indexing, sv = state.config.server;
  if (state.sec === "models") {
    const p = m.providers[m.active];
    html += `<div class="card"><div class="ct">Provider</div><div class="prov">${Object.entries(m.providers).map(([k, v]) => `<button data-prov="${k}" class="${k === m.active ? "on" : ""}">${esc(v.label)}</button>`).join("")}</div>
      <div class="row" style="margin-top:10px"><label>Server / base URL</label><input class="fld mono" id="m-url" value="${esc(p.base_url)}"></div>
      <div class="row"><label>API key</label><span style="max-width:520px"><input class="fld mono" id="m-key" type="text" spellcheck="false" autocomplete="off" value="${esc(p.api_key)}" placeholder="${p.local ? "not needed for a local server" : "paste your key"}"><div class="hint" style="margin-top:4px">${p.api_key ? "Saved key shown as its first 5 and last 5 characters. Paste a new one to replace it." : ""}</div></span></div>
      <div class="row"><label>Chat model</label><span style="display:flex;gap:6px;max-width:520px"><input class="fld mono" id="m-chat" value="${esc(p.chat_model)}"><button class="btn sm" id="m-pick-chat" title="Choose from the models this provider offers">List models</button></span></div>
      <div class="row"><label>Embedding model</label><span style="display:flex;gap:6px;max-width:520px"><input class="fld mono" id="m-emb" value="${esc(p.embedding_model)}" placeholder="${p.local ? "e.g. nomic-embed-text (ollama pull nomic-embed-text)" : "e.g. text-embedding-3-small"}"><button class="btn sm" id="m-pick-emb" title="Choose from the models this provider offers">List models</button></span></div>
      <div class="row"><label>Status</label><span class="status wait" id="m-status">Checking…</span></div>
      <div class="row wide" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn pri" id="m-save">Save</button><button class="btn" id="m-test">Test connection</button><span class="hint" style="align-self:center">${p.local ? "Local: your documents and questions never leave this computer." : "Cloud: questions and the matching passages are sent to " + esc(p.label) + "."}</span></div></div>
      <div class="card"><div class="ct">Answering</div>
      <div class="row"><label>Passages per answer</label><input class="fld" id="m-chunks" type="number" min="3" max="40" value="${m.context_chunks}"></div>
      <div class="row"><label>Temperature</label><input class="fld" id="m-temp" type="number" min="0" max="1" step="0.1" value="${m.temperature}"></div>
      <div class="row"><label>Max answer length (tokens)</label><input class="fld" id="m-max" type="number" min="200" max="16000" value="${m.max_tokens}"></div>
      <div class="row"><label>Default mode</label><select class="fld" id="m-mode"><option value="sources-first" ${state.config.chat.mode !== "sources-only" ? "selected" : ""}>Sources first — converse normally, cite sources when they answer, label general knowledge</option><option value="sources-only" ${state.config.chat.mode === "sources-only" ? "selected" : ""}>Sources only — refuse anything the sources do not support</option></select></div>
      <div class="row"><label>Show “How I answered”</label><span class="chk"><input type="checkbox" id="m-ledger" ${state.config.chat.show_reasoning_ledger ? "checked" : ""}><span class="hint">under every answer</span></span></div>
      <div class="row"><label>“Not found” phrase</label><input class="fld" id="m-nf" value="${esc(state.config.chat.not_found_phrase)}"></div>
      <div class="row wide"><button class="btn pri" id="m-save2">Save</button></div></div>`;
  } else if (state.sec === "appearance") {
    const sw = { "harbor-light": "linear-gradient(#f3f6f8 55%,#0f1b26 55%)", "harbor-dark": "linear-gradient(#0f1418 55%,#161c22 55%)", "reading-room": "linear-gradient(#f7f3ec 55%,#7a2e1f 55%)", ledger: "linear-gradient(#fafbf9 55%,#2f6b3a 55%)", graphite: "linear-gradient(#141416 55%,#d9b45c 55%)", system: "linear-gradient(90deg,#f3f6f8 50%,#0f1418 50%)" };
    const customs = state.config.appearance.custom_themes || []; const cur = state.config.appearance.theme;
    html += `<div class="card"><div class="ct">Theme</div><div class="sw">${state.presets.map((t) => `<button data-theme="${t.id}" class="${cur === t.id ? "on" : ""}"><i style="background:${sw[t.id] || "#888"}"></i>${esc(t.name)}</button>`).join("")}${customs.map((t) => `<button data-theme="${esc(t.id)}" class="${cur === t.id ? "on" : ""}"><i style="background:linear-gradient(${t.tokens.bg} 55%,${t.tokens.acc} 55%)"></i>${esc(t.name)}</button>`).join("")}</div>
      ${customs.length ? `<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">${customs.map((t) => `<button class="btn sm" data-edit-theme="${esc(t.id)}">Edit “${esc(t.name)}”</button><button class="btn sm danger" data-del-theme="${esc(t.id)}">Delete</button>`).join("")}</div>` : ""}</div>
      <div class="card" id="theme-editor"><div class="ct"><span id="te-title">Create your own theme</span><span class="sp"></span><label style="font-weight:500;font-size:12.5px">Start from <select class="fld" id="te-base" style="width:auto;padding:4px 8px">${state.presets.filter((t) => t.id !== "system").map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label></div>
      <div class="row"><label>Name</label><input class="fld" id="te-name" placeholder="e.g. Sunset"></div>
      <div class="row"><label>Dark theme</label><span class="chk"><input type="checkbox" id="te-dark"><span class="hint">affects form controls and scrollbars</span></span></div>
      <div class="themegrid" id="te-grid" style="margin:8px 0 12px"></div>
      <div class="row wide" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn pri" id="te-save">Save theme</button><button class="btn" id="te-preview">Preview</button><button class="btn" id="te-revert">Back to current theme</button><span class="hint" style="align-self:center">Changes preview live as you pick colours.</span></div></div>`;
  } else if (state.sec === "files") {
    const f = ix.files; const srcs = state.bundles.flatMap((b) => b.sources.filter((s) => s.kind === "path").map((s) => ({ ...s, bundle: b.name })));
    html += `<div class="card"><div class="ct">Files <span class="sp"></span><button class="btn" id="ix-files">Re-index all files</button><button class="btn" id="ix-stop">Stop</button></div>
      <div class="prog" style="margin-bottom:8px"><i id="ix-files-fill"></i></div>
      <table class="tbl"><tr><th>Bundle</th><th>Folder / file</th><th>Status</th></tr>${srcs.map((s) => `<tr><td>${esc(s.bundle)}</td><td style="font-family:var(--mono);font-size:12px">${esc(s.location)}</td><td>${srcMeta(s)} <button class="btn sm" data-reindex="${s.id}">Re-index</button></td></tr>`).join("") || `<tr><td colspan="3" class="hint">No folders yet — add one in Sources.</td></tr>`}</table></div>
      <div class="card"><div class="ct">Options</div>
      <div class="row"><label>Watch folders</label><span class="chk"><input type="checkbox" id="f-watch" ${f.watch ? "checked" : ""}><span class="hint">index new and changed files as they appear</span></span></div>
      <div class="row"><label>Read scanned PDFs (OCR)</label><span class="chk"><input type="checkbox" id="f-ocr" ${f.ocr ? "checked" : ""}><span class="hint">pages with almost no text are read as images; the first time downloads the English OCR data (~15 MB)</span></span></div>
      <div class="row"><label>OCR when a page has fewer than</label><input class="fld" id="f-ocrmin" type="number" min="0" value="${f.ocr_min_chars_per_page}"> </div>
      <div class="row"><label>Skip files larger than (MB)</label><input class="fld" id="f-max" type="number" min="1" value="${f.max_file_mb}"></div>
      <div class="row"><label>Passage size (characters)</label><input class="fld" id="f-chunk" type="number" min="500" max="8000" value="${f.chunk_chars}"></div>
      <div class="row"><label>File types</label><input class="fld mono" id="f-ext" value="${esc(f.extensions.join(" "))}"></div>
      <div class="row wide"><button class="btn pri" id="f-save">Save</button></div></div>`;
  } else if (state.sec === "websites") {
    const w = ix.websites; const srcs = state.bundles.flatMap((b) => b.sources.filter((s) => s.kind === "website").map((s) => ({ ...s, bundle: b.name })));
    html += `<div class="card"><div class="ct">Websites <span class="sp"></span><button class="btn" id="ix-web">Re-index all websites</button><button class="btn" id="ix-stop2">Stop</button></div>
      <table class="tbl"><tr><th>Bundle</th><th>Website (scope on its Sources row)</th><th>Status</th></tr>${srcs.map((s) => `<tr><td>${esc(s.bundle)}</td><td style="font-family:var(--mono);font-size:12px">${esc(s.location)}</td><td>${srcMeta(s)} <button class="btn sm" data-reindex="${s.id}">Re-index</button></td></tr>`).join("") || `<tr><td colspan="3" class="hint">No websites yet — add one in Sources.</td></tr>`}</table></div>
      <div class="card"><div class="ct">Options</div>
      <div class="row"><label>Pages per website</label><input class="fld" id="w-cap" type="number" min="1" max="20000" value="${w.max_pages_per_site}"></div>
      <div class="row"><label>Link depth</label><input class="fld" id="w-depth" type="number" min="0" max="20" value="${w.max_depth}"></div>
      <div class="row"><label>Re-index every (hours)</label><input class="fld" id="w-hours" type="number" min="0" value="${w.recheck_hours}"> </div>
      <div class="row"><label>Pause between pages (ms)</label><input class="fld" id="w-delay" type="number" min="0" value="${w.delay_ms}"></div>
      <div class="row"><label>Respect robots.txt</label><span class="chk"><input type="checkbox" id="w-robots" ${w.respect_robots ? "checked" : ""}></span></div>
      <div class="row wide"><button class="btn pri" id="w-save">Save</button></div></div>`;
  } else if (state.sec === "general") {
    html += `<div class="card"><div class="ct">Server</div>
      <div class="row"><label>Port</label><input class="fld" id="g-port" type="number" min="1" max="65535" value="${sv.port}"></div>
      <div class="row"><label>Listen on</label><select class="fld" id="g-host"><option value="127.0.0.1" ${sv.host === "127.0.0.1" ? "selected" : ""}>This computer only (127.0.0.1)</option><option value="0.0.0.0" ${sv.host === "0.0.0.0" ? "selected" : ""}>Any device on the network (0.0.0.0)</option></select></div>
      <div class="row"><label>Open the browser on start</label><span class="chk"><input type="checkbox" id="g-open" ${sv.open_browser ? "checked" : ""}></span></div>
      <div class="row"><label>Data folder</label><input class="fld mono" id="g-data" value="${esc(state.config.data_dir)}"></div>
      <div class="row"><label>Config file</label><span class="fld mono" style="border:none;padding-left:0">${esc(state.meta.config_path)}</span></div>
      <div class="warn">⚠ Port, listen address and data folder take effect after you restart AI Data Depot.</div>
      <div class="row wide" style="display:flex;gap:8px"><button class="btn pri" id="g-save">Save</button><button class="btn" id="g-reload" title="If you edited config.json in a text editor">Reload config.json</button></div></div>`;
  } else {
    html += `<div class="card"><div class="ct">AI Data Depot ${esc(state.meta.version)}</div><p>A local reference assistant. It answers only from the folders and websites you enable, cites every claim, and says when the answer isn't in your sources.</p>
      <table class="tbl"><tr><td>Config</td><td style="font-family:var(--mono);font-size:12px">${esc(state.meta.config_path)}</td></tr><tr><td>Data</td><td style="font-family:var(--mono);font-size:12px">${esc(state.meta.data_dir)}</td></tr><tr><td>Vector search</td><td>${state.meta.sqlite_vec ? "sqlite-vec (native)" : "in-process fallback"}</td></tr></table></div>`;
  }
  pane.innerHTML = html;
  // wiring
  $$("[data-prov]", pane).forEach((b) => b.addEventListener("click", guard(async () => { await api("/api/settings", { method: "PUT", body: { models: { active: b.dataset.prov } } }); await renderSettings(); renderPrivacy(); })));
  const saveModels = guard(async () => { const k = m.active; await api("/api/settings", { method: "PUT", body: { models: { active: k, providers: { [k]: { base_url: $("#m-url").value.trim(), api_key: $("#m-key").value, chat_model: $("#m-chat").value.trim(), embedding_model: $("#m-emb").value.trim() } }, context_chunks: Number($("#m-chunks").value), temperature: Number($("#m-temp").value), max_tokens: Number($("#m-max").value) }, chat: { mode: $("#m-mode").value, show_reasoning_ledger: $("#m-ledger").checked, not_found_phrase: $("#m-nf").value.trim() || "Not in your sources" } } }); toast("Saved."); await renderSettings(); renderPrivacy(); });
  $("#m-save") && ($("#m-save").onclick = saveModels); $("#m-save2") && ($("#m-save2").onclick = saveModels);
  $("#m-test") && ($("#m-test").onclick = guard(async () => { await saveModels(); }));
  const pickModel = (fieldId, what) => guard(async () => {
    const prov = m.providers[m.active];
    const r = await api(`/api/models/list`);
    if (!r.models.length) throw new Error(`${prov.label} did not list any models. Check the server address and key, or type the model name.`);
    const chosen = await pickFromList({ title: `${what} — ${prov.label}`, items: r.models, current: $(fieldId).value.trim(), hint: `${r.models.length} models offered by ${prov.label}` });
    if (chosen) { $(fieldId).value = chosen; toast(`${what}: ${chosen} — click Save to keep it.`); }
  });
  $("#m-pick-chat") && ($("#m-pick-chat").onclick = pickModel("#m-chat", "Chat model"));
  $("#m-pick-emb") && ($("#m-pick-emb").onclick = pickModel("#m-emb", "Embedding model"));
  if ($("#m-status")) { api("/api/models/status").then((st) => { const el = $("#m-status"); if (!st.reachable) { el.className = "status bad"; el.textContent = `Not reachable — ${st.error}`; return; } const parts = [`Connected${st.models.length ? ` — ${st.models.length} models available` : ""}`]; if (st.chat_model_found === false) parts.push(`chat model “${st.chat_model}” not found`); if (st.embedding_model_found === false) parts.push(`embedding model “${st.embedding_model}” not found`); if (!st.embedding_model) parts.push("no embedding model set — indexing will use the fallback provider"); el.className = "status " + (parts.length > 1 ? "bad" : "ok"); el.textContent = parts.join(" · "); }).catch((e) => { $("#m-status").className = "status bad"; $("#m-status").textContent = e.message; }); }
  $$("[data-theme]", pane).forEach((b) => b.addEventListener("click", guard(async () => { await api("/api/settings", { method: "PUT", body: { appearance: { theme: b.dataset.theme } } }); state.config.appearance.theme = b.dataset.theme; applyTheme(b.dataset.theme); await renderSettings(); })));
  if ($("#theme-editor")) {
    let editingId = null;
    const grid = $("#te-grid");
    const fill = (tokens) => { grid.innerHTML = Object.entries(TOKENS).map(([k, [v, label]]) => `<label><input type="color" data-tok="${k}" value="${tokens[k] || "#888888"}">${esc(label)}<span class="tk">${v}</span></label>`).join(""); $$("input[data-tok]", grid).forEach((i) => i.addEventListener("input", preview)); };
    const tokensNow = () => Object.fromEntries($$("input[data-tok]", grid).map((i) => [i.dataset.tok, i.value]));
    const preview = () => applyTheme(null, { tokens: tokensNow(), dark: $("#te-dark").checked });
    const startFrom = () => { const base = $("#te-base").value; fill(presetTokens(base)); $("#te-dark").checked = /dark|graphite/.test(base); preview(); };
    $("#te-base").addEventListener("change", startFrom);
    const curCustom = customTheme(state.config.appearance.theme);
    if (curCustom) { editingId = curCustom.id; $("#te-title").textContent = `Edit “${curCustom.name}”`; $("#te-name").value = curCustom.name; $("#te-dark").checked = !!curCustom.dark; fill(curCustom.tokens); } else fill(presetTokens(state.config.appearance.theme === "system" ? (mq.matches ? "harbor-dark" : "harbor-light") : state.config.appearance.theme));
    $$("[data-edit-theme]", pane).forEach((b) => b.addEventListener("click", () => { const t = customTheme(b.dataset.editTheme); editingId = t.id; $("#te-title").textContent = `Edit “${t.name}”`; $("#te-name").value = t.name; $("#te-dark").checked = !!t.dark; fill(t.tokens); preview(); $("#theme-editor").scrollIntoView({ behavior: "smooth" }); }));
    $$("[data-del-theme]", pane).forEach((b) => b.addEventListener("click", guard(async () => { const t = customTheme(b.dataset.delTheme); if (!confirm(`Delete the theme “${t.name}”?`)) return; const rest = (state.config.appearance.custom_themes || []).filter((x) => x.id !== t.id); const theme = state.config.appearance.theme === t.id ? "harbor-light" : state.config.appearance.theme; await api("/api/settings", { method: "PUT", body: { appearance: { custom_themes: rest, theme } } }); state.config.appearance.custom_themes = rest; state.config.appearance.theme = theme; applyTheme(theme); await renderSettings(); })));
    $("#te-preview").onclick = preview;
    $("#te-revert").onclick = () => applyTheme(state.config.appearance.theme);
    $("#te-save").onclick = guard(async () => {
      const name = $("#te-name").value.trim(); if (!name) throw new Error("Give the theme a name.");
      const id = editingId || ("custom-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Date.now().toString(36).slice(-4));
      const theme = { id, name, dark: $("#te-dark").checked, tokens: tokensNow() };
      const list = (state.config.appearance.custom_themes || []).filter((x) => x.id !== id); list.push(theme);
      await api("/api/settings", { method: "PUT", body: { appearance: { custom_themes: list, theme: id } } });
      state.config.appearance.custom_themes = list; state.config.appearance.theme = id; applyTheme(id); toast(`Theme “${name}” saved and applied.`); await renderSettings();
    });
  }
  $("#f-save") && ($("#f-save").onclick = guard(async () => { await api("/api/settings", { method: "PUT", body: { indexing: { files: { watch: $("#f-watch").checked, ocr: $("#f-ocr").checked, ocr_min_chars_per_page: Number($("#f-ocrmin").value), max_file_mb: Number($("#f-max").value), chunk_chars: Number($("#f-chunk").value), extensions: $("#f-ext").value.split(/[\s,]+/).filter(Boolean).map((e) => (e.startsWith(".") ? e : "." + e).toLowerCase()) } } } }); toast("Saved."); await renderSettings(); }));
  $("#w-save") && ($("#w-save").onclick = guard(async () => { await api("/api/settings", { method: "PUT", body: { indexing: { websites: { max_pages_per_site: Number($("#w-cap").value), max_depth: Number($("#w-depth").value), recheck_hours: Number($("#w-hours").value), delay_ms: Number($("#w-delay").value), respect_robots: $("#w-robots").checked } } } }); toast("Saved."); await renderSettings(); }));
  $("#g-save") && ($("#g-save").onclick = guard(async () => { const r = await api("/api/settings", { method: "PUT", body: { server: { port: Number($("#g-port").value), host: $("#g-host").value, open_browser: $("#g-open").checked }, data_dir: $("#g-data").value.trim() } }); toast(r.changed_now.length ? "Saved — restart to apply " + r.changed_now.join(", ") : "Saved."); await renderSettings(); }));
  $("#g-reload") && ($("#g-reload").onclick = guard(async () => { await api("/api/settings/reload", { method: "POST" }); await refresh(); await renderSettings(); toast("config.json reloaded."); }));
  $("#ix-files") && ($("#ix-files").onclick = guard(async () => { if (!(await ensureModelReady())) return; await api("/api/index/files", { method: "POST", body: {} }); toast("Re-indexing files."); }));
  $("#ix-web") && ($("#ix-web").onclick = guard(async () => { if (!(await ensureModelReady())) return; await api("/api/index/websites", { method: "POST", body: {} }); toast("Re-indexing websites."); }));
  $$("#ix-stop, #ix-stop2").forEach((b) => (b.onclick = guard(async () => { await api("/api/index/stop", { method: "POST" }); toast("Stopping after the current item."); })));
  $$("[data-reindex]", pane).forEach((b) => (b.onclick = guard(async () => { if (!(await ensureModelReady())) return; await api(`/api/sources/${b.dataset.reindex}/index`, { method: "POST" }); toast("Queued."); })));
}

// ---------------------------------------------------------------- views
function showView(v) {
  state.view = v; $$(".rail .nav").forEach((b) => b.classList.toggle("on", b.dataset.view === v)); $$(".view").forEach((s) => s.classList.toggle("on", s.id === "view-" + v));
  $("#app").classList.toggle("nodrawers", v !== "chat"); // the Reading-from and Evidence drawers belong to Chat
  if (v === "sources") renderSources(); if (v === "personas") renderPersonas(); if (v === "sessions") renderSessionsPage().catch((e) => toast(e.message)); if (v === "settings") renderSettings().catch((e) => toast(e.message));
}

// ---------------------------------------------------------------- boot
document.addEventListener("DOMContentLoaded", async () => {
  wireDrawers();
  $$(".rail .nav").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $$(".dr .tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("#send-btn").addEventListener("click", guard(send)); $("#stop-btn").addEventListener("click", () => state.streaming && state.streaming.abort());
  const ta = $("#composer"); ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); guard(send)(); } }); ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(180, ta.scrollHeight) + "px"; });
  $("#persona-select").addEventListener("change", () => { store.set("persona", currentPersona()); if (state.session) state.session.persona = currentPersona(); });
  $("#session-name").addEventListener("change", () => { if (state.session) state.session.name = $("#session-name").value; });
  $("#save-btn").addEventListener("click", guard(() => saveSession(false)));
  $("#sessions-btn").addEventListener("click", () => { const m = $("#sessions-menu"); m.hidden = !m.hidden; });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) $("#sessions-menu").hidden = true; });
  $$("#sessions-menu .mi[data-act]").forEach((b) => b.addEventListener("click", guard(async () => { $("#sessions-menu").hidden = true; const act = b.dataset.act;
    if (act === "save") await saveSession(false); else if (act === "new") loadSessionIntoUi(newSessionObject()); else if (act === "all") showView("sessions");
    else if (act === "import") $("#import-file").click();
    else if (act.startsWith("export")) { if (!state.session || !state.session.id) await saveSession(true); window.location.href = `/api/sessions/${state.session.id}/export${act === "export-md" ? "?format=md" : ""}`; } })));
  $("#import-file").addEventListener("change", guard(async (e) => { if (e.target.files[0]) await importSessionFile(e.target.files[0]); e.target.value = ""; }));
  $("#new-session-btn").addEventListener("click", () => loadSessionIntoUi(newSessionObject()));
  $$("#new-bundle-btn, #new-bundle-btn2").forEach((b) => b.addEventListener("click", guard(newBundle)));
  $("#index-files-btn").addEventListener("click", guard(async () => { if (!(await ensureModelReady())) return; await api("/api/index/files", { method: "POST", body: {} }); toast("Re-indexing files."); }));
  $("#index-web-btn").addEventListener("click", guard(async () => { if (!(await ensureModelReady())) return; await api("/api/index/websites", { method: "POST", body: {} }); toast("Re-indexing websites."); }));
  $("#new-persona-btn").addEventListener("click", () => editPersona({ id: null, name: "", description: "", prompt: "", builtin: false }, true));
  $$("#smenu button").forEach((b) => b.addEventListener("click", () => { state.sec = b.dataset.sec; $$("#smenu button").forEach((x) => x.classList.toggle("on", x === b)); renderSettings().catch((e) => toast(e.message)); }));
  try { await refresh(); } catch (e) { toast("Could not reach the server: " + e.message, 8000); return; }
  state.session = newSessionObject(); renderPersonaSelect(); $("#persona-select").value = store.get("persona", "general");
  $("#strict-mode").checked = state.config.chat.mode === "sources-only";
  renderPrivacy(); wireIndexEvents();
  if (!state.bundles.length) showView("sources");
});
})();
