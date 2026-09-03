/**
 * OpenClaw runner — the visiting agent's lane.
 *
 * Cookbook's own support agent (Chef) runs on OpenClaw, so the Bridge needs to be
 * able to wake one the same way it wakes claude, codex, and agy. This is the
 * smallest possible runner: one turn, one JSON envelope, no persistent server.
 *
 * The CLI contract (docs.openclaw.ai/cli/agent):
 *   openclaw agent --agent <id> --message-file <path> --json [--timeout <secs>]
 * returns, on stdout, an envelope:
 *   { ok, status, final, payloads, usage, model, sessionId }
 * Gateway-backed by default, so sessions PERSIST between calls: passing the
 * previous run's sessionId continues the same conversation, which is what makes a
 * thread a thread. MCP servers configured in openclaw.json are available during the
 * run — that is how Chef reaches Cookbook at all.
 *
 * WHY --message-file AND NOT --message: an injected prompt carries the team's
 * memory and a whole task's instructions. That is far past the argv size a shell
 * will accept, and it would also put the prompt in the process table where every
 * other process on the machine can read it.
 *
 * Node built-ins only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** A hung or chatty child must not grow the Bridge's heap without limit. */
const MAX_STDOUT_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 8_000;
/** Session ids come back from a previous run and are stored server-side, so treat
 *  them as untrusted before they reach an argv slot. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Substitute {promptfile} into the configured argv; build a default if absent.
 *
 * THE CREDENTIAL LIVES IN THE PROFILE, NOT HERE. OpenClaw's MCP servers are global
 * to a config file (`mcp.servers.cookbook` carries one Authorization header) and
 * there is no per-agent MCP flag on the CLI — so an `agents:[{token}]` entry in the
 * Bridge config would be a lie, and worse, one that reads as isolation. What DOES
 * isolate is `--profile <name>`, which points OPENCLAW_CONFIG_PATH and
 * OPENCLAW_STATE_DIR at ~/.openclaw-<name>: a separate config means a separate
 * cookbook server means a separate bearer. That is how a visiting Chef carries a
 * scoped visitor credential while its owner's own OpenClaw keeps their personal one.
 */
export function buildArgv(agent, promptFile, { sessionId = null, timeoutSeconds = 900 } = {}) {
  const base = Array.isArray(agent?.command) && agent.command.length
    ? agent.command.map((a) => String(a).replaceAll("{promptfile}", promptFile))
    : [
        agent?.bin || "openclaw",
        ...(agent?.profile ? ["--profile", String(agent.profile)] : []),
        "agent",
        ...(agent?.openclawAgent ? ["--agent", String(agent.openclawAgent)] : []),
        "--message-file", promptFile,
        "--json",
        "--timeout", String(timeoutSeconds),
      ];
  // Resuming is additive: --session-id is a session SELECTOR, so it takes
  // precedence over --agent's routing and continues the same conversation. The value
  // round-trips through the server (report_task_progress.session_ref), so validate
  // it rather than pass whatever arrives straight into an argv slot.
  if (sessionId && SESSION_ID_RE.test(String(sessionId)) && !base.includes("--session-id")) {
    base.push("--session-id", String(sessionId));
  }
  return base;
}

/** Parse the envelope out of stdout. CLIs print warnings before it, so scan from
 *  the first "{" — the same rule usage.mjs and displayText already live by. */
export function parseEnvelope(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    // A trailing log line after the JSON is common; try the last balanced object.
    const end = text.lastIndexOf("}");
    if (end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* give up */ }
    }
    return null;
  }
}

