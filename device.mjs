/**
 * Cookbook Bridge — `login`, `status`, `connect-agents` (RFC 8628 device-flow client).
 *
 * `login` connects this Bridge to Cookbook WITHOUT you copy-pasting a secret:
 *   1. POST /api/bridge/device          → device_code (kept in MEMORY only),
 *                                          user_code (shown to you), interval, …
 *   2. open the browser to the authorize page; you confirm the SAME user_code
 *      and click "Authorize this Bridge".
 *   3. poll POST /api/bridge/device/token until it returns the token, then MERGE
 *      it into config.json (preserving your agents/pollSeconds/acceptFrom) and
 *      verify the connection.
 *
 * `connect-agents` runs the same flow but asks for one attributed token per agent
 * CLI found on this machine, then configures each CLI (Claude, Gemini/agy, Codex,
 * OpenClaw, Kimi). The pieces are exported separately so Bridge Local (local.mjs) can run
 * the identical flow behind a button: beginDeviceFlow → waitForDeviceToken →
 * saveLoginConfig → configureClis.
 *
 * `status` reports whether the configured token still works and which agent CLIs
 * are installed and ready.
 *
 * SECURITY: the device_code and the minted tokens are NEVER printed and the
 * device_code is NEVER written to disk. config.json is written with mode 0600.
 *
 * Node built-ins only (global fetch, Node 18+). No dependencies.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listWorkspaces } from "./cookbook.mjs";
import { which, argvForSpawn } from "./hands.mjs";
import { kimiHome } from "./harden.mjs";
import { locateConfig, writeConfigFile, cli, updateLine, checkForUpdate } from "./update.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = "https://cookbook.team";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Resolve --flag value from an argv array (e.g. ["--url","https://…"]). */
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** Path to the config: --config <path>, else COOKBOOK_CONFIG, else ~/.cookbook/config.json
 *  (a legacy config next to bridge.mjs is copied there once). Subcommands take no
 *  positional path: `connect --url https://x` must not read the URL as a file. */
export function configPath(argv) {
  return locateConfig(argv || [], { here: HERE, positional: false, log: (m) => console.error(m) });
}

