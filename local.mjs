/**
 * Bridge Local — the loopback control API the desktop app (and the web page it
 * hosts) talk to. This is what turns "edit config.json and restart" into buttons:
 * connect your agents, connect a folder, run the doctor, restart.
 *
 * Security model (spec: specs/DESKTOP_LOCAL_FIRST_SPEC.md):
 *  - Binds 127.0.0.1 on a random port. Never a non-loopback interface.
 *  - Every request needs `X-Bridge-Token`. The token lives in `local.json` next to
 *    the Bridge config (mode 0600); only the desktop shell reads it and hands it to
 *    the page. A random website cannot find or call this server.
 *  - CORS allows exactly the configured cookbookUrl origin, plus the
 *    Private Network Access preflight header so an https page may call loopback.
 *  - Folder mapping is validated: absolute, exists, is a directory, lives under the
 *    home directory, and is not a credential/system directory.
 *
 * Everything here is additive: a Bridge run from a terminal gets the same server
 * (and the same local.json) and nothing else changes.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

/** Tool allowlists per local-access mode. `run` equals the Bridge's DEFAULT_LOCAL_TOOLS. */
export const MODE_TOOLS = Object.freeze({
  read: "Read,Glob,Grep,WebFetch,WebSearch,mcp__cookbook__*",
  edit: "Read,Glob,Grep,WebFetch,WebSearch,Write,Edit,mcp__cookbook__*",
  // ask (0086, the drive layer): reads pre-approved; every OTHER tool (Bash,
  // Write, Edit…) hits the permission relay and becomes a button in Cookbook.
  // Requires cfg.drive === true; downgrades to read otherwise.
  ask: "Read,Glob,Grep,WebFetch,WebSearch,mcp__cookbook__*",
  run: "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,mcp__cookbook__*",
});
export const MODES = Object.freeze(Object.keys(MODE_TOOLS));

export function toolsForMode(mode) {
  return MODE_TOOLS[mode] ?? null;
}

/** Infer the mode from an allowedTools string (legacy config had only the string). */
export function modeForTools(allowedTools) {
  const set = new Set(String(allowedTools || "").split(",").map((s) => s.trim()).filter(Boolean));
  if (set.has("Bash")) return "run";
  if (set.has("Write") || set.has("Edit")) return "edit";
  return "read";
}

/** Directories a folder mapping may never point into (credentials, system, the
 *  vendors' own state). Relative to home. */
const DENIED_UNDER_HOME = [
  "Library", ".ssh", ".gnupg", ".aws", ".config", ".claude", ".codex", ".codex-bridge",
  ".gemini", ".kimi-code", ".openclaw", ".cursor", ".npm", ".nvm", ".Trash",
];

/**
 * Validate a folder for local access. Pure apart from the filesystem probes.
 * Returns { ok: true, cwd } with the real path, or { ok: false, error }.
 */
export function validateFolder(input, home = os.homedir()) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "Pick a folder." };
  if (!path.isAbsolute(raw)) return { ok: false, error: "Folder path must be absolute." };
  let real;
  try {
    real = fs.realpathSync(raw);
  } catch {
    return { ok: false, error: "That folder does not exist." };
  }
  let st;
  try {
    st = fs.statSync(real);
  } catch {
    return { ok: false, error: "That folder does not exist." };
  }
  if (!st.isDirectory()) return { ok: false, error: "That path is a file, not a folder." };
  let realHome = home;
  try { realHome = fs.realpathSync(home); } catch { /* keep as given */ }
  const rel = path.relative(realHome, real);
  if (rel === "" ) return { ok: false, error: "Pick a project folder, not your whole home directory." };
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "Folders must live inside your home directory." };
  }
  const top = rel.split(path.sep)[0];
  if (DENIED_UNDER_HOME.includes(top)) {
    return { ok: false, error: `"${top}" holds credentials or system state and can't be shared with an agent.` };
  }
  return { ok: true, cwd: real };
}

