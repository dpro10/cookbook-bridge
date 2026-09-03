/**
 * Bridge hardening helpers — side-effect-free on purpose (bridge.mjs dispatches on
 * import, so anything testable lives here; scripts/test-bridge-harden.ts pins this).
 *
 * Two protections, both from the June-2026 threat review ("The Future of the Bridge"):
 *
 * 1. BILLING PROTECTION — agents must run on the subscription the owner already pays
 *    for. If a vendor API key (ANTHROPIC_API_KEY etc.) is exported in the user's shell,
 *    the official CLIs silently switch to API-metered billing — invisible until the
 *    invoice (a documented $1,800-in-2-days failure mode). The Bridge therefore strips
 *    vendor billing keys from every agent process it spawns, unless the user explicitly
 *    opts in with `"allowApiKeyBilling": true` in config.json.
 *
 * 2. GEMINI VERSION GATE — gemini-cli below 0.39.1 has a CVSS-10.0 prompt-injection RCE
 *    (April 2026 advisory). A daemon that feeds workspace content (other people's text)
 *    to a vulnerable CLI is the exact attack shape, so the Bridge refuses to run gemini
 *    agents on vulnerable versions instead of hoping.
 *
 * 3. AGY VERSION GATE — Antigravity CLI (gemini's successor) below 1.1.1 cannot call
 *    MCP tools in headless -p mode: the run LOOKS fine but complete_task never lands,
 *    burning every attempt. Confirmed-old versions are refused with a clear message.
 *
 * 4. KIMI CODE CONTRACT (0.1.12): the fourth vendor's CLI shape lives at the bottom
 *    of this file: stream parsing, the per-run tool jail (kimi has no --allowedTools),
 *    login and MCP state. Kept here rather than in a new module so the shipped file
 *    lists (BRIDGE_RUNTIME_FILES, next.config tracing, package.json files) stay as
 *    they are.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** Env vars that flip the official CLIs from subscription auth to API-key billing. */
export const API_BILLING_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  // Kimi Code reads provider keys from config.toml, not the shell, EXCEPT the
  // env-defined model (KIMI_MODEL_NAME + KIMI_MODEL_API_KEY), which would put a
  // Bridge run on an API key. KIMI_API_KEY / MOONSHOT_API_KEY are the names the
  // docs and the Moonshot SDKs use; hidden too, so a future CLI that reads them
  // cannot flip billing either.
  "KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_MODEL_API_KEY",
];

/**
 * The environment agent processes get. By default: the parent env MINUS vendor billing
 * keys. `allowApiKeyBilling: true` opts out (user explicitly wants API billing).
 * Never mutates process.env; returns which keys were stripped so callers can say so.
 */
export function agentEnv(cfg, base = process.env) {
  const env = { ...base };
  if (cfg?.allowApiKeyBilling === true) return { env, stripped: [] };
  const stripped = API_BILLING_KEYS.filter((k) => env[k] !== undefined && env[k] !== "");
  for (const k of stripped) delete env[k];
  return { env, stripped };
}

/** Minimum safe gemini-cli (the CVSS-10.0 RCE fix landed in 0.39.1, April 2026). */
export const GEMINI_MIN_VERSION = "0.39.1";