/** Read existing config (or null if none). */
function readConfig(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Resolve the base URL: --url → COOKBOOK_URL → existing config → default. */
function resolveBaseUrl(argv, existing) {
  const raw =
    flag(argv, "--url") ||
    process.env.COOKBOOK_URL ||
    (existing && existing.cookbookUrl) ||
    DEFAULT_URL;
  return String(raw).replace(/\/$/, "");
}

/** Best-effort: open a URL in the default browser. Never throws. */
export function openBrowser(url) {
  // The desktop shell sets COOKBOOK_NO_BROWSER=1 and opens the printed URL in its
  // own window ("If it doesn't open, go to: <url>" stays in the output for it).
  if (process.env.COOKBOOK_NO_BROWSER === "1") return;
  try {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const args = process.platform === "win32" ? ["", url] : [url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* headless — the URL is printed as the fallback */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ───────────────────────────── device flow, as pieces ─────────────────────────────

/**
 * Step 1: start the device flow. Returns what the human needs (code + URL) and what
 * the poller needs (device_code, kept in memory only). `agents` makes the authorize
 * page list exactly which per-agent tokens one click will mint.
 */
export async function beginDeviceFlow({ baseUrl, agents = null }) {
  const start = await postForm(`${baseUrl}/api/bridge/device`, {
    device_label: os.hostname(),
    ...(agents && agents.length ? { requested_agents: agents } : {}),
  });
  if (start.status !== 200 || !start.json.device_code) {
    throw new Error(
      `Couldn't start login (HTTP ${start.status}). ${start.json.error_description || start.json.error || ""}`.trim(),
    );
  }
  const verifyUri = start.json.verification_uri;
  return {
    deviceCode: start.json.device_code, // memory only — never written/logged
    userCode: start.json.user_code,
    approveUrl: start.json.verification_uri_complete || verifyUri,
    interval: Math.max(1, Number(start.json.interval) || 5),
    expiresAt: Date.now() + (Number(start.json.expires_in) || 600) * 1000,
  };
}

/** Step 2: poll until approved. Resolves { token, agentTokens } or throws. */
export async function waitForDeviceToken({ baseUrl, deviceCode, interval, expiresAt, onTick = () => {} }) {
  let wait = interval;
  while (Date.now() < expiresAt) {
    await sleep(wait * 1000);
    onTick();
    const poll = await postForm(`${baseUrl}/api/bridge/device/token`, {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
    });
    const error = poll.json && poll.json.error;
    if (poll.status === 200 && poll.json.access_token) {
      return { token: poll.json.access_token, agentTokens: poll.json.agent_tokens || null };
    }
    if (error === "authorization_pending") continue;
    if (error === "slow_down") { wait += 5; continue; }
    if (error === "access_denied") throw new Error("Authorization was denied. Nothing was connected.");
    if (error === "expired_token") throw new Error("The code expired before it was approved. Run `login` again.");
    // Unexpected → keep trying until the deadline.
  }
  throw new Error("Timed out waiting for approval. Run `login` again.");
}

/** Which vendor an example agent entry belongs to (mirrors local.mjs vendorOf). Pure. */
function exampleAgentVendor(a) {
  if (!a || typeof a !== "object") return "other";
  if (a.runner === "openclaw") return "openclaw";
  if (a.runner === "app-server") return "codex";
  const base = String(Array.isArray(a.command) ? a.command[0] ?? "" : "").split(/[\\/]/).pop().toLowerCase();
  if (base === "claude") return "claude";
  if (base === "agy" || base === "gemini") return "gemini";
  if (base === "codex") return "codex";
  if (base === "kimi" || base === "kimi.exe") return "kimi";
  return "other";
}

/**
 * A FIRST config, shaped to this machine: the example's agents filtered to the CLIs
 * actually installed, `default` pointing at one of them (Claude first), and the
 * placeholder localWorkspaces entry dropped. Before this, a fresh `connect` copied
 * config.example.json verbatim: default Gemini, agy enabled, a "<workspace-id>"
 * placeholder, on a machine with only Claude installed, so "any"-assigned tasks
 * routed to a CLI that was not there. Pure given `found` (detectClis() rows).
 */
export function seedConfigFromExample(example, found, { log = () => {} } = {}) {
  const cfg = JSON.parse(JSON.stringify(example || {}));
  delete cfg.token;
  const installed = new Set((found || []).map((c) => c.vendor));
  const agents = Array.isArray(cfg.agents) ? cfg.agents : [];
  let kept = agents.filter((a) => installed.has(exampleAgentVendor(a)));
  if (kept.length === 0) {
    kept = agents.filter((a) => exampleAgentVendor(a) === "claude").map((a) => ({ ...a, enabled: true }));
    log("No agent CLI found on this machine yet. Keeping a Claude entry so the Bridge is ready once you install Claude Code (npm i -g @anthropic-ai/claude-code), then run connect again.");
  }
  for (const a of kept) {
    // Codex ships in the app bundle at a machine-specific path: use the one we found.
    const hit = (found || []).find((c) => c.vendor === exampleAgentVendor(a));
    if (a.runner === "app-server" && hit?.path) a.command = [hit.path];
  }
  cfg.agents = kept;
  const preferred = ["claude", "codex", "gemini", "kimi", "openclaw"];
  const enabled = kept.filter((a) => a.enabled !== false);
  const dflt = preferred.map((v) => enabled.find((a) => exampleAgentVendor(a) === v)).find(Boolean) ?? enabled[0] ?? kept[0] ?? null;
  if (dflt) cfg.default = dflt.name; else delete cfg.default;
  // The placeholder ("<workspace-id>") is documentation, not config: Bridge Local
  // maps real folders here from the app.
  cfg.localWorkspaces = Object.fromEntries(Object.entries(cfg.localWorkspaces ?? {}).filter(([k]) => !/^<.*>$/.test(k)));
  return cfg;
}

/** Step 3: merge the token into config.json (preserving everything else). */
export function saveLoginConfig(cfgPath, baseUrl, token, { found = null } = {}) {
  let cfg = readConfig(cfgPath);
  if (!cfg) {
    // First config: seed from config.example.json, shaped to the CLIs on this machine.
    const example = readConfig(path.join(HERE, "config.example.json")) || {};
    let detected = found;
    if (!detected) { try { detected = detectClis(); } catch { detected = []; } }
    cfg = seedConfigFromExample(example, detected, { log: (m) => console.log(`  ${m}`) });
  }
  cfg.cookbookUrl = baseUrl;
  cfg.token = token;
  // Home dir 0700, file 0600: this file carries every token the Bridge holds.
  writeConfigFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
}

// ───────────────────────────── CLI detection + configuration ─────────────────────────────

// `which` is shared with the hands/grants module (./hands.mjs): PATHEXT-aware on
// Windows, home-dir and Homebrew fallbacks everywhere.

/** Codex ships inside the ChatGPT app (July 2026); older installs had Codex.app; a
 *  bare `codex` on PATH also works. First hit wins. */
export function findCodexBinary() {
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(os.homedir(), "Applications/ChatGPT.app/Contents/Resources/codex"),
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return which("codex");
}

/** Kimi's install script puts the binary at $KIMI_CODE_HOME/bin/kimi (~/.kimi-code/bin),
 *  which a GUI-launched Bridge's PATH does not have; an npm install lands on PATH. */
export function findKimiBinary({ home = os.homedir(), env = process.env } = {}) {
  const onPath = which("kimi");
  if (onPath) return onPath;
  const c = path.join(kimiHome({ home, env }), "bin", process.platform === "win32" ? "kimi.exe" : "kimi");
  try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { return null; }
}

/**
 * Kimi Code has no `mcp add`; merge-write its user-level mcp.json (docs: mcpServers.<name>
 * with `url` + `headers` for HTTP). Other servers are kept; the cookbook entry keeps
 * harmless tuning (timeouts, tool lists) and gets exactly one way in: this bearer.
 * The file carries a token, so it is owner-only like config.json.
 */
export function kimiConfigure(url, token, { home = os.homedir(), env = process.env } = {}) {
  const cfgPath = path.join(kimiHome({ home, env }), "mcp.json");
  let current = {};
  try { current = JSON.parse(fs.readFileSync(cfgPath, "utf8")) ?? {}; } catch { /* fresh file */ }
  if (typeof current !== "object" || Array.isArray(current)) current = {};
  const servers = current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers) ? current.mcpServers : {};
  const prev = servers.cookbook && typeof servers.cookbook === "object" ? servers.cookbook : {};
  const { headers: _h, bearerTokenEnvVar: _b, transport: _t, url: _u, serverUrl: _s, command: _c, args: _a, env: _e, cwd: _w, enabled: _en, ...rest } = prev;
  current.mcpServers = { ...servers, cookbook: { ...rest, url, headers: { Authorization: `Bearer ${token}` } } };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(cfgPath, 0o600); } catch { /* best-effort on platforms without chmod */ }
  return cfgPath;
}

/** agy (Antigravity) has no `mcp add`; merge-write its documented config file. */
function agyConfigure(url, token) {
  const cfgPath = path.join(process.env.HOME || os.homedir(), ".gemini", "config", "mcp_config.json");
  let current = {};
  try { current = JSON.parse(fs.readFileSync(cfgPath, "utf8")) ?? {}; } catch { /* fresh file */ }
  if (typeof current !== "object" || Array.isArray(current)) current = {};
  current.mcpServers = {
    ...(current.mcpServers && typeof current.mcpServers === "object" ? current.mcpServers : {}),
    cookbook: { serverUrl: url, headers: { Authorization: `Bearer ${token}` } },
  };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  // Carries a bearer token: owner-only, like config.json (mode on create, chmod for
  // a file that already existed with wider bits).
  fs.writeFileSync(cfgPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(cfgPath, 0o600); } catch { /* best-effort on platforms without chmod */ }
  return cfgPath;
}

/**
 * Codex: a clean CODEX_HOME for the Bridge (~/.codex-bridge) with the Cookbook MCP
 * server and a copy of the member's ChatGPT login, so the app-server runner uses
 * their subscription. Returns { codexHome, hasAuth }.
 */
export function codexConfigure(url, token, { home = os.homedir() } = {}) {
  const codexHome = path.join(home, ".codex-bridge");
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const tomlPath = path.join(codexHome, "config.toml");
  let toml = "";
  try { toml = fs.readFileSync(tomlPath, "utf8"); } catch { /* fresh */ }
  // Replace any existing [mcp_servers.cookbook] block; keep everything else.
  toml = toml.replace(/\[mcp_servers\.cookbook\][\s\S]*?(?=\n\[|$)/g, "").trimEnd();
  toml += `${toml ? "\n\n" : ""}[mcp_servers.cookbook]\nurl = "${url}"\nbearer_token_env_var = "COOKBOOK_CODEX_TOKEN"\n`;
  fs.writeFileSync(tomlPath, toml, { mode: 0o600 });
  const srcAuth = path.join(home, ".codex", "auth.json");
  const dstAuth = path.join(codexHome, "auth.json");
  let hasAuth = false;
  try {
    fs.copyFileSync(srcAuth, dstAuth);
    fs.chmodSync(dstAuth, 0o600);
    hasAuth = true;
  } catch {
    hasAuth = fs.existsSync(dstAuth);
  }
  void token; // the token rides in the Bridge config (agent.token), not on disk here
  return { codexHome, hasAuth };
}

/**
 * OpenClaw: merge-write mcp.servers.cookbook with a bearer header and the
 * streamable-http transport (the SSE default hangs; OAuth never reaches its
 * claude-cli backend). Backs up the file first, then asks OpenClaw to reload.
 */
export function openclawConfigure(url, token, { home = os.homedir() } = {}) {
  const cfgPath = path.join(home, ".openclaw", "openclaw.json");
  let current = {};
  try { current = JSON.parse(fs.readFileSync(cfgPath, "utf8")) ?? {}; } catch { /* fresh */ }
  if (typeof current !== "object" || Array.isArray(current)) current = {};
  try { fs.copyFileSync(cfgPath, `${cfgPath}.bak-cookbook-${Date.now()}`); } catch { /* no existing file */ }
  current.mcp = current.mcp && typeof current.mcp === "object" ? current.mcp : {};
  current.mcp.servers = current.mcp.servers && typeof current.mcp.servers === "object" ? current.mcp.servers : {};
  const prev = current.mcp.servers.cookbook && typeof current.mcp.servers.cookbook === "object" ? current.mcp.servers.cookbook : {};
  const { auth: _a, oauth: _o, ...rest } = prev;
  current.mcp.servers.cookbook = { ...rest, url, transport: "streamable-http", headers: { Authorization: `Bearer ${token}` } };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  const bin = which("openclaw");
  if (bin) { const a = argvForSpawn([bin, "mcp", "reload"]); spawnSync(a[0], a.slice(1), { stdio: "ignore", timeout: 20_000 }); }
  return cfgPath;
}

/**
 * Which agent CLIs are on this machine. Each entry carries how to connect it.
 * Names double as the attribution labels of the tokens the authorize page mints.
 */
export function detectClis() {
  const out = [];
  const claude = which("claude");
  if (claude) out.push({ agent: "Claude", vendor: "claude", path: claude, kind: "cli-add" });
  const agy = which("agy");
  if (agy) out.push({ agent: "Gemini", vendor: "gemini", path: agy, kind: "file" });
  const codex = findCodexBinary();
  if (codex) out.push({ agent: "Codex", vendor: "codex", path: codex, kind: "codex" });
  const kimi = findKimiBinary();
  if (kimi) out.push({ agent: "Kimi", vendor: "kimi", path: kimi, kind: "kimi" });
  const openclaw = which("openclaw");
  if (openclaw) out.push({ agent: "OpenClaw", vendor: "openclaw", path: openclaw, kind: "openclaw" });
  return out;
}

/**
 * Configure every detected CLI with its attributed token. Also fixes the Bridge's
 * own config where needed (Claude allowedTools prefix; Codex agent enabled with its
 * binary, CODEX_HOME and token). Returns one result row per CLI; never throws for a
 * single CLI's failure.
 */
export function configureClis(found, { baseUrl, agentTokens, cfgPath }) {
  const mcpUrl = `${baseUrl}/api/mcp`;
  const results = [];
  for (const cli of found) {
    const token = agentTokens?.[cli.agent];
    if (!token) { results.push({ agent: cli.agent, ok: false, detail: "no token returned for this agent" }); continue; }
    try {
      if (cli.kind === "cli-add") {
        // Idempotency: drop any existing 'cookbook' server first (best-effort).
        const rm = argvForSpawn([cli.path, "mcp", "remove", "--scope", "user", "cookbook"]);
        spawnSync(rm[0], rm.slice(1), { stdio: "ignore", timeout: 20_000 });
        const addArgv = argvForSpawn([cli.path, "mcp", "add", "--scope", "user", "--transport", "http", "cookbook", mcpUrl, "--header", `Authorization: Bearer ${token}`]);
        const add = spawnSync(addArgv[0], addArgv.slice(1), { encoding: "utf8", timeout: 30_000 });
        if (add.status === 0) results.push({ agent: cli.agent, ok: true, detail: "connected (server 'cookbook', user scope)" });
        else results.push({ agent: cli.agent, ok: false, detail: String(add.stderr || add.stdout || "add failed").trim().slice(0, 200) });
        // The Bridge's OWN runs must not depend on the CLI's global server: store the
        // token on the agent so spawnAgent pins each run to it (--strict-mcp-config).
        if (/claude/i.test(cli.agent)) setAgentToken(cfgPath, /claude/i, token);
      } else if (cli.kind === "file") {
        const wrote = agyConfigure(mcpUrl, token);
        results.push({ agent: cli.agent, ok: true, detail: `connected (${wrote})` });
      } else if (cli.kind === "codex") {
        const { codexHome, hasAuth } = codexConfigure(mcpUrl, token);
        results.push({
          agent: cli.agent, ok: true,
          detail: hasAuth ? `connected (CODEX_HOME ${codexHome})` : `configured, but no ChatGPT login found: open the ChatGPT app (or run \`codex login\`), then connect again`,
          warn: !hasAuth,
        });
        enableCodexAgent(cfgPath, { binary: cli.path, codexHome, token });
      } else if (cli.kind === "openclaw") {
        const wrote = openclawConfigure(mcpUrl, token);
        results.push({ agent: cli.agent, ok: true, detail: `connected (${wrote}, streamable-http)` });
      } else if (cli.kind === "kimi") {
        const wrote = kimiConfigure(mcpUrl, token);
        results.push({ agent: cli.agent, ok: true, detail: `connected (${wrote})` });
      }
    } catch (e) {
      results.push({ agent: cli.agent, ok: false, detail: String(e?.message || e).slice(0, 200) });
    }
  }
  fixClaudeToolPrefix(cfgPath);
  return results;
}

/** Bridge config: give the agent whose command matches `re` its attributed token. */
function setAgentToken(cfgPath, re, token) {
  const raw = readConfig(cfgPath);
  if (!raw || !Array.isArray(raw.agents)) return;
  const agent = raw.agents.find((a) => a && re.test(String(a.command?.[0] ?? a.name ?? "")));
  if (!agent) return;
  agent.token = token;
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
}

/** Bridge config: make sure a Codex agent exists, is enabled, and carries its pieces. */
function enableCodexAgent(cfgPath, { binary, codexHome, token }) {
  const raw = readConfig(cfgPath);
  if (!raw) return;
  raw.agents = Array.isArray(raw.agents) ? raw.agents : [];
  let agent = raw.agents.find((a) => a && (a.runner === "app-server" || /codex/i.test(String(a.name))));
  if (!agent) {
    const example = readConfig(path.join(HERE, "config.example.json"));
    agent = (example?.agents || []).find((a) => a.runner === "app-server") || { name: "Codex", match: ["codex", "chatgpt"], runner: "app-server", sandbox: "workspace-write" };
    agent = JSON.parse(JSON.stringify(agent));
    raw.agents.push(agent);
  }
  agent.enabled = true;
  agent.command = [binary];
  agent.codexHome = codexHome;
  agent.token = token;
  for (const k of Object.keys(agent)) if (k.startsWith("_")) delete agent[k];
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
}

/** connect-agents switches claude to the CLI-added server, whose tools are
 *  mcp__cookbook__* — a Bridge config still allowing the connector-style prefix
 *  (mcp__claude_ai_Cookbook__*) would have every tool call silently blocked
 *  (live failure, 2026-07-03). Fix the config we already own. */
function fixClaudeToolPrefix(cfgPath) {
  try {
    const raw = readConfig(cfgPath);
    if (!raw) return false;
    let fixed = false;
    for (const a of raw.agents ?? []) {
      if (!Array.isArray(a.command)) continue;
      a.command = a.command.map((arg) => {
        if (typeof arg === "string" && /^mcp__claude_ai_Cookbook__/i.test(arg)) { fixed = true; return "mcp__cookbook__*"; }
        return arg;
      });
    }
    if (fixed) fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    return fixed;
  } catch {
    return false;
  }
}

/**
 * The whole connect-agents flow without a terminal: returns the approve URL right
 * away and a `done` promise that resolves when the human has approved and every
 * CLI is configured. Bridge Local calls this behind POST /connect-agents.
 */
export async function connectAgentsProgrammatic({ cfgPath, baseUrl: baseUrlIn, openBrowserTab = false }) {
  const existing = readConfig(cfgPath);
  const baseUrl = String(baseUrlIn || existing?.cookbookUrl || DEFAULT_URL).replace(/\/$/, "");
  const found = detectClis();
  const agents = found.map((c) => c.agent);
  const flow = await beginDeviceFlow({ baseUrl, agents });
  if (openBrowserTab) openBrowser(flow.approveUrl);
  const done = (async () => {
    const { token, agentTokens } = await waitForDeviceToken({ baseUrl, ...flow });
    saveLoginConfig(cfgPath, baseUrl, token, { found });
    const results = agentTokens ? configureClis(found, { baseUrl, agentTokens, cfgPath }) : found.map((c) => ({ agent: c.agent, ok: false, detail: "approved, but no agent tokens were returned" }));
    return { token, results };
  })();
  return { approveUrl: flow.approveUrl, userCode: flow.userCode, expiresAt: new Date(flow.expiresAt).toISOString(), agents, done };
}

// ───────────────────────────── CLI commands ─────────────────────────────

export async function login(argv, opts = {}) {
  const cfgPath = configPath(argv);
  const existing = readConfig(cfgPath);
  const baseUrl = resolveBaseUrl(argv, existing);
  const agents = Array.isArray(opts.agents) && opts.agents.length ? opts.agents : null;

  console.log(`\nConnecting this Bridge to Cookbook (${baseUrl})…`);
  if (agents) console.log(`  (and connecting agent CLIs: ${agents.join(", ")})`);
  console.log("");

  const flow = await beginDeviceFlow({ baseUrl, agents });
  console.log("  Your one-time code is:\n");
  console.log(`      ┌${"─".repeat(flow.userCode.length + 6)}┐`);
  console.log(`      │   ${flow.userCode}   │`);
  console.log(`      └${"─".repeat(flow.userCode.length + 6)}┘\n`);
  console.log("  Opening your browser to approve this Bridge…");
  console.log(`  If it doesn't open, go to: ${flow.approveUrl}`);
  console.log("  Confirm the code above matches, then click \"Authorize this Bridge\".\n");
  openBrowser(flow.approveUrl);

  process.stdout.write("  Waiting for approval");
  let token;
  let agentTokens;
  try {
    ({ token, agentTokens } = await waitForDeviceToken({ baseUrl, ...flow, onTick: () => process.stdout.write(".") }));
  } finally {
    console.log("");
  }

  saveLoginConfig(cfgPath, baseUrl, token);
  const loginResult = { baseUrl, token, agentTokens, cfgPath };
  try {
    const ws = await listWorkspaces({ cookbookUrl: baseUrl, token });
    console.log(`\n  ✓ Connected — ${ws.length} workspace(s) visible.`);
  } catch (e) {
    console.log(`\n  ⚠ Connected and saved config, but a test call failed: ${e.message}`);
  }
  if (!opts.quietOutro) console.log(`  Start the Bridge with:  ${cli()}\n`);
  return loginResult;
}

export async function status(argv) {
  const cfgPath = configPath(argv);
  const cfg = readConfig(cfgPath);
  if (!cfg || !cfg.token || !cfg.cookbookUrl) {
    console.log(`No connected Bridge at ${cfgPath}.\nRun: ${cli("connect")}`);
    return;
  }
  const cookbookUrl = String(cfg.cookbookUrl).replace(/\/$/, "");
  console.log(`\nBridge config: ${cfgPath}`);
  console.log(`Cookbook:      ${cookbookUrl}`);

  try {
    const ws = await listWorkspaces({ cookbookUrl, token: cfg.token });
    console.log(`Token:         ✓ valid — ${ws.length} workspace(s) visible.`);
  } catch (e) {
    console.log(`Token:         ✗ ${e.message}`);
  }

  const agents = (cfg.agents || []).filter((a) => a.enabled !== false);
  if (!agents.length) {
    console.log("Agents:        (none configured)");
    return;
  }
  console.log("Agents:");
  for (const a of agents) {
    const cmd = Array.isArray(a.command) ? a.command[0] : a.command;
    const ready = await probeAgent(cmd);
    console.log(`  ${ready ? "✓" : "✗"} ${a.name} (${cmd})${ready ? "" : " — not found on PATH"}`);
  }
  console.log("");
}

/** Spawn `<cmd> --version` to check a CLI is installed. Resolves true/false. */
function probeAgent(cmd) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      // Bare names need PATH/PATHEXT resolution (Windows), then the .cmd wrapper.
      const argv = argvForSpawn([cmd.includes(path.sep) ? cmd : which(cmd) || cmd, "--version"]);
      const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0 || code === null));
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        finish(false);
      }, 5000);
    } catch {
      finish(false);
    }
  });
}