/** Which vendor a configured agent is, from its command. */
export function vendorOf(agent) {
  if (!agent) return "other";
  if (agent.runner === "robot") return "robot";
  if (agent.runner === "openclaw") return "openclaw";
  const cmd = Array.isArray(agent.command) ? String(agent.command[0] ?? "") : "";
  const base = cmd.split(/[\\/]/).pop().toLowerCase();
  if (base === "claude") return "claude";
  if (base === "codex" || /ChatGPT\.app|Codex\.app/.test(cmd) || agent.runner === "app-server") return "codex";
  if (base === "agy" || base === "gemini") return "gemini";
  if (base === "kimi") return "kimi";
  if (base === "openclaw") return "openclaw";
  return "other";
}

/** Display-safe home-relative path ("~/projects/foo"). */
export function tildePath(p, home = os.homedir()) {
  const s = String(p || "");
  return s.startsWith(home) ? "~" + s.slice(home.length) : s;
}

/**
 * Open the OS folder picker from this process. macOS: AppleScript `choose folder`
 * (attributed to the Bridge's parent app, so the desktop app gets the TCC prompt).
 * Windows: FolderBrowserDialog via PowerShell. Linux: zenity if present.
 * Resolves { path } or { cancelled: true }.
 */
export function pickFolderNative({ title = "Choose a folder for this workspace", timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    let cmd;
    let args;
    if (process.platform === "darwin") {
      cmd = "osascript";
      const safe = title.replace(/["\\]/g, "");
      args = ["-e", `POSIX path of (choose folder with prompt "${safe}")`];
    } else if (process.platform === "win32") {
      cmd = "powershell";
      args = ["-NoProfile", "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }"];
    } else {
      cmd = "zenity";
      args = ["--file-selection", "--directory", `--title=${title}`];
    }
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ error: `No folder picker available (${e.message})` });
      return;
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const p = out.trim().replace(/\/$/, "");
      if (code === 0 && p) resolve({ path: p });
      else resolve({ cancelled: true });
    });
  });
}

