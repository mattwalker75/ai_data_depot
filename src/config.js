"use strict";
/**
 * config.json — the ONE place every setting lives. Edit it with a text editor
 * or through Settings in the app; both write the same file. Keys under
 * RESTART_REQUIRED only take effect after the tool is restarted, and the UI
 * says so. Keys that start with "_" are documentation and ignored.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = process.env.DEPOT_CONFIG || path.join(ROOT, "config.json");

const DEFAULTS = {
  _comment: "AI Data Depot configuration. Edit here or in Settings; both write this file. Keys starting with _ are notes.",
  server: {
    _note: "port and host take effect after a restart.",
    port: 8300,
    host: "127.0.0.1",
    open_browser: true,
  },
  data_dir: "./data",
  models: {
    _note: "The active provider answers chat AND builds the index (its embedding model). Providers are OpenAI-compatible; Ollama and LM Studio expose that same API locally.",
    active: "ollama",
    providers: {
      ollama:    { label: "Ollama (local)",  base_url: "http://localhost:11434/v1", api_key: "", chat_model: "llama3.1", embedding_model: "nomic-embed-text", local: true },
      lmstudio:  { label: "LM Studio (local)", base_url: "http://localhost:1234/v1", api_key: "", chat_model: "", embedding_model: "", local: true },
      openai:    { label: "OpenAI", base_url: "https://api.openai.com/v1", api_key: "", chat_model: "gpt-5-mini", embedding_model: "text-embedding-3-small", local: false },
      anthropic: { label: "Anthropic", base_url: "https://api.anthropic.com/v1", api_key: "", chat_model: "claude-sonnet-5", embedding_model: "", local: false, _note: "Anthropic has no embedding model; indexing uses embeddings.fallback_provider." },
      openrouter:{ label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", api_key: "", chat_model: "", embedding_model: "", local: false },
      groq:      { label: "Groq", base_url: "https://api.groq.com/openai/v1", api_key: "", chat_model: "", embedding_model: "", local: false },
      custom:    { label: "OpenAI-compatible…", base_url: "", api_key: "", chat_model: "", embedding_model: "", local: false },
    },
    temperature: 0.2,
    max_tokens: 2000,
    context_chunks: 12,
    request_timeout_ms: 120000,
  },
  embeddings: {
    _note: "Which provider builds the index. 'active' = follow models.active; if that provider has no embedding model, fallback_provider is used.",
    provider: "active",
    fallback_provider: "ollama",
    batch_size: 32,
  },
  indexing: {
    files: { watch: true, ocr: true, ocr_min_chars_per_page: 40, max_file_mb: 50, chunk_chars: 2800, chunk_overlap_chars: 300,
             extensions: [".txt", ".md", ".markdown", ".html", ".htm", ".pdf", ".docx", ".xlsx", ".xls", ".csv", ".tsv", ".json", ".pptx", ".rtf"] },
    websites: { max_pages_per_site: 500, max_depth: 6, recheck_hours: 24, delay_ms: 1000, respect_robots: true, timeout_ms: 20000, user_agent: "AI-Data-Depot/0.1 (local reference assistant)" },
  },
  appearance: { theme: "harbor-light", _presets_note: "harbor-light, harbor-dark, reading-room, ledger, system" },
  chat: { show_reasoning_ledger: true, not_found_phrase: "Not in your sources" },
};

const RESTART_REQUIRED = ["server.port", "server.host", "data_dir"];

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over === undefined ? base : over;
  if (base && typeof base === "object" && over && typeof over === "object") {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

let current = null;

function load() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
    catch (e) { throw new Error(`config.json is not valid JSON (${e.message}). Fix it or delete it to start fresh.`); }
  }
  current = deepMerge(DEFAULTS, raw);
  if (!fs.existsSync(CONFIG_PATH)) save(current);
  return current;
}

function get() { return current || load(); }

function save(cfg) {
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG_PATH);
  current = cfg;
  return cfg;
}

/** Apply a partial update from the UI; returns {config, restart_required:[...]} */
function update(patch) {
  const before = get();
  const after = deepMerge(before, patch);
  const needsRestart = RESTART_REQUIRED.filter((dotted) => getPath(before, dotted) !== getPath(after, dotted));
  save(after);
  return { config: after, restart_required: needsRestart };
}

function getPath(obj, dotted) { return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }

function dataDir() {
  const d = get().data_dir || "./data";
  const abs = path.isAbsolute(d) ? d : path.join(ROOT, d);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/** The config as the UI may see it: API keys masked. */
function redacted() {
  const cfg = JSON.parse(JSON.stringify(get()));
  for (const p of Object.values(cfg.models.providers)) {
    if (p.api_key) p.api_key = "••••" + String(p.api_key).slice(-4);
  }
  return cfg;
}

/** Undo the masking when the UI sends a config back: a masked key means "unchanged". */
function unmaskKeys(patch) {
  const providers = patch && patch.models && patch.models.providers;
  if (!providers) return patch;
  const cur = get().models.providers;
  for (const [name, p] of Object.entries(providers)) {
    if (p && typeof p.api_key === "string" && p.api_key.startsWith("••••") && cur[name]) p.api_key = cur[name].api_key;
  }
  return patch;
}

function expandHome(p) { return p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p; }

module.exports = { DEFAULTS, RESTART_REQUIRED, CONFIG_PATH, ROOT, load, get, save, update, dataDir, redacted, unmaskKeys, deepMerge, expandHome };