/**
 * connect-agents — one command, one human approval, every installed agent CLI
 * connected to Cookbook with CORRECT ATTRIBUTION. Detects Claude, Gemini (agy),
 * Codex (ChatGPT app), Kimi and OpenClaw; mints one named token per agent in the same
 * approval as the Bridge token; configures each via its official path.
 */
export async function connectAgents(argv, { willRun = false } = {}) {
  const cfgPath = configPath(argv);
  const found = detectClis();
  if (found.length === 0) {
    console.log("\nNo agent CLIs found (looked for: claude, agy, codex/ChatGPT.app, kimi, openclaw).");
    console.log(`Install one, then re-run: ${cli("connect")}\n`);
    return { ok: false, reason: "no-agents", cfgPath };
  }
  console.log(`\nFound agent CLIs: ${found.map((c) => c.agent).join(", ")}`);

  // One approval mints the bridge token + one named token per agent.
  const res = await login(argv, { agents: found.map((c) => c.agent), quietOutro: true });
  if (!res || !res.agentTokens) {
    console.log("\n⚠ Approved, but no agent tokens were returned. Your Bridge login was still refreshed.");
    console.log(`  Re-run \`${cli("connect")}\`, or create tokens manually at Account > Tokens.\n`);
    return { ok: true, startBridge: true, cfgPath: res?.cfgPath || cfgPath, agentTokens: false };
  }
  const results = configureClis(found, { baseUrl: res.baseUrl, agentTokens: res.agentTokens, cfgPath: res.cfgPath });
  for (const r of results) {
    const mark = r.ok ? (r.warn ? "!" : "✓") : "✗";
    console.log(`  ${mark} ${r.agent}: ${r.detail}${r.ok && !r.warn ? ` (work will be attributed "${r.agent} · via you")` : ""}`);
  }
  await reportStaleness(res.baseUrl);
  reportNextStep(res.cfgPath, { willRun });
  return { ok: true, startBridge: true, cfgPath: res.cfgPath, agentTokens: true };
}

