"use strict";
/**
 * One client for every model provider: the OpenAI chat-completions and
 * embeddings API. OpenAI, Anthropic (its OpenAI-compatible endpoint),
 * OpenRouter, Groq, LM Studio and Ollama all speak it, so "add a provider"
 * is a base URL, a key and two model names — never new code.
 */
const config = require("./config");

function providerConfig(name) {
  const cfg = config.get();
  const key = name || cfg.models.active;
  const p = cfg.models.providers[key];
  if (!p) throw new Error(`Unknown model provider "${key}". Pick one in Settings → Models.`);
  return { key, ...p };
}

/** The provider that builds the index. Follows the active one unless it has no embedding model. */
function embeddingProvider() {
  const cfg = config.get();
  const want = cfg.embeddings.provider === "active" ? cfg.models.active : cfg.embeddings.provider;
  let p = providerConfig(want);
  if (!p.embedding_model) {
    const fb = providerConfig(cfg.embeddings.fallback_provider);
    if (!fb.embedding_model) throw new Error(`Neither "${p.label}" nor the fallback "${fb.label}" has an embedding model set (Settings → Models).`);
    p = fb;
  }
  return p;
}

function headers(p) {
  const h = { "content-type": "application/json" };
  if (p.api_key) h.authorization = `Bearer ${p.api_key}`;
  if (p.base_url.includes("anthropic.com")) { h["x-api-key"] = p.api_key; h["anthropic-version"] = "2023-06-01"; }
  if (p.base_url.includes("openrouter.ai")) { h["HTTP-Referer"] = "http://localhost"; h["X-Title"] = "AI Data Depot"; }
  return h;
}

async function request(p, path, body, { stream = false, timeout } = {}) {
  const ctl = new AbortController();
  const ms = timeout || config.get().models.request_timeout_ms || 120000;
  const t = setTimeout(() => ctl.abort(), ms);
  let resp;
  try {
    resp = await fetch(p.base_url.replace(/\/+$/, "") + path, {
      method: body ? "POST" : "GET", headers: headers(p), body: body ? JSON.stringify(body) : undefined, signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    if (e.name === "AbortError") throw new Error(`${p.label} did not answer within ${Math.round(ms / 1000)} s.`);
    throw new Error(`${p.label} is not reachable at ${p.base_url} (${e.cause && e.cause.code ? e.cause.code : e.message}).`);
  }
  if (!resp.ok) {
    clearTimeout(t);
    let detail = "";
    try { const j = await resp.json(); detail = (j.error && (j.error.message || j.error)) || JSON.stringify(j); } catch { detail = await resp.text().catch(() => ""); }
    const hint = resp.status === 401 ? " Check the API key in Settings → Models." : resp.status === 404 ? " Check the model name and base URL." : "";
    const ra = resp.headers.get("retry-after"); const raNote = resp.status === 429 && ra ? ` (retry-after ${ra})` : "";
    throw new Error(`${p.label} answered ${resp.status}${raNote}: ${String(detail).slice(0, 300)}.${hint}`);
  }
  if (!stream) { clearTimeout(t); return resp.json(); }
  return { resp, done: () => clearTimeout(t) };
}

/** Models the provider offers (best-effort; some providers don't list). */
async function listModels(name) {
  const p = providerConfig(name);
  const j = await request(p, "/models", null, { timeout: 8000 });
  const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
  return ids;
}

/** Ping: can we reach it, and which of the configured models exist? */
async function status(name) {
  const p = providerConfig(name);
  const out = { provider: p.key, label: p.label, base_url: p.base_url, local: !!p.local, reachable: false, models: [], chat_model: p.chat_model, embedding_model: p.embedding_model, chat_model_found: null, embedding_model_found: null, error: null, token_param: tokenParamFor(p, p.chat_model) };
  try {
    out.models = await listModels(p.key);
    out.reachable = true;
    if (out.models.length) {
      out.chat_model_found = out.models.some((m) => m === p.chat_model || m.startsWith(p.chat_model + ":"));
      out.embedding_model_found = p.embedding_model ? out.models.some((m) => m === p.embedding_model || m.startsWith(p.embedding_model + ":")) : null;
    }
  } catch (e) { out.error = e.message; }
  return out;
}

/**
 * Chat completion, streamed. Calls onToken(text) as text arrives and resolves
 * with the full text. `messages` are OpenAI-shaped.
 */
// The answer-length parameter is `max_tokens` everywhere except OpenAI's
// newer models (o-series, gpt-5…), which reject it with a 400 naming
// `max_completion_tokens`. The first such error switches that provider/model
// to the new name for the rest of this run; nothing to configure.
const tokenParam = new Map();
function tokenParamFor(p, model) { return tokenParam.get(`${p.key}/${model}`) || "max_tokens"; }

async function chat(messages, { onToken, temperature, max_tokens, model, provider } = {}) {
  const p = providerConfig(provider);
  const cfg = config.get().models;
  const useModel = model || p.chat_model;
  const limit = max_tokens || cfg.max_tokens;
  const build = () => { const body = { model: useModel, messages, stream: true, temperature: temperature ?? cfg.temperature }; if (limit) body[tokenParamFor(p, useModel)] = limit; return body; };
  let started;
  try { started = await request(p, "/chat/completions", build(), { stream: true }); }
  catch (e) {
    if (!(/\b400\b/.test(e.message) && /max_completion_tokens/.test(e.message) && tokenParamFor(p, useModel) === "max_tokens")) throw e;
    tokenParam.set(`${p.key}/${useModel}`, "max_completion_tokens");
    console.warn(`[models] ${p.label} ${useModel} wants max_completion_tokens — switched for this run`);
    started = await request(p, "/chat/completions", build(), { stream: true });
  }
  const { resp, done } = started;
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        const text = delta && (delta.content || "");
        if (text) { full += text; if (onToken) onToken(text); }
      }
    }
  } finally { done(); }
  return full;
}

