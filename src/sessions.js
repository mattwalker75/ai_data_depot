"use strict";
/**
 * A session is one JSON file under data/sessions/: its name, persona, model,
 * which bundles were on, and every message with its citations. That makes
 * "save", "export" and "import" the same operation — a file you can copy to
 * a colleague or keep per customer.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");

function dir() { const d = path.join(config.dataDir(), "sessions"); fs.mkdirSync(d, { recursive: true }); return d; }
function file(id) { if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Bad session id."); return path.join(dir(), id + ".json"); }

function blank(name) {
  return { id: crypto.randomBytes(6).toString("hex"), name: name || "New session", persona: "general", provider: null, model: null,
           bundles: null, messages: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), notes: "" };
}

function list() {
  return fs.readdirSync(dir()).filter((f) => f.endsWith(".json")).map((f) => {
    try { const s = JSON.parse(fs.readFileSync(path.join(dir(), f), "utf8")); return { id: s.id, name: s.name, persona: s.persona, updated_at: s.updated_at, created_at: s.created_at, message_count: (s.messages || []).length }; }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
}

function load(id) { return JSON.parse(fs.readFileSync(file(id), "utf8")); }

function save(session) {
  const s = { ...blank(), ...session };
  if (!s.id || !/^[a-z0-9-]+$/.test(s.id)) s.id = blank().id;
  s.name = String(s.name || "Untitled").trim().slice(0, 120) || "Untitled";
  s.updated_at = new Date().toISOString();
  const tmp = file(s.id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, file(s.id));
  return s;
}

function remove(id) { fs.rmSync(file(id), { force: true }); }

/** Import a session exported from another machine: keep its content, give it a fresh id if one exists already. */
function importJson(obj) {
  if (!obj || !Array.isArray(obj.messages)) throw new Error("That file is not an AI Data Depot session.");
  const s = { ...blank(obj.name), ...obj };
  if (fs.existsSync(file(s.id))) s.id = blank().id;
  return save(s);
}

function toMarkdown(s) {
  const lines = [`# ${s.name}`, "", `_Persona: ${s.persona} · Model: ${s.model || "—"} · Saved ${s.updated_at}_`, ""];
  for (const m of s.messages) {
    lines.push(m.role === "user" ? `## You` : `## Assistant`, "", m.content, "");
    if (m.citations && m.citations.length) {
      lines.push("**Sources**", "");
      for (const c of m.citations) lines.push(`${c.n}. ${c.title}${c.location ? " — " + c.location : ""}${c.href ? " <" + c.href + ">" : ""}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

module.exports = { list, load, save, remove, importJson, toMarkdown, blank };