/** The same manifest comparison the running Bridge does at startup, printed with the
 *  same fix line, so `connect` never leaves someone on a stale copy without a word. */
async function reportStaleness(baseUrl) {
  try {
    const check = await checkForUpdate({ cookbookUrl: baseUrl }, HERE);
    if (check.changed.length) console.log(`\n  ⬆ ${updateLine(check.version, { here: HERE })}`);
  } catch { /* offline or no manifest: the Bridge re-checks every 6h */ }
}

/**
 * The single most confusing thing about `connect`: it connects, it does not RUN.
 * A member who stops here sees "dispatching to your Bridge…" forever, because
 * nothing is polling. Worse, this login just revoked the token any OTHER running
 * Bridge was using (one active Bridge token per member), so a Bridge started
 * earlier is now silently 401-looping. Say both things, precisely.
 */
function reportNextStep(cfgPath, { willRun = false } = {}) {
  // How was this invoked? cli() phrases the command for this install's layout.
  const runCmd = cli();
  const doctorCmd = cli("doctor");

  const running = findRunningBridges(cfgPath);
  console.log("");
  if (running.length === 0) {
    if (!willRun) {
      console.log("  Nothing is running yet. Connecting with --no-run does not start the Bridge; start it now:");
      console.log(`\n      ${runCmd}\n`);
      console.log("  Leave it running and your agents answer in Cookbook. The desktop app keeps");
      console.log("  one running for you if you would rather not hold a terminal open.");
    }
  } else {
    for (const r of running) {
      if (r.sameConfig) {
        console.log(`  A Bridge is already running here (pid ${r.pid}). It must restart to pick up the new token:`);
        console.log(willRun ? `\n      kill ${r.pid}   (this window takes over)\n` : `\n      kill ${r.pid} && ${runCmd}\n`);
      } else {
        console.log(`  ⚠ A Bridge is running (pid ${r.pid}) on a DIFFERENT config:`);
        console.log(`      ${r.configPath}`);
        console.log("    This login replaced its token, so it can no longer claim work. Either");
        console.log("    reconnect from that install, or stop it and run the one you just set up:");
        console.log(`\n      kill ${r.pid}${willRun ? "" : ` && ${runCmd}`}\n`);
      }
    }
  }
  console.log(`  Config:           ${cfgPath}`);
  console.log(`  Check everything: ${doctorCmd}`);
  console.log(`  Chat from here:   ${cli("chat")}\n`);
}