/** First X.Y.Z in a CLI's --version output, or null if none. */
export function parseVersion(text) {
  const m = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Numeric semver triple compare: a < b. */
export function versionLt(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}

/** Does this agent's binary look like gemini-cli? (name-based; absolute paths count) */
export function isGeminiCommand(cmd) {
  if (typeof cmd !== "string" || !cmd) return false;
  const base = cmd.split(/[\\/]/).pop().toLowerCase();
  return base === "gemini" || base.startsWith("gemini-");
}

/** Probe a binary's `--version` (argv array so tests can use ["node", fakeScript]).
 *  Resolves the first X.Y.Z found, or null (timeout / spawn-fail / unparseable). */
function probeVersion(argv, timeoutMs) {
  return new Promise((resolve) => {
    const [cmd, ...rest] = Array.isArray(argv) ? argv : [argv];
    let out = "";
    let done = false;
    const finish = (version) => !done && ((done = true), resolve(version));
    try {
      const child = spawn(cmd, [...rest, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
      const t = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", () => { clearTimeout(t); finish(null); });
      child.on("close", () => { clearTimeout(t); finish(parseVersion(out)); });
    } catch {
      finish(null);
    }
  });
}

/**
 * Probe a gemini binary's version. Returns { version, vulnerable } — version null
 * when unparseable (caller warns, doesn't block; only a CONFIRMED-old version blocks).
 */
export async function checkGeminiVersion(argv, timeoutMs = 10_000) {
  const version = await probeVersion(argv, timeoutMs);
  return { version, vulnerable: version ? versionLt(version, GEMINI_MIN_VERSION) : false };
}

/** Minimum Antigravity CLI (agy) whose headless `-p` can call MCP tools NATIVELY.
 *  Fixed in 1.1.1 (2026-07-10; verified empirically 2026-07-13 — read via
 *  list_workspaces and write via create_file under --sandbox both landed). Below
 *  1.1.1 agy ingests tool schemas but can't invoke them, so every task "runs but
 *  never completes" — the Bridge's most confusing failure class. Gate like gemini. */
export const AGY_MIN_VERSION = "1.1.1";

/** Does this agent's binary look like the Antigravity CLI? (name-based; paths count) */
export function isAgyCommand(cmd) {
  if (typeof cmd !== "string" || !cmd) return false;
  const base = cmd.split(/[\\/]/).pop().toLowerCase();
  return base === "agy" || base === "antigravity";
}

/** Probe an agy binary's version. Returns { version, tooOld } — same null semantics
 *  as checkGeminiVersion (only a CONFIRMED-old version blocks). */
export async function checkAgyVersion(argv, timeoutMs = 10_000) {
  const version = await probeVersion(argv, timeoutMs);
  return { version, tooOld: version ? versionLt(version, AGY_MIN_VERSION) : false };
}

// ── identity: a run acts as the Bridge's member, not as whoever the CLI is ──────
//
// Verified failure (2026-08-25): a Bridge-run `claude -p` refused every Cookbook
// tool because a stale claude.ai-synced connector poisoned the headless session,
// and when tools did work they acted as the CLI's own login — a different account
// that couldn't see the workspace, so complete_task returned "Not found". Both are
// the same mistake: letting the run inherit the CLI's global MCP state.
//
// `--strict-mcp-config --mcp-config <json>` makes the run see ONLY Cookbook, as the
// member whose token this is, attributed under that token's name.

/** True when this command runs the claude CLI (any path, any wrapper flags). */
export function isClaudeCommand(command) {
  const base = String(command?.[0] ?? "").split(/[\\/]/).pop().toLowerCase();
  return base === "claude";
}

/**
 * Rewrite a claude command so the run carries its own Cookbook connection.
 * Pure. No-op (and says so) when it isn't claude, has no token, or the command
 * already pins an MCP config by hand.
 */
/**
 * Wire the ask-mode permission relay into a claude command (0086). Applied AFTER
 * withCookbookMcp: merges the cbapprove stdio server into the pinned --mcp-config
 * (or pins one) and points --permission-prompt-tool at it. Pure; tested.
 */
export function withApprovalRelay(command, { serverPath, env } = {}) {
  if (!Array.isArray(command) || !isClaudeCommand(command)) return { command, injected: false, reason: "not claude" };
  if (!serverPath) return { command, injected: false, reason: "no server path" };
  if (command.includes("--permission-prompt-tool")) return { command, injected: false, reason: "already wired" };
  const server = { command: process.execPath, args: [serverPath], env: env ?? {} };
  const out = [...command];
  const i = out.indexOf("--mcp-config");
  if (i >= 0 && i + 1 < out.length) {
    try {
      const cfg = JSON.parse(out[i + 1]);
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), cbapprove: server };
      out[i + 1] = JSON.stringify(cfg);
    } catch {
      return { command, injected: false, reason: "unparseable mcp-config" };
    }
  } else {
    out.splice(1, 0, "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { cbapprove: server } }));
  }
  out.push("--permission-prompt-tool", "mcp__cbapprove__approve");
  return { command: out, injected: true, reason: null };
}

// ── the token leaves argv ──────────────────────────────────────────────────────
// withCookbookMcp / withApprovalRelay build the MCP config as an inline JSON
// string, which is convenient (pure, testable) but puts a bearer token on the
// command line, where `ps`, activity monitors and crash reports can read it. Right
// before the spawn, the inline JSON is moved into a private temp file (0700 dir,
// 0600 file) and argv carries only the path: `claude --mcp-config <file>` accepts
// either. Files are removed when the run ends and, as a backstop, at exit.
const liveMcpDirs = new Set();
let exitHookInstalled = false;
function installMcpExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const d of liveMcpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    liveMcpDirs.clear();
  });
}

/** Move an inline `--mcp-config {json}` into a 0600 temp file. Identity when the
 *  command has no inline JSON. Returns { command, file, cleanup }. IO; tested. */