function spawnOnce(argv, env, timeoutMs, onProgress) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
    } catch (e) {
      resolve({ code: null, out: "", err: String(e.message) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 5000);
    }, timeoutMs);
    let lastBeat = 0;
    child.stdout.on("data", (d) => {
      if (out.length < MAX_STDOUT_CHARS) out += d;
      // The envelope only lands at the end, so there is no token stream to fold — but
      // a heartbeat keeps the board's "working" state honest for long turns. Throttled:
      // one beat per chunk would post hundreds of progress calls for a chatty child.
      if (Date.now() - lastBeat < 2000) return;
      lastBeat = Date.now();
      try { onProgress?.({ input_tokens: 0, output_tokens: 0 }); } catch { /* best-effort */ }
    });
    child.stderr.on("data", (d) => { if (err.length < MAX_STDERR_CHARS) err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, out, err: String(e.message) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/**
 * Run one OpenClaw turn. Returns the same shape spawnAgent does — { code, out,
 * err, sessionId, usage } — so every downstream path (verify, usage, display,
 * thread resume) works unchanged.
 */
export async function runOpenclawTask(agent, prompt, timeoutSeconds, env, onProgress, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookbook-openclaw-"));
  const promptFile = path.join(dir, "prompt.md");
  fs.writeFileSync(promptFile, String(prompt ?? ""), { mode: 0o600 });
  const timeoutMs = Math.max(30, Number(timeoutSeconds) || 900) * 1000;

  try {
    let argv = buildArgv(agent, promptFile, { sessionId: opts.sessionId ?? null, timeoutSeconds });
    let res = await spawnOnce(argv, env, timeoutMs, onProgress);
    let envelope = parseEnvelope(res.out);

    // A stale session id is the one failure worth self-healing: the conversation we
    // wanted to continue is gone, and starting fresh is strictly better than
    // burning the task's retry budget on it.
    if (opts.sessionId && (res.code !== 0 || !envelope)) {
      opts.log?.("  ↳ openclaw couldn't resume that session — starting a fresh one");
      argv = buildArgv(agent, promptFile, { sessionId: null, timeoutSeconds });
      res = await spawnOnce(argv, env, timeoutMs, onProgress);
      envelope = parseEnvelope(res.out);
    }

    return {
      code: res.code,
      // Hand the envelope through verbatim: displayText/extractUsage know it, and a
      // text-mode run (no envelope) still yields raw stdout.
      out: res.out,
      err: res.err,
      sessionId: envelope?.sessionId ?? null,
      usage: envelope?.usage ?? null,
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

/**
 * READINESS, WITHOUT SPENDING A TURN.
 *
 * The doctor refuses to probe a visiting agent, because a probe starts a real turn
 * on its owner's subscription. For a long time that meant it checked NOTHING — and
 * a Chef whose profile had no gateway credentials, no model and no matching agent id
 * was reported as fine right up until the first real question hit it and died with
 * `GatewayCredentialsRequiredError` (2026-08-24). Silence read as health.
 *
 * Everything here is local file inspection: free, instant, and each rule is a
 * failure that actually happened.
 *
 * @returns findings, most severe first: { level: "bad"|"warn"|"ok", message, fix? }
 */
export function inspectOpenclawProfile(agent, { home = os.homedir(), defaultConfig = null } = {}) {
  const out = [];
  const profile = agent?.profile ? String(agent.profile) : null;
  const label = agent?.name || "openclaw agent";

  // An explicit `command` overrides everything buildArgv would have assembled — so a
  // command that forgets --agent silently loses the agent selector and openclaw
  // exits with "No target session selected". Config that contradicts itself is worse
  // than no config, because it looks deliberate.
  if (Array.isArray(agent?.command) && agent.command.length) {
    const cmd = agent.command.map(String);
    if (cmd.includes("agent") && !cmd.includes("--agent") && !cmd.includes("--session-id")) {
      out.push({
        level: "bad",
        message: `${label}: command has no --agent, so openclaw has no session to route to`,
        fix: `drop "command" from this agent and set "openclawAgent": "${agent.openclawAgent || "main"}" — the runner builds the right argv`,
      });
    }
    if (profile && !cmd.includes("--profile")) {
      out.push({
        level: "bad",
        message: `${label}: profile "${profile}" is declared but the command doesn't pass --profile`,
        fix: `the credential isolation comes from --profile; drop "command" and let the runner build it`,
      });
    }
  }

  if (!profile) {
    out.push({
      level: "warn",
      message: `${label}: no profile — it runs on the owner's personal OpenClaw config and credential`,
      fix: `set "profile" so a visiting agent carries its own scoped token`,
    });
    return out;
  }

  const dir = path.join(home, `.openclaw-${profile}`);
  const cfgPath = path.join(dir, "openclaw.json");
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    out.push({
      level: "bad",
      message: `${label}: no OpenClaw profile at ${cfgPath}`,
      fix: `run \`openclaw --profile ${profile} onboard\` once, then re-run doctor`,
    });
    return out;
  }

  // The exact error the first real question hit.
  if (!cfg?.gateway?.auth?.token && !cfg?.gateway?.auth?.password) {
    out.push({
      level: "bad",
      message: `${label}: profile "${profile}" has no gateway credentials — every run fails with GatewayCredentialsRequiredError`,
      fix: `set gateway.auth.{mode:"token",token:<random>} and a gateway.port of its own in ${cfgPath}`,
    });
  } else if (cfg?.gateway?.port && Number(cfg.gateway.port) === Number(defaultConfig?.gateway?.port ?? 18789)) {
    out.push({
      level: "warn",
      message: `${label}: profile "${profile}" shares gateway port ${cfg.gateway.port} with the default profile`,
      fix: `give it its own port so the two gateways can run at once`,
    });
  }

  if (!cfg?.agents?.defaults?.model?.primary) {
    out.push({
      level: "bad",
      message: `${label}: profile "${profile}" has no model configured`,
      fix: `set agents.defaults.model.primary in ${cfgPath}`,
    });
  }

  // The whole point of the profile: a SEPARATE cookbook bearer. If it matches the
  // owner's personal one, the isolation is decorative — the visitor would reach the
  // owner's workspaces with the owner's rights.
  const bearer = cfg?.mcp?.servers?.cookbook?.headers?.Authorization ?? null;
  if (!bearer) {
    out.push({
      level: "bad",
      message: `${label}: profile "${profile}" has no cookbook MCP server — it can't read the workspace it was asked about`,
      fix: `add mcp.servers.cookbook (streamable-http) with this agent's own visitor token`,
    });
  } else {
    let ownerBearer = defaultConfig;
    if (ownerBearer === null) {
      try {
        ownerBearer = JSON.parse(fs.readFileSync(path.join(home, ".openclaw", "openclaw.json"), "utf8"));
      } catch { ownerBearer = undefined; }
    }
    const owners = ownerBearer?.mcp?.servers?.cookbook?.headers?.Authorization;
    if (owners && owners === bearer) {
      out.push({
        level: "bad",
        message: `${label}: profile "${profile}" uses the OWNER'S cookbook token — the isolation is only apparent`,
        fix: `mint a visitor-scope token for ${label} and put it in ${cfgPath}`,
      });
    }
  }

  if (!out.some((f) => f.level === "bad")) {
    out.push({ level: "ok", message: `${label}: profile "${profile}" is configured (gateway, model, own cookbook token)` });
  }
  return out;
}

/**
 * `openclaw --profile X agents list` — local, no model call — so the doctor can say
 * whether the agent id the Bridge will pass actually exists. Passing an unknown
 * --agent is a runtime-only failure otherwise.
 */
export async function listOpenclawAgents(agent, { timeoutMs = 30_000, env = process.env } = {}) {
  const argv = [
    agent?.bin || "openclaw",
    ...(agent?.profile ? ["--profile", String(agent.profile)] : []),
    "agents",
    "list",
  ];
  const r = await spawnOnce(argv, env, timeoutMs, null);
  if (r.code !== 0) return { ok: false, error: String(r.err || r.out).trim().slice(0, 200), ids: [] };
  const ids = [];
  for (const line of String(r.out).split("\n")) {
    const m = /^\s*-\s+([A-Za-z0-9_-]+)/.exec(line);
    if (m) ids.push(m[1]);
  }
  return { ok: true, ids, error: null };
}