/**
 * Every Bridge process on this machine, from the process table: `ps` on POSIX, and
 * on Windows PowerShell's Win32_Process (command lines) with `tasklist` as the
 * fallback (pids only). Returns [] when none, null when the scan itself failed.
 * The parser is pure and exported for the test.
 */
export function parseBridgeProcesses(text, { platform = process.platform, selfPid = process.pid, format = platform === "win32" ? "tasklist" : "ps" } = {}) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (format === "tasklist") {
      // "node.exe","1234","Console","1","12,345 K"
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (!m || !/^node(\.exe)?$/i.test(m[1])) continue;
      const pid = Number(m[2]);
      if (pid === selfPid) continue;
      out.push({ pid, configPath: null, unknownCommand: true });
      continue;
    }
    // ps / CIM: "<pid> <command line>"
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === selfPid || !/bridge\.mjs(\s|"|$)/.test(cmd)) continue;
    // Only a node process RUNNING bridge.mjs counts: a shell or editor whose command
    // line merely mentions the file (a heredoc, `grep bridge.mjs`) is not a Bridge.
    const first = (cmd.match(/^"([^"]*)"|^(\S+)/) || []).slice(1).find((x) => x !== undefined) ?? "";
    if (!/(^|[\\/])node(\.exe)?$/i.test(first)) continue;
    if (/\bnode\s+--check\b|--test\b/.test(cmd)) continue;
    // Everything after bridge.mjs, kept whole: the desktop's config path has a space
    // in it ("Application Support"), so a whitespace split would lose it.
    const rest = (cmd.match(/bridge\.mjs"?\s*(.*)$/) || [, ""])[1].trim();
    let configPath = null;
    const cm = rest.match(/--config\s+"?(.+?)"?\s*$/);
    if (cm) configPath = cm[1];
    else if (/\.json"?$/i.test(rest)) configPath = rest.replace(/^"|"$/g, "");
    out.push({ pid, configPath, unknownCommand: false });
  }
  return out;
}

export function scanBridgeProcesses({ selfPid = process.pid } = {}) {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    return r.stdout || "";
  };
  if (process.platform === "win32") {
    const cim = run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"]);
    if (cim !== null) return parseBridgeProcesses(cim, { selfPid, format: "ps" });
    const tl = run("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"]);
    return tl === null ? null : parseBridgeProcesses(tl, { selfPid, format: "tasklist" });
  }
  const ps = run("ps", ["-axo", "pid=,command="]) ?? run("ps", ["-eo", "pid=,args="]);
  return ps === null ? null : parseBridgeProcesses(ps, { selfPid, format: "ps" });
}