/** Embeddings for a batch of texts -> Float32Array[] (all the same dimension).
 * Rate limits (429) are retried with backoff, honouring Retry-After; a
 * "request too large" answer halves the batch and tries again, down to one
 * text — a run over ten thousand files must not lose hundreds to a busy
 * minute at the provider. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function embedBatch(p, slice, attempt = 0) {
  try {
    const j = await request(p, "/embeddings", { model: p.embedding_model, input: slice });
    const data = (j.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== slice.length) throw new Error(`${p.label} returned ${data.length} embeddings for ${slice.length} inputs.`);
    return data.map((d) => Float32Array.from(d.embedding));
  } catch (e) {
    const msg = String(e.message || "");
    const tooLarge = /too large|maximum context length|context_length|too many tokens|max.*tokens/i.test(msg);
    if (tooLarge && slice.length > 1) {
      const half = Math.ceil(slice.length / 2);
      return [...(await embedBatch(p, slice.slice(0, half))), ...(await embedBatch(p, slice.slice(half)))];
    }
    if (tooLarge) throw new Error(`One passage is too large for ${p.embedding_model} (${msg.slice(0, 120)}). Lower "Passage size" in Settings → Indexing · Files.`);
    const rateLimited = /\b429\b|rate limit|too many requests/i.test(msg);
    const transient = rateLimited || /\b(500|502|503|504)\b|did not answer within|not reachable/i.test(msg);
    if (transient && attempt < 6) {
      const retryAfter = Number((msg.match(/retry(?:-| )after[^0-9]*(\d+)/i) || [])[1]) || 0;
      const wait = Math.min(60000, retryAfter ? retryAfter * 1000 : 1500 * 2 ** attempt) + Math.random() * 500;
      await sleep(wait);
      return embedBatch(p, slice, attempt + 1);
    }
    throw e;
  }
}
async function embed(texts, { provider } = {}) {
  const p = provider ? providerConfig(provider) : embeddingProvider();
  const out = [];
  const batch = config.get().embeddings.batch_size || 32;
  for (let i = 0; i < texts.length; i += batch) out.push(...(await embedBatch(p, texts.slice(i, i + batch))));
  return out;
}

module.exports = { tokenParamFor, providerConfig, embeddingProvider, listModels, status, chat, embed };