export function materializeMcpConfig(command, { dir = os.tmpdir() } = {}) {
  const noop = { command, file: null, cleanup: () => {} };
  if (!Array.isArray(command)) return noop;
  const i = command.indexOf("--mcp-config");
  if (i < 0 || i + 1 >= command.length || !/^\s*\{/.test(String(command[i + 1]))) return noop;
  const privDir = fs.mkdtempSync(path.join(dir, "cookbook-bridge-"));
  try { fs.chmodSync(privDir, 0o700); } catch { /* best effort on platforms without modes */ }
  const file = path.join(privDir, "mcp.json");
  fs.writeFileSync(file, String(command[i + 1]), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  liveMcpDirs.add(privDir);
  installMcpExitHook();
  const out = [...command];
  out[i + 1] = file;
  const cleanup = () => {
    liveMcpDirs.delete(privDir);
    try { fs.rmSync(privDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { command: out, file, cleanup };
}

export function withCookbookMcp(command, { token, cookbookUrl } = {}) {
  if (!Array.isArray(command) || !isClaudeCommand(command)) return { command, injected: false, reason: "not claude" };
  if (!token) return { command, injected: false, reason: "no token" };
  if (!cookbookUrl) return { command, injected: false, reason: "no cookbookUrl" };
  if (command.includes("--mcp-config") || command.includes("--strict-mcp-config")) return { command, injected: false, reason: "already pinned" };
  const cfg = JSON.stringify({
    mcpServers: {
      cookbook: {
        type: "http",
        url: `${String(cookbookUrl).replace(/\/$/, "")}/api/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  });
  return { command: [command[0], "--strict-mcp-config", "--mcp-config", cfg, ...command.slice(1)], injected: true, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// KIMI CODE (the fourth vendor, 0.1.12): the CLI contract, pinned empirically
// ─────────────────────────────────────────────────────────────────────────────
//
// Read off `kimi --help` (0.39.1), the prompt-mode emitter in the binary, and the
// docs at moonshotai.github.io/kimi-code (2026-09-02):
//
//  - Headless: `kimi -p "<prompt>" --output-format stream-json`. `-p` takes the
//    prompt as an argument (there is no stdin mode). `-p` REFUSES --yolo, --auto
//    and --plan: prompt mode always runs in "auto" permission (every tool call is
//    approved; static deny rules still apply). There is no --allowedTools flag.
//    The jail is an agent file: `--agent-file <md>` whose frontmatter `tools:` is
//    an allowlist (`mcp__cookbook__*` globs work). kimiCommand() below writes one
//    per run from the command's `--allowedTools` value, so config.json keeps the
//    same shape as the Claude entry and localizeCommand keeps working.
//  - stream-json: one JSON object per stdout line, keyed by `role`:
//      {"role":"meta","type":"system.version","version":"0.39.1"}
//      {"role":"assistant","content":"..."}                       a finished turn's text
//      {"role":"assistant","tool_calls":[{"type":"function","id":"...",
//         "function":{"name":"Read","arguments":"{\"path\":\"...\"}"}}]}
//      {"role":"tool","tool_call_id":"...","content":"..."}         the tool's output
//      {"role":"meta","type":"turn.step.retrying","failed_attempt":1,"next_attempt":2,
//         "max_attempts":10,"delay_ms":557.5,"error_name":"APIConnectionError",
//         "error_message":"Connection error."}
//      {"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>",
//         "command":"kimi -r session_<uuid>","content":"To resume this session: ..."}
//    Thinking is never written to stdout; tool progress and notices go to stderr.
//    No usage line exists, so the receipt is duration-only.
//  - Resume: `-S <id>` (hidden alias `-r`), legal with `-p`, illegal with
//    `--agent-file` (a resumed session keeps the agent it was created with).
//  - Model: `-m <alias>`; aliases come from ~/.kimi-code/config.toml.
//  - MCP: ~/.kimi-code/mcp.json ($KIMI_CODE_HOME/mcp.json): mcpServers.<name> with
//    `url` (+ `headers`) for HTTP. A project-level .kimi-code/mcp.json exists but
//    sits behind the workspace-trust prompt, so the Bridge writes the user file.
//    Tools are named mcp__<server>__<tool>.
//  - Login: [providers.<name>] in config.toml (api_key, or an oauth table written
//    by `kimi login`); OAuth credentials under ~/.kimi-code/credentials/.

/** Kimi's data root: $KIMI_CODE_HOME, else ~/.kimi-code. */
export function kimiHome({ home = process.env.HOME || os.homedir(), env = process.env } = {}) {
  return env.KIMI_CODE_HOME || path.join(home, ".kimi-code");
}

/** True when this command (argv array or bare string) runs the kimi CLI. */
export function isKimiCommand(command) {
  const first = Array.isArray(command) ? command[0] : command;
  const base = String(first ?? "").split(/[\\/]/).pop().toLowerCase();
  return base === "kimi" || base === "kimi.exe";
}

/** Probe `kimi --version` (e.g. "0.39.1"). No gate: nothing is refused, doctor prints it. */
export async function checkKimiVersion(argv, timeoutMs = 10_000) {
  return { version: await probeVersion(argv, timeoutMs) };
}

/** Kimi built-in tool names the live work log should read as verbs (live.mjs
 *  already knows Read/Write/Edit/Bash/Grep/Glob/WebSearch by their lowercase). */
const KIMI_TOOL_VERBS = { fetchurl: "fetch", readmediafile: "read", todolist: "todo", agent: "agent", agentswarm: "agent", skill: "skill" };

/**
 * One stream-json line → what the Bridge shows. Null for non-kimi lines (a claude
 * line has `type`, never a top-level `role`). Pure.
 *   { role, text, calls: [{kind:'call', id, name, input} | {kind:'result', id, err}],
 *     sessionId, retry: {attempt, max, error} | null }
 */
export function kimiFromLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== "object" || typeof j.role !== "string") return null;
  const ev = { role: j.role, text: null, calls: [], sessionId: null, retry: null };
  if (j.role === "assistant") {
    if (typeof j.content === "string" && j.content.trim()) ev.text = j.content;
    for (const tc of Array.isArray(j.tool_calls) ? j.tool_calls : []) {
      const raw = String(tc?.function?.name ?? tc?.name ?? "").trim();
      if (!raw) continue;
      let input = tc?.function?.arguments ?? tc?.arguments;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* partial or plain text: keep the string */ } }
      const name = raw.startsWith("mcp__") ? raw : (KIMI_TOOL_VERBS[raw.toLowerCase()] ?? raw);
      ev.calls.push({ kind: "call", id: String(tc?.id ?? ""), name, input });
    }
  } else if (j.role === "tool") {
    ev.calls.push({ kind: "result", id: String(j.tool_call_id ?? ""), err: kimiToolFailed(j.content) });
  } else if (j.role === "meta") {
    if (j.type === "session.resume_hint" && typeof j.session_id === "string" && j.session_id) ev.sessionId = j.session_id;
    if (j.type === "turn.step.retrying") {
      ev.retry = {
        attempt: Number(j.failed_attempt) || 0,
        max: Number(j.max_attempts) || 0,
        error: `${j.error_name ?? "error"}${j.error_message ? `: ${j.error_message}` : ""}`,
      };
    }
  }
  return ev;
}

/** Best-effort: a tool result that reads as a failure (kimi has no is_error flag). */
function kimiToolFailed(content) {
  const text = typeof content === "string" ? content : (content == null ? "" : JSON.stringify(content));
  return /^\s*(error\b|tool error|permission denied|denied\b|command failed|failed to)/i.test(text);
}

/**
 * The claude-shaped result envelope for a finished kimi run, so displayText,
 * resultError, failureHint and extractUsage need no kimi branch. Pure.
 */
export function kimiResultEnvelope({ text = "", sessionId = null, durationMs = 0, code = 0, err = "", numTurns = 0 } = {}) {
  const failed = typeof code === "number" && code !== 0;
  const tail = String(err ?? "").trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
  return JSON.stringify({
    type: "result",
    subtype: failed ? "error_during_execution" : "success",
    is_error: failed,
    result: String(text ?? ""),
    duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
    num_turns: numTurns,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(failed ? { errors: [tail || `kimi exited ${code}`] } : {}),
    runner: "kimi",
  });
}

/** Claude tool names that appear in Bridge configs → the kimi name of the same tool. */
export const KIMI_TOOL_ALIASES = Object.freeze({ WebFetch: "FetchURL", TodoWrite: "TodoList", Task: "Agent" });

/** "Bash,Read,mcp__cookbook__*" → ["Bash", "Read", "mcp__cookbook__*"], kimi names, deduped. */
export function kimiTools(spec) {
  const out = [];
  for (const raw of String(spec ?? "").split(",")) {
    const t = raw.trim();
    // Tool names are plain tokens; anything else is not a tool and never reaches YAML.
    if (!t || !/^[A-Za-z0-9_*.:-]+$/.test(t)) continue;
    const name = KIMI_TOOL_ALIASES[t] ?? t;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** The agent file that jails one run: same system prompt, only these tools.
 *  An empty list means NO tools (kimi: `tools: []`), which is what a summary wants. */
export function kimiAgentFile(spec) {
  const tools = kimiTools(spec);
  const list = tools.length ? "\n" + tools.map((t) => `  - ${t}`).join("\n") : " []";
  return [
    "---",
    "name: cookbook-bridge",
    "description: A Cookbook Bridge run. Only the tools this task was given.",
    `tools:${list}`,
    "---",
    "${base_prompt}",
    "",
  ].join("\n");
}

/**
 * Turn a Bridge-shaped kimi command into what the CLI accepts: `--allowedTools X`
 * (which kimi does not have) becomes `--agent-file <0600 temp file>` carrying X as
 * the tools allowlist. On a resume (-S/-r/-c) the flag is simply dropped: kimi
 * refuses --agent-file there and the session already carries the jail it was
 * created with. Identity for non-kimi commands and commands without the flag.
 * Returns { command, file, cleanup, tools }. IO; tested.
 */
export function kimiCommand(command, { dir = os.tmpdir() } = {}) {
  const noop = { command, file: null, cleanup: () => {}, tools: null };
  if (!Array.isArray(command) || !isKimiCommand(command)) return noop;
  const i = command.indexOf("--allowedTools");
  if (i < 0) return noop;
  const spec = i + 1 < command.length ? String(command[i + 1]) : "";
  const rest = command.filter((_, k) => k !== i && k !== i + 1);
  const resuming = rest.some((a) => ["-S", "--session", "-r", "--resume", "-c", "-C", "--continue"].includes(String(a)));
  if (resuming || rest.includes("--agent-file") || rest.includes("--agent")) return { ...noop, command: rest };
  const privDir = fs.mkdtempSync(path.join(dir, "cookbook-bridge-kimi-"));
  try { fs.chmodSync(privDir, 0o700); } catch { /* best effort on platforms without modes */ }
  const file = path.join(privDir, "agent.md");
  fs.writeFileSync(file, kimiAgentFile(spec), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  liveMcpDirs.add(privDir);
  installMcpExitHook();
  const cleanup = () => {
    liveMcpDirs.delete(privDir);
    try { fs.rmSync(privDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { command: [rest[0], "--agent-file", file, ...rest.slice(1)], file, cleanup, tools: kimiTools(spec) };
}

/**
 * Is kimi logged in? Reads what `kimi login` / `/login` write: a [providers.<name>]
 * section in config.toml with an api_key (or a [providers.<name>.env] key, or an
 * oauth sub-table), or an OAuth credential file under credentials/. Never throws.
 */
export function kimiLoginState({ home = process.env.HOME || os.homedir(), env = process.env } = {}) {
  const root = kimiHome({ home, env });
  const configPath = path.join(root, "config.toml");
  let toml = "";
  try { toml = fs.readFileSync(configPath, "utf8"); } catch { /* not installed or never run */ }
  const providers = new Set();
  let section = null; // "providers.<name>" or "providers.<name>.env" / ".oauth"
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^\[+\s*([^\]]+?)\s*\]+$/);
    if (head) {
      const name = head[1].replace(/"/g, "");
      section = name.startsWith("providers.") ? name : null;
      if (section && /^providers\.[^.]+\.oauth$/.test(section)) providers.add(section.split(".")[1]);
      continue;
    }
    if (!section) continue;
    if (/^(api_key|KIMI_API_KEY|MOONSHOT_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY)\s*=\s*"[^"]+"/.test(line)) providers.add(section.split(".")[1]);
  }
  let credentials = 0;
  try { credentials = fs.readdirSync(path.join(root, "credentials")).filter((f) => f.endsWith(".json")).length; } catch { /* none */ }
  return { root, configPath, loggedIn: providers.size > 0 || credentials > 0, providers: [...providers], credentials };
}

/** The Cookbook entry in kimi's user-level mcp.json, judged against this Bridge's URL. */
export function kimiMcpState({ home = process.env.HOME || os.homedir(), env = process.env, cookbookUrl = null } = {}) {
  const file = path.join(kimiHome({ home, env }), "mcp.json");
  let json = null;
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* absent or unparseable */ }
  const srv = json && typeof json === "object" && json.mcpServers && typeof json.mcpServers === "object" ? json.mcpServers.cookbook ?? null : null;
  const url = srv && typeof srv === "object" ? (srv.url ?? srv.serverUrl ?? null) : null;
  const want = cookbookUrl ? `${String(cookbookUrl).replace(/\/$/, "")}/api/mcp` : null;
  const hasAuth = !!(srv && typeof srv === "object" && ((srv.headers && srv.headers.Authorization) || srv.bearerTokenEnvVar));
  return { file, exists: json !== null, server: srv, url, matches: !!url && (!want || url === want), hasAuth };
}
