// Boots the real server on a scratch port with a scratch config/data dir and
// checks the local-only trust boundary and the /api/open restriction.
const { test } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os");

const PORT = 8399;
let proc, tmp;
async function up() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "depot-test-"));
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ server: { port: PORT, host: "127.0.0.1", open_browser: false }, data_dir: path.join(tmp, "data") }));
  proc = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, DEPOT_CONFIG: path.join(tmp, "config.json"), DEPOT_NO_OPEN: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("server did not start");
}
// undici's fetch refuses to send a forged Host header, so use raw http for that case.
function raw(opts, body) {
  return new Promise((resolve, reject) => {
    const req = require("node:http").request({ host: "127.0.0.1", port: PORT, ...opts }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
    req.on("error", reject); if (body) req.write(body); req.end();
  });
}
function down() { if (proc) proc.kill(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }

test("local trust boundary: Host + Origin guard, /api/open restricted", async (t) => {
  await up(); t.after(down);
  const base = `http://127.0.0.1:${PORT}`;
  // DNS rebinding: a request whose Host is some other name is refused.
  let r = await raw({ path: "/api/state", headers: { host: "evil.example" } });
  assert.strictEqual(r.status, 421);
  r = await raw({ path: "/api/state", headers: { host: "localhost:8300" } }); assert.strictEqual(r.status, 200);
  r = await raw({ path: "/api/state", headers: { host: "[::1]:8300" } }); assert.strictEqual(r.status, 200);
  // Cross-site write refused; same-origin (browser headers) and header-less (curl) writes allowed.
  r = await fetch(`${base}/api/bundles`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }); assert.strictEqual(r.status, 403);
  r = await fetch(`${base}/api/bundles`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" }); assert.strictEqual(r.status, 403);
  r = await fetch(`${base}/api/bundles`, { method: "POST", headers: { "content-type": "application/json", origin: `http://localhost:${PORT}`, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ name: "T" }) }); assert.strictEqual(r.status, 200);
  // /api/open only opens what is indexed.
  r = await fetch(`${base}/api/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locator: "/etc/hosts" }) });
  assert.strictEqual(r.status, 400); assert.match((await r.json()).error, /in your index/);
  // config.json is private to the owner.
  const mode = fs.statSync(path.join(tmp, "config.json")).mode & 0o777;
  r = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat: { mode: "sources-only" } }) }); assert.strictEqual(r.status, 200);
  assert.strictEqual(fs.statSync(path.join(tmp, "config.json")).mode & 0o777, 0o600, `was ${mode.toString(8)}`);
  // maintenance endpoints answer
  r = await fetch(`${base}/api/maintenance/stats`); assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).bundles, 1);
  r = await fetch(`${base}/api/maintenance/compact`, { method: "POST" }); assert.strictEqual(r.status, 200);
});
