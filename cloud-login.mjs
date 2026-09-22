#!/usr/bin/env node
/**
 * CLOUD LOGIN DRIVER — runs INSIDE a Cookbook cloud sandbox, never on a member's machine.
 *
 * Drives `codex app-server` through OpenAI's documented device-code sign-in
 * (`account/login/start` with type `chatgptDeviceCode`): the server hands back a
 * verification URL and a user code, the member approves on OpenAI's page, and
 * Codex writes a managed ChatGPT session to `$CODEX_HOME/auth.json`. The web app
 * cannot talk to the app-server's stdin from outside the sandbox, so this small
 * process owns the JSON-RPC conversation and reports through two files:
 *
 *   <out>/login.json  { loginId, verificationUrl, userCode, startedAt }
 *   <out>/done.json   { ok: true, email, planType } | { ok: false, error }
 *
 * The server polls those files, then reads auth.json out and seals it. No token
 * ever passes through stdout, and nothing here logs the auth file.
 *
 *   node cloud-login.mjs --home <CODEX_HOME> --out <dir> [--codex <bin>] [--timeout-ms <n>]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const HOME = path.resolve(flag("--home", path.join(process.env.HOME || "/tmp", ".codex")));
const OUT = path.resolve(flag("--out", path.join(process.cwd(), "login")));
const CODEX = flag("--codex", process.env.CODEX_BIN || "codex");
const TIMEOUT_MS = Number(flag("--timeout-ms", String(14 * 60_000)));

fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
fs.mkdirSync(OUT, { recursive: true });
// File-backed credentials, the mode OpenAI's CI/CD guide requires for a runner
// without a keyring. Never overwrite a config the caller seeded.
const cfg = path.join(HOME, "config.toml");
if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });

function writeJson(name, value) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p + ".tmp", JSON.stringify(value));
  fs.renameSync(p + ".tmp", p); // atomic: the poller never sees a half-written file
}
function log(msg) {
  process.stdout.write(`[cloud-login] ${msg}\n`);
}

let finished = false;
function finish(result) {
  if (finished) return;
  finished = true;
  writeJson("done.json", result);
  log(result.ok ? `done: signed in as ${result.email ?? "(no email)"} on ${result.planType ?? "?"}` : `done: ${result.error}`);
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => process.exit(result.ok ? 0 : 1), 200);
}

const child = spawn(CODEX, ["app-server"], {
  env: { ...process.env, CODEX_HOME: HOME },
  stdio: ["pipe", "pipe", "pipe"],
});
child.on("error", (e) => finish({ ok: false, error: `could not start codex: ${e.message}` }));
child.on("exit", (code) => { if (!finished) finish({ ok: false, error: `codex app-server exited (${code})` }); });
child.stderr.on("data", (d) => { const s = String(d).trim(); if (s) log(`app-server: ${s.slice(0, 300)}`); });

let nextId = 1;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** Pure: what to do with one JSON-RPC line. Exported shape mirrors the tests. */
export function classify(msg) {
  if (msg && typeof msg.id === "number" && msg.method) return "server-request";
  if (msg && typeof msg.id === "number") return "response";
  if (msg && msg.method) return "notification";
  return "junk";
}

const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const kind = classify(msg);
  if (kind === "response") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  if (kind === "server-request") {
    // Nothing during a login should need us; refuse politely so the server moves on.
    child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "not supported during login" } }) + "\n");
    return;
  }
  if (kind === "notification" && msg.method === "account/login/completed") {
    const { success, error } = msg.params || {};
    if (success) void afterLogin();
    else finish({ ok: false, error: error || "login failed" });
  }
});

async function afterLogin() {
  try {
    const acct = await request("account/read", { refreshToken: false });
    const a = acct?.account || {};
    if (a.type !== "chatgpt") return finish({ ok: false, error: `signed in with ${a.type ?? "nothing"}, not ChatGPT` });
    if (!fs.existsSync(path.join(HOME, "auth.json"))) return finish({ ok: false, error: "codex did not write auth.json" });
    finish({ ok: true, email: a.email ?? null, planType: a.planType ?? null });
  } catch (e) {
    finish({ ok: false, error: `account/read failed: ${e.message}` });
  }
}

(async () => {
  try {
    await request("initialize", { clientInfo: { name: "cookbook_cloud", title: "Cookbook cloud", version: "1" } });
    const started = await request("account/login/start", { type: "chatgptDeviceCode" });
    if (!started?.verificationUrl || !started?.userCode) throw new Error("app-server returned no device code");
    writeJson("login.json", { loginId: started.loginId ?? null, verificationUrl: started.verificationUrl, userCode: started.userCode, startedAt: new Date().toISOString() });
    log(`device code ready: ${started.userCode} at ${started.verificationUrl}`);
    setTimeout(() => finish({ ok: false, error: "the code expired before it was approved" }), TIMEOUT_MS).unref();
  } catch (e) {
    finish({ ok: false, error: e.message });
  }
})();