/**
 * Bridges that are actually alive. A running Bridge writes `local.json` (port,
 * token, pid) next to its config, so a live pid there means one is polling. We
 * check the config we just wrote AND the desktop app's own data directory, which
 * is the usual source of the "I connected but a stale Bridge is still running"
 * confusion.
 */
function findRunningBridges(cfgPath) {
  // The config we just wrote, a pre-0.1.11 install's folder, and the desktop app's data dir.
  const candidates = [cfgPath, path.join(HERE, "config.json")];
  if (process.platform === "darwin") {
    candidates.push(path.join(os.homedir(), "Library", "Application Support", "ai.cookbook.desktop", "config.json"));
  }
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const localPath = path.join(path.dirname(candidate), "local.json");
    if (seen.has(localPath)) continue;
    seen.add(localPath);
    try {
      const info = JSON.parse(fs.readFileSync(localPath, "utf8"));
      if (!info?.pid) continue;
      process.kill(info.pid, 0); // throws unless the process is alive
      out.push({
        pid: info.pid,
        configPath: candidate,
        sameConfig: path.resolve(candidate) === path.resolve(cfgPath),
      });
    } catch {
      /* no local.json, or that pid is gone */
    }
  }
  return out;
}

/**
 * `cookbook-bridge host` — open the door (hardware grants, 0069).
 *
 * This is the SMALLEST possible connection to Cookbook: it asks for no agent
 * tokens and configures no CLIs, because the whole point is that it works when the
 * agents are exactly what is broken. All it needs is Node and one approval in the
 * browser; after that an agent someone invites — in a grant the host approves, with
 * a scope the host sets — can run granted verbs here while the host watches.
 *
 * If a Bridge is already running on this machine, we flip hosting ON through its
 * loopback control API instead of minting a new token: re-running the device flow
 * would revoke the live Bridge's token and kill it (the revoke rule matches on
 * token NAME), which is exactly the trap that cost a real user an afternoon.
 */
