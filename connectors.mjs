/**
 * CONNECTOR SYNC — connect a tool once, every one of your agents has it.
 *
 * Today MCP connectors are configured per vendor, in three places, in three
 * different shapes:
 *
 *   Claude   ~/.claude.json                     mcpServers{}  (+ per-project blocks)
 *   Codex    ~/.codex/config.toml               [mcp_servers.NAME] TOML sections
 *   Gemini   ~/.gemini/config/mcp_config.json   mcpServers{} but `serverUrl` not `url`
 *
 * So a tool you wired into Claude is invisible to Codex, and drift is silent — one
 * vendor keeps pointing at a stale URL for months. This module reads all three,
 * normalizes them to one shape, and can write missing connectors back so every
 * vendor agrees. That is the Cookbook thesis at the tool layer: your agents are
 * interchangeable workers, so their capabilities should be yours, not the vendor's.
 *
 * Safety: every write makes a timestamped .bak first; secrets are never printed
 * (values are carried across as-is, shown as ••••). Node built-ins only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cli } from "./update.mjs";

const HOME = os.homedir();
export const VENDORS = {
  claude: { label: "Claude", file: path.join(HOME, ".claude.json") },
  codex: { label: "Codex", file: path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "config.toml") },
  gemini: { label: "Gemini", file: path.join(HOME, ".gemini", "config", "mcp_config.json") },
};

/** Normalized connector: { name, kind: 'stdio'|'http', command, args, env, url, headers } */
function normalize(name, raw) {
  const url = raw.url || raw.serverUrl || raw.httpUrl;
  if (url) return { name, kind: "http", url, headers: raw.headers || {} };
  return { name, kind: "stdio", command: raw.command, args: raw.args || [], env: raw.env || {} };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** A connector name is a TOML table key and a JSON key: keep it to the safe set. */
export const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** TOML basic string: quotes, backslashes and control characters escaped. Pure. */
export function tomlString(value) {
  const str = String(value ?? "");
  let out = "";
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return `"${out}"`;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A TOML section runs to the next `[` header line or the END OF THE FILE. The
 *  old pattern used `\Z`, which JavaScript reads as a literal "Z", so the LAST
 *  section in the file never matched: it was invisible to survey and, worse,
 *  never removed before a rewrite (duplicate tables). `(?![\s\S])` is the
 *  portable end-of-input. Multiline flag required. */
const SECTION_END = "(?=^\\[|(?![\\s\\S]))";

/** Regex over every `[mcp_servers.NAME]` section (no subtables). */
function sectionsRe() {
  return new RegExp("^\\[mcp_servers\\.([A-Za-z0-9_.-]+)\\][^\\S\\n]*\\n?([\\s\\S]*?)" + SECTION_END, "gm");
}

/** Regex for one connector's section AND its subtables ([mcp_servers.NAME.env]). */
function sectionRe(name) {
  return new RegExp("^\\[mcp_servers\\." + escapeRe(name) + "(?:\\.[A-Za-z0-9_.-]+)?\\][\\s\\S]*?" + SECTION_END, "gm");
}

/** Remove a connector's section(s) from a TOML document. Pure; tested. */
export function stripTomlSection(text, name) {
  return String(text ?? "").replace(sectionRe(name), "");
}

/** Render a connector as TOML section(s). Pure; tested. */
export function renderTomlSection(conn) {
  const lines = [`[mcp_servers.${conn.name}]`];
  if (conn.kind === "http") {
    lines.push(`url = ${tomlString(conn.url)}`);
  } else {
    lines.push(`command = ${tomlString(conn.command)}`);
    lines.push(`args = [${(conn.args ?? []).map((a) => tomlString(a)).join(", ")}]`);
    if (conn.env && Object.keys(conn.env).length) {
      lines.push("", `[mcp_servers.${conn.name}.env]`);
      for (const [k, v] of Object.entries(conn.env)) {
        if (!NAME_RE.test(k)) throw new Error(`env var name "${k}" is not a plain identifier`);
        lines.push(`${k} = ${tomlString(v)}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

/** Read one vendor's connectors → Map(name → normalized). */
export function readVendor(vendor) {
  const out = new Map();
  const { file } = VENDORS[vendor];
  if (vendor === "claude") {
    const j = readJson(file);
    if (!j) return out;
    for (const [n, raw] of Object.entries(j.mcpServers || {})) out.set(n, normalize(n, raw));
    return out;
  }
  if (vendor === "gemini") {
    const j = readJson(file);
    if (!j) return out;
    for (const [n, raw] of Object.entries(j.mcpServers || {})) out.set(n, normalize(n, raw));
    return out;
  }
  // codex: TOML. We only need the [mcp_servers.NAME] sections and their scalars.
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  const re = sectionsRe();
  let m;
  while ((m = re.exec(text))) {
    const [, name, body] = m;
    if (name.includes(".")) continue; // a subtable such as [mcp_servers.x.env]
    const unq = (v) => v.replace(/\\(["\\])/g, "$1").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    const get = (k) => {
      const hit = body.match(new RegExp(`^${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"));
      return hit ? unq(hit[1]) : undefined;
    };
    const argsLine = body.match(/^args\s*=\s*\[([^\]]*)\]/m);
    const args = argsLine ? [...argsLine[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unq(x[1])) : [];
    out.set(name, get("url")
      ? { name, kind: "http", url: get("url"), headers: {} }
      : { name, kind: "stdio", command: get("command"), args, env: {} });
  }
  return out;
}

/** One row per connector, with per-vendor presence and drift detection. */
export function survey() {
  const byVendor = Object.fromEntries(Object.keys(VENDORS).map((v) => [v, readVendor(v)]));
  const names = [...new Set(Object.values(byVendor).flatMap((m) => [...m.keys()]))].sort();
  return names.map((name) => {
    const present = {};
    const targets = new Set();
    for (const v of Object.keys(VENDORS)) {
      const c = byVendor[v].get(name);
      present[v] = !!c;
      if (c) targets.add(c.kind === "http" ? c.url : `${c.command} ${c.args.join(" ")}`.trim());
    }
    return { name, present, drift: targets.size > 1, targets: [...targets], byVendor };
  });
}

function backup(file) {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  } catch { /* best effort */ }
}

/** Write a connector into a vendor's config (idempotent: replaces same-named).
 *  Throws (writes nothing) when the name is unsafe or the existing file exists but
 *  does not parse: rewriting an unparseable ~/.claude.json as `{}` would have wiped
 *  every other server the member had (the file is briefly invalid while the CLI
 *  itself rewrites it). */
export function writeConnector(vendor, conn) {
  if (!NAME_RE.test(String(conn?.name ?? ""))) throw new Error(`connector name ${JSON.stringify(String(conn?.name ?? ""))} is not allowed (letters, digits, . _ - only, max 64)`);
  const { file } = VENDORS[vendor];
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (vendor === "claude" || vendor === "gemini") {
    let j = null;
    if (fs.existsSync(file)) {
      j = readJson(file);
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error(`${file} exists but does not parse as JSON right now; skipped the write so nothing is lost (retry later)`);
    } else {
      j = {};
    }
    backup(file);
    j.mcpServers = j.mcpServers || {};
    j.mcpServers[conn.name] = conn.kind === "http"
      // Claude takes `url`; Gemini takes `serverUrl`. Same connector, different key.
      ? (vendor === "gemini"
          ? { serverUrl: conn.url, ...(Object.keys(conn.headers).length ? { headers: conn.headers } : {}) }
          : { type: "http", url: conn.url, ...(Object.keys(conn.headers).length ? { headers: conn.headers } : {}) })
      : { command: conn.command, args: conn.args, ...(Object.keys(conn.env).length ? { env: conn.env } : {}) };
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return;
  }

  // codex TOML: drop any existing section(s) for this name, then append a fresh one.
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  backup(file);
  text = stripTomlSection(text, conn.name).replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  fs.writeFileSync(file, (text ? text + "\n\n" : "") + renderTomlSection(conn));
}

/** Make every vendor agree. `only` limits to named connectors; source picks whose
 *  definition wins when a connector exists in several places (default: claude). */
export function sync({ only = null, source = "claude", dryRun = false } = {}) {
  const rows = survey();
  const actions = [];
  for (const row of rows) {
    if (only && !only.includes(row.name)) continue;
    const defs = row.byVendor;
    const winner = defs[source]?.get(row.name)
      || defs.claude.get(row.name) || defs.codex.get(row.name) || defs.gemini.get(row.name);
    if (!winner) continue;
    for (const v of Object.keys(VENDORS)) {
      const existing = defs[v].get(row.name);
      const same = existing && JSON.stringify(existing) === JSON.stringify({ ...existing, ...winner });
      if (existing && same) continue;
      actions.push({ vendor: v, name: row.name, action: existing ? "update" : "add", conn: winner });
    }
  }
  if (!dryRun) {
    for (const a of actions) {
      try { writeConnector(a.vendor, a.conn); } catch (e) { a.error = e.message; }
    }
  }
  return actions;
}

// ── TEAM SYNC (0068 completed, 2026-09-01): workspace connectors -> local CLIs ──

/** A server-side team connector row -> the local write shape, WITHOUT secrets.
 *  stdio env is deliberately empty (the CLI inherits the member's shell env, so
 *  exported secret_env vars just work); an auth_env header is written only for
 *  vendors that expand ${VAR} (claude). Pure. */
export function teamConnToLocal(row, vendor) {
  const base = { name: String(row.name), kind: row.kind === "stdio" ? "stdio" : "http", command: row.command ?? null, args: Array.isArray(row.args) ? row.args : [], url: row.url ?? null, headers: {}, env: {} };
  if (base.kind === "http" && row.auth_env && vendor === "claude") {
    base.headers = { Authorization: "Bearer ${" + row.auth_env + "}" };
  }
  return base;
}

/** Which (vendor, connector) pairs need writing: missing name, or http URL drift.
 *  Never overwrites a member's local stdio command with a team one (their machine,
 *  their layout); only http drift is corrected. Pure; tested. */
export function planTeamSync(teamRows, vendorMaps, vendors = Object.keys(VENDORS)) {
  const plan = [];
  for (const row of teamRows) {
    for (const v of vendors) {
      const have = vendorMaps[v]?.get?.(String(row.name));
      if (!have) { plan.push({ vendor: v, name: String(row.name), why: "missing" }); continue; }
      if (row.kind === "http" && have.kind === "http" && row.url && have.url !== row.url) {
        plan.push({ vendor: v, name: String(row.name), why: "url drift" });
      }
    }
  }
  return plan;
}

// ── STDIO CONNECTORS WAIT FOR A CLICK ─────────────────────────────────────────
// An http connector is a URL. A stdio connector is a COMMAND this machine will run
// every time an agent starts, and it was defined by whoever edited the workspace.
// Writing it automatically turned "connect a tool for the team" into "run a
// program on every member's machine". So a new stdio row is RECORDED, not written:
// the member approves it once (`cookbook-bridge connectors approve <name>`), after
// which it syncs like any other. A changed command needs a fresh approval.

/** Stable fingerprint of what a stdio row would run. Pure. */
export function stdioFingerprint(row) {
  return JSON.stringify([String(row?.command ?? ""), Array.isArray(row?.args) ? row.args.map(String) : []]);
}

/** The pending/approved stdio map lives in config.json under "pendingConnectors". */
export function readPendingConnectors(cfgPath) {
  const raw = readJson(cfgPath);
  const m = raw && typeof raw === "object" && raw.pendingConnectors && typeof raw.pendingConnectors === "object" ? raw.pendingConnectors : {};
  return m;
}

function writePendingConnectors(cfgPath, pending) {
  const raw = readJson(cfgPath);
  if (!raw || typeof raw !== "object") throw new Error(`cannot read ${cfgPath}`);
  raw.pendingConnectors = pending;
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
}

/** Split team rows into ones that may be written now and ones waiting on the
 *  member. Records new/changed stdio rows as pending. Pure given `pending`;
 *  returns the updated map alongside. */
export function gateTeamRows(teamRows, pending) {
  const next = { ...(pending ?? {}) };
  const writable = [];
  const waiting = [];
  let changed = false;
  for (const row of teamRows) {
    if (row.kind !== "stdio") { writable.push(row); continue; }
    const name = String(row.name);
    const fp = stdioFingerprint(row);
    const entry = next[name];
    if (entry && entry.approved === true && entry.fingerprint === fp) { writable.push(row); continue; }
    if (!entry || entry.fingerprint !== fp) {
      next[name] = { approved: false, fingerprint: fp, command: String(row.command ?? ""), args: Array.isArray(row.args) ? row.args.map(String) : [], seen_at: new Date().toISOString(), ...(entry?.fingerprint && entry.fingerprint !== fp ? { changed: true } : {}) };
      changed = true;
    }
    waiting.push(row);
  }
  return { writable, waiting, pending: next, changed };
}

/** Apply a team sync for the enabled vendors. Returns log lines. IO. */
export function applyTeamSync(teamRows, vendors, { cfgPath = null } = {}) {
  const maps = Object.fromEntries(vendors.map((v) => [v, readVendor(v)]));
  const lines = [];
  let rows = teamRows;
  let waiting = [];
  if (cfgPath) {
    const gated = gateTeamRows(teamRows, readPendingConnectors(cfgPath));
    rows = gated.writable;
    waiting = gated.waiting;
    if (gated.changed) {
      try { writePendingConnectors(cfgPath, gated.pending); } catch (e) { lines.push(`  ! couldn't record pending connectors: ${e.message}`); }
    }
  } else {
    // No config path: stdio rows are never written automatically.
    rows = teamRows.filter((r) => r.kind !== "stdio");
    waiting = teamRows.filter((r) => r.kind === "stdio");
  }
  const plan = planTeamSync(rows, maps, vendors);
  for (const p of plan) {
    const row = rows.find((r) => String(r.name) === p.name);
    if (!row) continue;
    try {
      writeConnector(p.vendor, teamConnToLocal(row, p.vendor));
      lines.push(`  ↳ connector "${p.name}" -> ${VENDORS[p.vendor].label} (${p.why})`);
    } catch (e) {
      lines.push(`  ! connector "${p.name}" -> ${VENDORS[p.vendor].label} failed: ${e.message}`);
    }
  }
  for (const row of waiting) {
    lines.push(`  ? connector "${row.name}" runs a command on this machine (${[row.command, ...(row.args ?? [])].join(" ").slice(0, 80)}). Not installed until you approve it: ${cli(`connectors approve ${row.name}`)}`);
  }
  for (const row of teamRows) {
    const needs = Array.isArray(row.secret_env) ? row.secret_env.filter((k) => !process.env[k]) : [];
    if (needs.length) lines.push(`  ! connector "${row.name}" needs env var(s) you haven't set: ${needs.join(", ")} (export them in your shell)`);
  }
  return { plan, lines, waiting };
}

/** `connectors approve <name>`: flip a recorded stdio connector to approved and
 *  write it into the given vendors now. Returns log lines. IO. */
export function approveConnector(name, { cfgPath, vendors = Object.keys(VENDORS) }) {
  if (!NAME_RE.test(String(name ?? ""))) throw new Error(`"${name}" is not a valid connector name`);
  const pending = readPendingConnectors(cfgPath);
  const entry = pending[name];
  if (!entry) throw new Error(`no connector named "${name}" is waiting for approval (run the Bridge once so team connectors are recorded)`);
  pending[name] = { ...entry, approved: true, approved_at: new Date().toISOString() };
  delete pending[name].changed;
  writePendingConnectors(cfgPath, pending);
  const row = { name, kind: "stdio", command: entry.command, args: entry.args ?? [] };
  const lines = [];
  for (const v of vendors) {
    try {
      writeConnector(v, teamConnToLocal(row, v));
      lines.push(`  ↳ connector "${name}" -> ${VENDORS[v].label}`);
    } catch (e) {
      lines.push(`  ! connector "${name}" -> ${VENDORS[v].label} failed: ${e.message}`);
    }
  }
  return lines;
}