/** Read local.json (what the desktop shell does). Exported for tests/tools. */
export function readLocalJson(configPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "local.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Create the server. `deps` is how bridge.mjs hands over the pieces that live there:
 *   cfg            the live config object (mutated in place for hot changes)
 *   cfgPath        where config.json is (local.json goes next to it)
 *   version        Bridge version string (deploy hash) or "dev"
 *   log(msg)
 *   doctor()       -> Promise<{ fails, warns, rows }>
 *   detectAgents() -> [{ name, vendor, binary, found, enabled, runner }]
 *   startConnect() -> Promise<{ approveUrl, userCode, expiresAt, agents, done: Promise<{ results }> }>
 *   applyConfig()  reload config.json into cfg (token, agents, localWorkspaces)
 *   restart()      re-exec the Bridge
 *   hotWorkspaceIds() -> Set<string>
 *   connected()    -> boolean
 *   lastError()    -> string|null
 */
export function createLocalServer(deps) {
  const { cfg, cfgPath, version = "dev", log = () => {}, home = os.homedir() } = deps;
  const token = crypto.randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();
  const localJsonPath = path.join(path.dirname(cfgPath), "local.json");
  const sseClients = new Set();
  let server = null;
  let port = 0;
  let connect = { state: "idle" };

  const origin = String(cfg.cookbookUrl || "").replace(/\/$/, "");

  const cors = (req, res) => {
    const reqOrigin = req.headers.origin;
    // Only the site's own origin may call from a page. No Origin header = native
    // caller (the desktop shell, curl from the member's own shell).
    if (reqOrigin && reqOrigin === origin) {
      res.setHeader("Access-Control-Allow-Origin", reqOrigin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Max-Age", "600");
  };

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve) => {
    let buf = "";
    req.on("data", (d) => { buf += d; if (buf.length > 64 * 1024) req.destroy(); });
    req.on("end", () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });

  const broadcast = (event, payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of sseClients) {
      try { c.write(frame); } catch { sseClients.delete(c); }
    }
  };

  const localWorkspacesView = () =>
    Object.entries(cfg.localWorkspaces ?? {}).map(([workspaceId, m]) => ({
      workspaceId,
      cwd: m.cwd,
      mode: m.mode ?? modeForTools(m.allowedTools),
      allowedTools: m.allowedTools ?? toolsForMode(m.mode ?? "run"),
    }));

  const status = () => ({
    ok: true,
    version,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    cookbookUrl: origin,
    connected: deps.connected ? !!deps.connected() : true,
    agents: deps.detectAgents ? deps.detectAgents() : [],
    localWorkspaces: localWorkspacesView(),
    // HARDWARE GRANTS (0069): is this machine currently willing to host a visiting
    // agent, and what is live right now? The desktop app renders this as the door.
    hosting: { enabled: !!cfg.hosting?.enabled, mode: cfg.hosting?.enabled === true ? "always" : cfg.hosting?.enabled === false ? "off" : "grants", activeGrants: deps.activeGrants ? deps.activeGrants() : [] },
    hotWorkspaceIds: deps.hotWorkspaceIds ? [...deps.hotWorkspaceIds()] : [],
    lastError: deps.lastError ? deps.lastError() : null,
    connect: { state: connect.state },
  });

  /** Persist a change to config.json without touching unrelated keys. */
  const saveConfigPatch = (mutate) => {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    mutate(raw);
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  };

  async function handle(req, res) {
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, "http://127.0.0.1");
    // EventSource can't set request headers, so /events (SSE only) also accepts the
    // token as a query param. Everything else requires the header.
    const headerTok = req.headers["x-bridge-token"];
    const queryTok = url.pathname === "/events" ? url.searchParams.get("token") : null;
    if (headerTok !== token && queryTok !== token) { json(res, 401, { ok: false, error: "missing or wrong X-Bridge-Token" }); return; }
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /status") return json(res, 200, status());

    // SESSIONS MIRROR (0085): hook-reporter.mjs posts raw Claude Code hook payloads
    // here. Handed straight to the Bridge's reporter (sessions.mjs), which drops
    // unmapped folders and redacts before anything leaves the machine. Always 200:
    // a hook must never see an error it might surface into someone's terminal.
    if (route === "POST /session-event") {
      const body = await readBody(req);
      try { if (body && typeof body === "object") deps.onSessionEvent?.(body); } catch { /* mirror never breaks the terminal */ }
      return json(res, 200, { ok: true });
    }

    if (route === "GET /events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closing */ } }, 20_000);
      req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    if (route === "POST /doctor") {
      try {
        const report = deps.doctor ? await deps.doctor() : { fails: 0, warns: 0, rows: [] };
        return json(res, 200, { ok: true, ...report });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (route === "POST /pick-folder") {
      const body = (await readBody(req)) ?? {};
      const picked = await pickFolderNative({ title: typeof body.title === "string" ? body.title.slice(0, 120) : undefined });
      if (picked.error) return json(res, 500, { ok: false, error: picked.error });
      if (picked.cancelled) return json(res, 200, { ok: true, cancelled: true });
      return json(res, 200, { ok: true, path: picked.path, display: tildePath(picked.path) });
    }

    if (route === "POST /folders") {
      const body = await readBody(req);
      if (!body) return json(res, 400, { ok: false, error: "invalid JSON" });
      const workspaceId = String(body.workspaceId || "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return json(res, 400, { ok: false, error: "workspaceId must be a workspace uuid" });
      const mode = MODES.includes(body.mode) ? body.mode : "edit";
      const v = validateFolder(body.cwd, home);
      if (!v.ok) return json(res, 400, { ok: false, error: v.error });
      const entry = { cwd: v.cwd, mode, allowedTools: toolsForMode(mode) };
      cfg.localWorkspaces = cfg.localWorkspaces ?? {};
      cfg.localWorkspaces[workspaceId] = entry; // hot: the next dispatch reads this
      try {
        saveConfigPatch((raw) => { raw.localWorkspaces = { ...(raw.localWorkspaces ?? {}), [workspaceId]: entry }; });
      } catch (e) {
        return json(res, 500, { ok: false, error: `saved in memory but couldn't write config: ${e.message}` });
      }
      log(`⌂ local access: workspace ${workspaceId.slice(0, 8)} → ${tildePath(v.cwd)} (${mode})`);
      broadcast("status", status());
      return json(res, 200, { ok: true, workspaceId, cwd: v.cwd, display: tildePath(v.cwd), mode, allowedTools: entry.allowedTools });
    }

    const del = url.pathname.match(/^\/folders\/([0-9a-f-]{36})$/i);
    if (req.method === "DELETE" && del) {
      const workspaceId = del[1];
      delete (cfg.localWorkspaces ?? {})[workspaceId];
      try {
        saveConfigPatch((raw) => { if (raw.localWorkspaces) delete raw.localWorkspaces[workspaceId]; });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
      log(`⌂ local access removed for workspace ${workspaceId.slice(0, 8)}`);
      broadcast("status", status());
      return json(res, 200, { ok: true });
    }

    if (route === "POST /connect-agents") {
      if (connect.state === "pending") return json(res, 200, { ok: true, ...connect });
      if (!deps.startConnect) return json(res, 501, { ok: false, error: "connect-agents not available in this Bridge" });
      try {
        const started = await deps.startConnect();
        connect = { state: "pending", approveUrl: started.approveUrl, userCode: started.userCode, expiresAt: started.expiresAt, agents: started.agents };
        started.done.then((r) => {
          connect = { state: "done", results: r.results ?? [], agents: started.agents };
          try { deps.applyConfig?.(); } catch (e) { log(`! applyConfig after connect failed: ${e.message}`); }
          broadcast("status", status());
        }).catch((e) => {
          connect = { state: "error", error: e.message, agents: started.agents };
          broadcast("status", status());
        });
        return json(res, 200, { ok: true, ...connect });
      } catch (e) {
        connect = { state: "error", error: e.message };
        return json(res, 500, { ok: false, error: e.message });
      }
    }
    if (route === "GET /connect-agents") return json(res, 200, { ok: true, ...connect });

    // Open or close the door. Deliberately a Bridge Local route rather than a
    // config edit: the Chef widget flips it in place when the person agrees, and
    // the running Bridge picks it up immediately (no restart, so a host can close
    // the door NOW).
    if (route === "POST /hosting") {
      const body = (await readBody(req)) ?? {};
      // A security toggle whose default is OFF must not fail open: an empty or
      // malformed body used to mean "turn it on" (ultrareview #123, bug_011).
      if (typeof body.enabled !== "boolean") return json(res, 400, { ok: false, error: "`enabled` must be true or false" });
      const enabled = body.enabled;
      cfg.hosting = { ...(cfg.hosting ?? {}), enabled };
      try {
        saveConfigPatch((raw) => { raw.hosting = { ...(raw.hosting ?? {}), enabled }; });
      } catch (e) {
        return json(res, 500, { ok: false, error: `changed for this session but couldn't write config: ${e.message}` });
      }
      log(enabled ? "⌂ hosting ON — an invited agent can act on this machine inside a grant you approve" : "⌂ hosting OFF — no visiting agent can act on this machine");
      broadcast("status", status());
      return json(res, 200, { ok: true, hosting: { enabled } });
    }

    if (route === "POST /restart") {
      json(res, 200, { ok: true });
      setTimeout(() => { try { deps.restart?.(); } catch (e) { log(`! restart failed: ${e.message}`); } }, 150);
      return;
    }

    return json(res, 404, { ok: false, error: `no route ${route}` });
  }

  return {
    token,
    get port() { return port; },
    localJsonPath,
    /** Emit a run lifecycle event to SSE subscribers (the desktop's notifications). */
    emit(event, payload) { broadcast(event, payload); },
    async start() {
      server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          try { json(res, 500, { ok: false, error: e.message }); } catch { /* already sent */ }
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      port = server.address().port;
      const doc = { port, token, pid: process.pid, version, startedAt, cookbookUrl: origin };
      fs.writeFileSync(localJsonPath, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
      try { fs.chmodSync(localJsonPath, 0o600); } catch { /* best effort */ }
      log(`⌂ Bridge Local listening on 127.0.0.1:${port} (token in ${path.basename(localJsonPath)})`);
      return { port, token };
    },
    stop() {
      for (const c of sseClients) { try { c.end(); } catch { /* closing */ } }
      sseClients.clear();
      try { if (server) server.close(); } catch { /* already closed */ }
      try {
        const cur = readLocalJson(cfgPath);
        if (cur && cur.pid === process.pid) fs.unlinkSync(localJsonPath);
      } catch { /* already gone */ }
    },
  };
}