export async function host(argv) {
  const cfgPath = configPath(argv);
  const off = argv.includes("--off");

  // 1. A live Bridge? Ask it directly — no new token, nothing revoked.
  try {
    const { readLocalJson } = await import("./local.mjs");
    const local = readLocalJson(cfgPath);
    if (local && local.port && local.token && pidAlive(local.pid)) {
      const res = await fetch(`http://127.0.0.1:${local.port}/hosting`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Token": local.token },
        body: JSON.stringify({ enabled: !off }),
      });
      if (res.ok) {
        console.log(off
          ? "\n  ✓ Door closed. No visiting agent can act on this machine.\n"
          : "\n  ✓ Door open. Your Bridge is already running, and it will now serve grants you approve.\n    Invite an agent from Cookbook: they can look at your setup, and you watch every step.\n");
        return { ok: true, alreadyRunning: true };
      }
    }
  } catch { /* no live Bridge — fall through to the full setup */ }

  if (off) {
    const existing = readConfig(cfgPath) ?? {};
    if (!existing.token) { console.log("\n  Nothing to close — this machine isn't set up to host.\n"); return { ok: true }; }
    writeHosting(cfgPath, false);
    console.log("\n  ✓ Hosting is off for this machine.\n");
    return { ok: true };
  }

  // 2. No live Bridge: connect (Bridge token only — no agent tokens, no CLI edits).
  const existing = readConfig(cfgPath);
  if (!existing || !existing.token || String(existing.token).startsWith("PASTE")) {
    console.log("\nOpening a door on this machine so an agent can help you set it up.");
    console.log("This asks for nothing except permission to run the checks you approve.\n");
    await login(argv, { quietOutro: true });
  }
  writeHosting(cfgPath, true);
  console.log("\n  ✓ This machine can now host a visiting agent, inside a grant you approve.");
  console.log("    Leave this running and invite one from Cookbook; you'll see every step as it happens.\n");
  return { ok: true, startBridge: true, cfgPath };
}

/** Is that pid still alive? (signal 0 = existence check, no signal delivered) */
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Flip `hosting.enabled` in config.json without touching anything else. */
function writeHosting(cfgPath, enabled) {
  const raw = readConfig(cfgPath) ?? {};
  raw.hosting = { ...(raw.hosting ?? {}), enabled };
  writeConfigFile(cfgPath, JSON.stringify(raw, null, 2) + "\n");
}
