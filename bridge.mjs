#!/usr/bin/env node
/**
 * Cookbook Bridge — wakes your local subscription agents to do their Cookbook
 * tasks, so they run themselves instead of you shuttling between chat windows.
 *
 *   Claude assigns Gemini a task  →  it lands on the Cookbook board (open)
 *   The Bridge (here) polls, sees it, and wakes Gemini headlessly
 *   Gemini — already MCP-connected to Cookbook — does the work and calls
 *     complete_task itself, on YOUR subscription (no API credits)
 *
 * The Bridge is just a *waker*: it never does the work, it triggers the right
 * agent and verifies the task got done. Local, free, distributed (each user
 * runs their own Bridge for their own agents — this is the seed of the shippable
 * "Cookbook Bridge" client).
 *
 * Run:  node bridge/bridge.mjs                 (uses ~/.cookbook/config.json)
 *       node bridge/bridge.mjs ./my.json       (explicit config path)
 *       node bridge/bridge.mjs connect         (one approval connects + runs)
 *       node bridge/bridge.mjs status          (liveness + agent readiness)
 *       node bridge/bridge.mjs doctor          (preflight: check every prerequisite,
 *                                               print the exact fix for each ✗)
 *
 * "login", "status", and "doctor" are reserved first-args; pass a config path to
 * those subcommands with --config <path>. Plain `node bridge.mjs [path]` is unchanged.
 * Config home (0.1.11): explicit path/--config, else COOKBOOK_CONFIG, else
 * ~/.cookbook/config.json; a legacy config next to this file is copied there once.
 * bridge.state.json, local.json and bridge.log sit next to whichever config is used.
 *
 * Node built-ins only. No dependencies.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { callsFromStreamLine, foldCallEvent, wireCalls, shortTool, argFor } from "./live.mjs";
import { planFromStreamLine, notePlan, planLine } from "./plan.mjs";

// Node version guard: below 18 there is no global fetch and none of this runs. One
// plain line beats a stack trace from the first `fetch(` call.
{
  const major = Number(String(process.versions.node).split(".")[0]);
  if (Number.isFinite(major) && major < 18) {
    console.error(`Cookbook Bridge needs Node 18 or newer (you have ${process.versions.node}). Install a current Node from https://nodejs.org and try again.`);
    process.exit(1);
  }
}

// LOCAL modules load LAZILY (loadRuntime below), not statically: a Bridge with a
// missing/corrupt module file must still be able to run `node bridge.mjs update` and
// repair itself — the update path depends ONLY on update.mjs (node built-ins only).
// The e2e that forced this: a stale install missing volunteer.mjs couldn't even reach
// the updater when these were static imports.
import { deriveWakeTopic, wakeSocketSupported, connectWakeSocket } from "./realtime.mjs";
import { createSessionReporter } from "./sessions.mjs";
import { resolveAgentForTask } from "./chef.mjs";
// The config home + command phrasing live in update.mjs (node built-ins only), so the
// broken-install `update` path and every other command agree on both.
import { locateConfig, cli, updateLine, configHome } from "./update.mjs";
let listWorkspaces, listTasks, listOpenWork, getTask, threadResumeContext, completeTaskApi, resolveDelegation, reportTaskUsage, reportTaskProgress, volunteerClaim, dispatchClaim, abandonTask, recallMemories, recallAcrossWorkspaces, creditRecall, getVolunteerSettings, agentsQuery;
let agentEnv, checkGeminiVersion, isGeminiCommand, GEMINI_MIN_VERSION, checkAgyVersion, isAgyCommand, AGY_MIN_VERSION, withCookbookMcp, isClaudeCommand, withApprovalRelay, materializeMcpConfig;
let isKimiCommand, kimiFromLine, kimiResultEnvelope, kimiCommand, kimiLoginState, kimiMcpState, checkKimiVersion;
let extractUsage, displayText;
let volunteeringEnabled, volunteerCandidates, decisionPrompt, parseDecision, MAX_DECISIONS_PER_POLL, mergeVolunteerSettings, effectiveCapabilities;
let buildPrompt, buildThreadFollowUpPrompt;
let runnerFor, hasRunner, warmUp, adoptRunner, reapIdleRunners, killAllRunners;
let hasCodexThread, reapCodexServer, killCodexServer;
let checkForUpdate, applyUpdate;
let createLocalServer, toolsForMode, modeForTools, vendorOf;
let connectAgentsProgrammatic, detectClis;
let serveCalls, describeCall, hostingMode, whichExec, argvForSpawn, redactText, resolveCmdShim, killTree, runPreflight, grantsNeedingPreflight;
let fetchHands, claimHandsCall, reportHandsResult;

async function loadRuntime() {
  ({ createLocalServer, toolsForMode, modeForTools, vendorOf } = await import("./local.mjs"));
  ({ connectAgentsProgrammatic, detectClis } = await import("./device.mjs"));
  ({ listWorkspaces, listTasks, listOpenWork, getTask, threadResumeContext, completeTaskApi, resolveDelegation, reportTaskUsage, reportTaskProgress, volunteerClaim, dispatchClaim, abandonTask, recallMemories, recallAcrossWorkspaces, creditRecall, getVolunteerSettings, fetchHands, claimHandsCall, reportHandsResult, agentsQuery } = await import("./cookbook.mjs"));
  ({ serveCalls, describeCall, hostingMode, which: whichExec, argvForSpawn, redact: redactText, resolveCmdShim, killTree, runPreflight, grantsNeedingPreflight } = await import("./hands.mjs"));
  ({ agentEnv, checkGeminiVersion, isGeminiCommand, GEMINI_MIN_VERSION, checkAgyVersion, isAgyCommand, AGY_MIN_VERSION, withCookbookMcp, isClaudeCommand, withApprovalRelay, materializeMcpConfig,
    isKimiCommand, kimiFromLine, kimiResultEnvelope, kimiCommand, kimiLoginState, kimiMcpState, checkKimiVersion } = await import("./harden.mjs"));
  ({ extractUsage, displayText } = await import("./usage.mjs"));
  ({ volunteeringEnabled, volunteerCandidates, decisionPrompt, parseDecision, MAX_DECISIONS_PER_POLL, mergeVolunteerSettings, effectiveCapabilities } = await import("./volunteer.mjs"));
  ({ buildPrompt, buildThreadFollowUpPrompt } = await import("./prompt.mjs"));
  ({ runnerFor, hasRunner, warmUp, adoptRunner, reapIdleRunners, killAllRunners } = await import("./thread-runner.mjs"));
  ({ hasCodexThread, reapCodexServer, killCodexServer } = await import("./codex-runner.mjs"));
  ({ checkForUpdate, applyUpdate } = await import("./update.mjs"));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  // NEVER let logging kill the Bridge. If stdout is gone (a re-exec that inherited a
  // dying socket, a closed pipe, a parent that exited) console.log THROWS, and a throw
  // in here propagates out of the poll loop's own catch handler — which killed the loop
  // while leaving the process alive and Bridge Local still answering "connected".
  // Diagnosed live 2026-08-24: a wedged Bridge with no fd 1 or 2, 14 minutes silent.
  try {
    console.log(`[${ts}] ${msg}`);
  } catch {
    /* stdout is unusable; a Bridge with no voice must still do its job */
  }
}

/** Secrets never ride out in text this machine produced (hands.mjs redact). */
const scrub = (t) => (redactText ? redactText(t) : t);
/** Kill a child and, on Windows, the tree under it (hands.mjs killTree). */
const killChild = (child, sig = "SIGTERM") => {
  if (killTree) return killTree(child, sig);
  try { child.kill(sig); } catch { /* already gone */ }
};

/**
 * A GUI app (the desktop sidecar) inherits a minimal PATH that misses Homebrew
 * (`/opt/homebrew/bin`), `/usr/local/bin`, nvm, and Claude's local install — so a
 * bare agent command like `claude`/`gemini` fails with ENOENT and the task silently
 * never runs (Codex works only because its config uses an absolute path). Prepend the
 * known install dirs to PATH so spawned agents resolve their binaries regardless of
 * how the Bridge was launched. This is the agent-command analog of the Rust
 * find_node() trap fix (bridge.rs), applied to the binaries the Bridge itself spawns.
 */
function ensureAgentPath() {
  const home = process.env.HOME || os.homedir() || ""; // Windows has no HOME
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  if (home) {
    dirs.push(path.join(home, ".claude/local")); // claude CLI local install
    dirs.push(path.join(home, ".bun/bin"), path.join(home, ".local/bin"));
    dirs.push(path.join(process.env.KIMI_CODE_HOME || path.join(home, ".kimi-code"), "bin")); // kimi's install-script binary
    try {
      const base = path.join(home, ".nvm/versions/node");
      const vers = fs.readdirSync(base).sort();
      if (vers.length) dirs.push(path.join(base, vers[vers.length - 1], "bin"));
    } catch {
      /* no nvm — fine */
    }
  }
  const cur = process.env.PATH || "";
  const have = new Set(cur.split(path.delimiter).filter(Boolean));
  const add = dirs.filter((d) => d && !have.has(d));
  if (add.length) process.env.PATH = [...add, cur].filter(Boolean).join(path.delimiter);
}

/** Resolve a command to an executable path: an absolute/relative path is checked
 *  directly; a bare name is searched on PATH (after ensureAgentPath). Returns null if
 *  not found — used by `doctor` and the default-agent startup warning. */
function resolveBin(cmd) {
  if (!cmd) return null;
  if (/[\\/]/.test(cmd)) { // a path on either platform
    try { fs.accessSync(cmd, fs.constants.X_OK); return cmd; } catch { return null; }
  }
  // hands.which is PATHEXT-aware (claude.cmd on Windows) and knows the home-dir
  // install spots; the scan below is only the pre-loadRuntime fallback.
  if (whichExec) return whichExec(cmd);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

/** Pick a config path from a subcommand's args: `--config <path>`, else first
 *  positional, else the config home (update.mjs locateConfig: COOKBOOK_CONFIG,
 *  ~/.cookbook/config.json, one-time copy of a legacy config next to this file). */
function configPathFromArgs(args, { positional = true } = {}) {
  return locateConfig(args || [], { here: HERE, positional, log: (m) => console.error(m) });
}

/** Where the running Bridge's config lives (Bridge Local writes local.json next to it). */
let CONFIG_PATH = null;

function loadConfig() {
  const p = configPathFromArgs(process.argv.slice(2));
  CONFIG_PATH = p;
  if (!fs.existsSync(p)) {
    console.error(`No config at ${p}.\nEasiest: run \`${cli("connect")}\`: one approval, no token to paste, and the Bridge starts right after.\n(Manual alternative: copy config.example.json to ${p} and add a token from Account > Tokens.)`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  cfg.cookbookUrl = (cfg.cookbookUrl || "").replace(/\/$/, "");
  if (!cfg.cookbookUrl || !cfg.token || cfg.token.startsWith("PASTE")) {
    console.error("Config needs `cookbookUrl` and a real `token` (generate one on your Cookbook account's Tokens page).");
    process.exit(1);
  }
  cfg.pollSeconds = cfg.pollSeconds ?? 15;
  // Persistent per-thread agent processes (terminal-feel replies). Opt-in while it
  // proves itself; the one-shot spawn path remains the fallback either way.
  cfg.persistentThreads = cfg.persistentThreads ?? false;
  // LOCAL WORKSPACE ACCESS (2026-08-21): map a workspace to a folder on THIS machine.
  //   localWorkspaces: { "<workspaceId>": { "cwd": "/abs/path", "allowedTools": "…" } }
  // SELF-ASSIGNED tasks in a mapped workspace run IN that folder with real tools
  // (files/shell) — the same trust as the member running the CLI in their own
  // terminal, because they asked. Teammate-assigned tasks NEVER get local access;
  // they stay jailed to workspace tools. This is the terminal-parity wall.
  cfg.localWorkspaces = cfg.localWorkspaces ?? {};
  // HOSTING (hardware grants, 0069): may a teammate's agent, invited by YOU in the
  // browser, run granted verbs on this machine? Off unless explicitly enabled —
  // `cookbook-bridge host` sets it. A Bridge that never hosts never even asks the
  // server for calls, so this costs nothing when unused.
  cfg.hosting = cfg.hosting ?? {}; // enabled: true=always, false=off, absent=grants you approved (hands.mjs hostingMode)
  cfg.maxAttempts = cfg.maxAttempts ?? 2;
  // Phase 1 semantics: taskTimeoutSeconds is the ABSOLUTE CEILING (cost backstop),
  // livenessTimeoutSeconds is the stall detector (no output for this long = dead).
  // History: 300 killed MCP-heavy runs (2026-07-03); 900 killed healthy founding
  // runs (2026-07-13) — no wall-clock fits both, so silence decides, not duration.
  cfg.taskTimeoutSeconds = cfg.taskTimeoutSeconds ?? 3600;
  cfg.livenessTimeoutSeconds = cfg.livenessTimeoutSeconds ?? 300;
  // Parallel slots: how many task runs may be in flight at once (audit: serial
  // execution let one long run block every workspace's queue).
  cfg.maxConcurrentRuns = Math.max(1, cfg.maxConcurrentRuns ?? 3); // a Lead + its builders + a reviewer need three
  cfg.agents = (cfg.agents ?? []).filter((a) => a.enabled !== false);
  for (const a of cfg.agents) a.cookbookUrl = cfg.cookbookUrl; // for per-run MCP pinning (spawnAgent)
  ensureAgentPath(); // so bare `claude`/`gemini` commands resolve under the app's minimal PATH
  loadRunState(); // restore attempts/given-up so a restart can't grant doomed tasks fresh attempts
  return cfg;
}

/** Which managed agent (if any) handles a task's `assigned_to`. */
/** Tools a LOCAL run gets: the member's own terminal toolkit + Cookbook. */
export const DEFAULT_LOCAL_TOOLS = "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,mcp__cookbook__*";

/** Rewrite a claude-shaped command's --allowedTools for a local-access run. Pure. */
export function localizeCommand(command, allowedTools) {
  if (!Array.isArray(command)) return command;
  const i = command.indexOf("--allowedTools");
  if (i < 0 || i + 1 >= command.length) return command;
  const out = [...command];
  out[i + 1] = allowedTools || DEFAULT_LOCAL_TOOLS;
  return out;
}

function agentFor(cfg, assignedTo) {
  const a = (assignedTo || "").toLowerCase();
  if (a === "any") {
    return cfg.agents.find((x) => x.name === cfg.default) ?? cfg.agents[0] ?? null;
  }
  // Substring match so "Gemini" matches a connection labelled "Gemini CLI MCP Client".
  return cfg.agents.find((x) => (x.match ?? [x.name]).some((m) => a.includes(String(m).toLowerCase()))) ?? null;
}

/**
 * Approval policy: should this agent auto-run a task, given WHO assigned it?
 *  - "anyone" (default): run every task assigned to this agent.
 *  - ["dp","erichaneyatx", …]: only run tasks assigned by these people (matched
 *    on the assigning member, so it's precise even if they used an agent).
 * Anything not allowed is skipped and left open for you.
 */
export function allowedByPolicy(cfg, agent, task) {
  let policy = agent.acceptFrom ?? cfg.acceptFrom ?? "anyone";
  if (typeof policy === "string" && policy !== "anyone") policy = [policy];
  if (policy === "anyone" || !Array.isArray(policy)) return true;
  // EXACT match only (Phase 0, audit #9): substring matching made consent fuzzy —
  // acceptFrom:["Ana"] silently accepted tasks from "Ariana"; ["dp"] matched
  // "dprozzi". A CONSENT decision must never guess. Entries match the assigning
  // member's exact name (case-insensitive) or their profile id.
  const whoName = String(task.assigned_by_member || task.assigned_by || "").trim().toLowerCase();
  const whoId = String(task.assigned_by_profile || "").toLowerCase();
  return policy.some((n) => {
    const entry = String(n).trim().toLowerCase();
    return entry !== "" && (entry === whoName || entry === whoId);
  });
}


/**
 * IDENTITY PINNING for the persistent runner. spawnAgent rewrites a claude command
 * with --strict-mcp-config + the agent's own Cookbook token; the thread runner
 * builds its argv from agent.command directly, so without this an agent with its
 * own token (Chef) ran as whoever the machine's Claude was logged in as — seen
 * 2026-08-28: Chef saw diego's workspaces and "No such grant". Same rewrite, once.
 */
function pinnedAgent(cfg, agent) {
  if (!agent || !Array.isArray(agent.command)) return agent;
  let command = agent.command;
  if (agent.token) command = withCookbookMcp(command, { token: agent.token, cookbookUrl: agent.cookbookUrl ?? cfg.cookbookUrl }).command;
  // Relay wiring never depends on a per-agent token (the old guard skipped BOTH).
  if (agent.approvalRelay && withApprovalRelay) command = withApprovalRelay(command, agent.approvalRelay).command;
  return command === agent.command ? agent : { ...agent, command };
}

/** Spawn the agent's headless CLI with the prompt substituted into its argv.
 *  `env` (from agentEnv) strips vendor API-billing keys unless the user opted in —
 *  a task must never silently bill an API account instead of the owner's subscription. */
/**
 * Detect a one-shot claude agent emitting `--output-format json` and rewrite it to
 * `stream-json` (+ `--verbose`, which claude requires with stream-json). This gives
 * the LIVE token ticker for free — no config change — while the final `result` line
 * stream-json emits last is byte-identical to what json mode returns, so
 * extractUsage/failureHint/displayText keep working unchanged. Returns the (possibly
 * rewritten) command array + whether streaming is active. Anything else (gemini,
 * text mode, already-stream-json, no json flag) is returned untouched.
 */
export function streamingCommand(command) {
  if (!Array.isArray(command)) return { command, streaming: false };
  const i = command.indexOf("--output-format");
  if (i < 0 || command[i + 1] !== "json") return { command, streaming: command.includes("stream-json") };
  const rewritten = [...command];
  rewritten[i + 1] = "stream-json";
  if (!rewritten.includes("--verbose")) rewritten.push("--verbose");
  // Live words stream PER COMPLETED TURN (assistant events), deliberately NOT
  // --include-partial-messages: that flag stores partial-generation artifacts in the
  // session file, and RESUMING such a session trips the API's reasoning-extraction
  // safeguard (observed live 2026-08-20: resumed thread runs refused with
  // `[reasoning_extraction]`). Resume is the flagship; per-turn streaming is plenty.
  return { command: rewritten, streaming: true };
}

/** Pull streamed assistant TEXT out of one stream-json line. Returns
 *  {kind:'delta',text} for a partial chunk (--include-partial-messages),
 *  {kind:'turn',text} for a completed assistant turn (turn text REPLACES the
 *  partial accumulation for that turn — never append both), or null when the
 *  line carries no prose (tool calls, usage ticks, init). */
export function textFromStreamLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (j.type === "stream_event") {
    const d = j.event?.delta;
    return d && d.type === "text_delta" && typeof d.text === "string" ? { kind: "delta", text: d.text } : null;
  }
  if (j.type === "assistant" && Array.isArray(j.message?.content)) {
    const text = j.message.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    return { kind: "turn", text };
  }
  return null;
}

/** Cap for the live-text tail that rides progress reports (server caps at 2000). */
export const LIVE_TEXT_CAP = 1800;

/** Fold one stream-json line into a running progress total (monotonic-ish: output
 *  tokens sum across turns; input/cache take the largest seen). Returns the updated
 *  accumulator, or null when the line carries no usage. Also surfaces the final
 *  `result` line so the caller can hand extractUsage a single clean envelope. */
export function foldStreamLine(line, acc) {
  let j;
  try { j = JSON.parse(line); } catch { return { acc, resultLine: null }; }
  if (j.type === "result") return { acc, resultLine: line };
  const u = (j.message && j.message.usage) || j.usage;
  if (!u || typeof u !== "object") return { acc, resultLine: null };
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    acc: {
      input_tokens: Math.max(acc.input_tokens, n(u.input_tokens)),
      output_tokens: acc.output_tokens + n(u.output_tokens),
      cache_read_input_tokens: Math.max(acc.cache_read_input_tokens, n(u.cache_read_input_tokens)),
      num_turns: acc.num_turns + 1,
    },
    resultLine: null,
  };
}

/**
 * The error a claude result envelope carries, or null when the run produced a real
 * answer. `{"type":"result","subtype":"error_during_execution","is_error":true,
 * "num_turns":0,…,"errors":["No conversation found with session ID: …"]}` is what a
 * failed --resume looks like; the process still exits 0.
 */
export function resultError(out) {
  const raw = String(out ?? "");
  const brace = raw.indexOf("{");
  if (brace < 0) return null;
  let j;
  try { j = JSON.parse(raw.slice(brace)); } catch { return null; }
  if (!j || j.type !== "result") return null;
  const errored = j.is_error === true || /^error/i.test(String(j.subtype ?? ""));
  if (!errored) return null;
  const errs = Array.isArray(j.errors) ? j.errors.filter((e) => typeof e === "string" && e).join("; ") : "";
  return errs || String(j.subtype || "error");
}

/** Pull the CLI's session identity off any stream line (claude stream-json carries
 *  `session_id` on the init message AND the final result). Null when absent. */
export function sessionIdFrom(line) {
  try {
    const j = JSON.parse(line);
    return typeof j.session_id === "string" && j.session_id ? j.session_id : null;
  } catch { return null; }
}

/** LIVENESS over wall-clock (Coordination v2 Phase 1): a run producing output is
 *  healthy at minute 40; a run that's gone silent died at minute 3 — no fixed
 *  wall-clock can tell them apart (300s killed MCP runs, 900s killed founding
 *  runs). Kill on SILENCE (no stdout activity for livenessMs — streaming runs
 *  only; buffered/non-streaming runs emit nothing until the end) and keep a
 *  generous absolute ceiling purely as a cost backstop. Pure for tests. */
export function shouldKill({ streaming, startedAt, lastActivityAt, now, livenessMs, ceilingMs }) {
  if (now - startedAt >= ceilingMs) return { kill: true, why: `hit the ${Math.round(ceilingMs / 60000)}min absolute ceiling` };
  if (streaming && livenessMs > 0 && now - lastActivityAt >= livenessMs) {
    return { kill: true, why: `no output for ${Math.round(livenessMs / 1000)}s (stalled — likely a hung prompt or dead CLI)` };
  }
  return { kill: false, why: "" };
}

/** RESUME-FIRST RETRIES (Phase 1): rewrite a claude one-shot command to resume the
 *  previous attempt's session — the retry CONTINUES the conversation (with the
 *  failure fed back as the next message) instead of re-paying for a blank-context
 *  redo. Claude only; other CLIs fall back to a fresh run with the error fed
 *  forward in the prompt. Pure for tests. */
/**
 * MODEL PER TASK (0079): a crew node can name the model its role runs on; the task
 * carries it and the Bridge applies it here. Claude: `--model <id>` replaces any
 * configured one. Codex runs through the app-server (thread/start.model — see
 * codex-runner). Other CLIs: unchanged (their flags differ; the agent's config wins).
 */
export function withModel(command, model) {
  if (!Array.isArray(command) || !model) return command;
  const base = String(command[0] ?? "").split(/[\\/]/).pop().toLowerCase();
  // Kimi: `-m <alias>` (an alias from ~/.kimi-code/config.toml). Same replace rule.
  const kimi = base === "kimi" || base === "kimi.exe";
  if (base !== "claude" && !kimi) return command;
  const flags = kimi ? ["-m", "--model"] : ["--model"];
  const out = [];
  for (let i = 0; i < command.length; i++) {
    if (flags.includes(command[i])) { i++; continue; }
    if (String(command[i]).startsWith("--model=")) continue;
    out.push(command[i]);
  }
  out.push(kimi ? "-m" : "--model", model);
  return out;
}

export function resumeCommand(command, sessionId) {
  if (!Array.isArray(command) || !sessionId) return { command, resumed: false };
  const base = String(command[0] ?? "").split(/[\\/]/).pop().toLowerCase();
  if (base === "kimi" || base === "kimi.exe") {
    // Kimi resumes with `-S <id>` (the id its session.resume_hint line carried).
    // kimiCommand drops the --allowedTools jail on a resume: the session keeps
    // the agent file it was created with, and kimi refuses --agent-file here.
    if (command.some((a) => a === "-S" || a === "--session" || a === "-r" || a === "--resume")) return { command, resumed: true };
    return { command: [command[0], "-S", sessionId, ...command.slice(1)], resumed: true };
  }
  if (base !== "claude") return { command, resumed: false };
  if (command.includes("--resume")) return { command, resumed: true };
  return { command: [command[0], "--resume", sessionId, ...command.slice(1)], resumed: true };
}

function spawnAgent(agent, prompt, timeoutSeconds, env, onProgress, opts = {}) {
  return new Promise((resolve, reject) => {
    // IDENTITY: a claude run with a per-agent token carries its OWN Cookbook
    // connection (--strict-mcp-config), so it acts as this Bridge's member under the
    // agent's name — never as whatever the CLI is logged in as, and blind to stale
    // claude.ai connectors that poison headless runs (2026-08-25).
    let baseCommand = withCookbookMcp
      ? withCookbookMcp(opts.command ?? agent.command, { token: agent.token, cookbookUrl: agent.cookbookUrl }).command
      : (opts.command ?? agent.command);
    if (agent.approvalRelay && withApprovalRelay) baseCommand = withApprovalRelay(baseCommand, agent.approvalRelay).command;
    const { command, streaming } = onProgress ? streamingCommand(baseCommand) : { command: baseCommand, streaming: false };
    // The bearer token leaves argv here: an inline --mcp-config JSON becomes a 0600
    // temp file (harden.mjs materializeMcpConfig), removed when the run ends.
    const mat = materializeMcpConfig ? materializeMcpConfig(command) : { command, cleanup: () => {} };
    // KIMI JAIL: `--allowedTools X` becomes a per-run agent file (0600) whose tools
    // allowlist is X, because kimi's headless mode approves every tool and has no
    // such flag (harden.mjs kimiCommand). Dropped on a resume, where the session
    // already carries it. Identity for every other CLI.
    const jail = kimiCommand ? kimiCommand(mat.command) : { command: mat.command, cleanup: () => {} };
    const kimi = isKimiCommand ? isKimiCommand(jail.command) : false;
    const cleanupRun = () => { jail.cleanup(); mat.cleanup(); };
    const [cmd, ...rawArgs] = jail.command;
    // PROMPT DELIVERY. claude reads the prompt from stdin when `-p` has no
    // positional prompt (synthesis.mjs relies on the same). That keeps workspace
    // text out of argv: no argument-length ceiling, and on Windows no cmd.exe
    // quoting at all (cmd.exe does not honour \" inside a quoted argument, so a
    // prompt through a .cmd shim could break out and run as a command).
    const claudeShaped = isClaudeCommand ? isClaudeCommand(mat.command) : /(^|[\\/])claude$/i.test(cmd);
    const promptOnStdin = claudeShaped && rawArgs.includes("{prompt}");
    const args = promptOnStdin
      ? rawArgs.filter((a) => a !== "{prompt}")
      : rawArgs.map((a) => a.replaceAll("{prompt}", prompt));
    const promptInArgv = !promptOnStdin && rawArgs.some((a) => a.includes("{prompt}"));
    // A bare name that resolves to a .cmd/.bat shim (npm-installed CLIs on Windows)
    // needs PATHEXT resolution and cmd.exe — argvForSpawn is identity elsewhere.
    const bare = cmd.includes("/") || cmd.includes("\\") ? cmd : (whichExec?.(cmd) ?? cmd);
    let wrapped;
    if (process.platform === "win32" && promptInArgv && /\.(cmd|bat)$/i.test(bare)) {
      // A prompt never goes through cmd.exe: run the shim's own node script directly,
      // or refuse with the fix (hands.mjs resolveCmdShim).
      const script = resolveCmdShim ? resolveCmdShim(bare) : null;
      if (!script) {
        cleanupRun();
        reject(new Error(`refusing to pass a prompt through the ${path.basename(bare)} shell shim on Windows (cmd.exe quoting is not safe for workspace text). Point this agent's command at the CLI's .js entry or its real executable instead.`));
        return;
      }
      wrapped = [process.execPath, script, ...args];
    } else {
      wrapped = argvForSpawn ? argvForSpawn([bare, ...args]) : [bare, ...args];
    }
    let child;
    try {
      child = spawn(wrapped[0], wrapped.slice(1), {
        stdio: [promptOnStdin ? "pipe" : "ignore", "pipe", "pipe"],
        env: env ?? process.env,
        // Local-access runs execute IN the mapped folder (terminal parity).
        ...(agent.cwd ? { cwd: agent.cwd } : {}),
      });
    } catch (e) {
      cleanupRun();
      reject(new Error(`could not launch \`${cmd}\`: ${e.message}`));
      return;
    }
    if (promptOnStdin) {
      child.stdin.on("error", () => { /* EPIPE when the CLI exits first: the close handler reports it */ });
      child.stdin.end(String(prompt));
    }

    let out = "";
    let err = "";
    // Streaming path: line-buffer stdout, fold per-turn usage, throttle-emit progress,
    // and keep ONLY the final result line as `out` so downstream parsers are unchanged.
    let acc = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, num_turns: 0 };
    let resultLine = "";
    let lineBuf = "";
    let lastEmit = 0;
    // Live words (Composer chat feel): finished turns + the current turn's partial
    // deltas. A completed turn REPLACES its partials (same text arrives both ways).
    let turnsText = "";
    let partialText = "";
    // Live CALLS (show the work): tool_use/tool_result folded into a capped list.
    let calls = [];
    // Kimi: the last assistant text is the run's answer (no result line exists);
    // it becomes a claude-shaped envelope on close (harden.mjs kimiResultEnvelope).
    let kimiText = "";
    let kimiTurns = 0;
    const liveText = () => {
      const full = partialText ? `${turnsText}${turnsText ? "\n\n" : ""}${partialText}` : turnsText;
      return full.length > LIVE_TEXT_CAP ? "…" + full.slice(-LIVE_TEXT_CAP) : full;
    };
    const emit = () => {
      const text = liveText();
      // A tick with only calls (a run that reads before it speaks; every kimi run,
      // whose stream carries no token counts) is still worth showing.
      if (!onProgress || (acc.input_tokens === 0 && acc.output_tokens === 0 && !text && !calls.length)) return;
      lastEmit = Date.now();
      // session_ref rides every tick once known: the server-visible resume handle that
      // lets a Composer-thread follow-up continue THIS conversation (0064), surviving
      // Bridge restarts (local retryCtx state is trimmed; the task row isn't).
      // Progress needs a token field to pass the server's substance check, so a
      // text-only tick sends output_tokens as-is (0 is fine once input>0 arrives).
      try { onProgress({ ...acc, runner: agent.name, ...(text ? { live_text: scrub(text) } : {}), ...(calls.length ? { live_calls: wireCalls(calls) } : {}), ...(sessionId ? { session_ref: sessionId } : {}) }); } catch { /* progress is best-effort */ }
    };

    let sessionId = null;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    try { opts.onChild?.(child); } catch { /* registration is best-effort */ }
    child.stdout.on("data", (d) => {
      lastActivityAt = Date.now();
      if (!streaming) { out += d; return; }
      lineBuf += d;
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        if (!sessionId) sessionId = sessionIdFrom(line);
        const spoke = textFromStreamLine(line);
        if (spoke) {
          if (spoke.kind === "delta") partialText += spoke.text;
          else {
            turnsText += (turnsText && spoke.text ? "\n\n" : "") + spoke.text;
            partialText = "";
          }
        }
        // A tool call is a discrete event people are watching for — it jumps the
        // text throttle (still ≥300ms apart so a burst of reads is one tick).
        let touched = false;
        for (const ev of callsFromStreamLine(line)) { calls = foldCallEvent(calls, ev); touched = true; }
        if (kimi) {
          // Kimi's lines are keyed by `role` (claude's by `type`), so the claude
          // parsers above ignore them and this is the only reader.
          const kev = kimiFromLine(line);
          if (kev) {
            if (kev.sessionId && !sessionId) sessionId = kev.sessionId;
            if (kev.text) {
              turnsText += (turnsText ? "\n\n" : "") + kev.text;
              kimiText = kev.text;
              kimiTurns++;
            }
            for (const c of kev.calls) {
              calls = foldCallEvent(calls, c.kind === "call" ? { kind: "call", id: c.id, name: shortTool(c.name), arg: argFor(c.input) } : c);
              touched = true;
            }
            if (kev.retry) log(`  ↳ ${agent.name}: kimi is retrying its API (${kev.retry.attempt}/${kev.retry.max}): ${kev.retry.error}`);
          }
        }
        // The CLI also says where the member's plan stands (claude: rate_limit_event).
        // Remembered per vendor; the next heartbeat carries it (bridge/plan.mjs).
        const plan = planFromStreamLine(line);
        if (plan && notePlan(plan)) log(`  ↳ plan ${planLine(plan.vendor, plan)}`);
        if (plan) notePlanHold(plan); // a closed window holds this vendor until it resets
        const r = foldStreamLine(line, acc);
        acc = r.acc;
        if (r.resultLine) resultLine = r.resultLine;
        else if (Date.now() - lastEmit > (touched ? 300 : (agent.progressThrottleMs ?? 1200))) emit();
      }
    });
    child.stderr.on("data", (d) => { lastActivityAt = Date.now(); err += d; });

    // Liveness watchdog (Phase 1): silence kills fast, healthy work runs long.
    // timeoutSeconds is now the absolute CEILING; livenessSeconds governs stall
    // detection on streaming runs (non-streaming CLIs buffer, so ceiling-only).
    const livenessMs = (opts.livenessSeconds ?? 0) * 1000;
    const ceilingMs = timeoutSeconds * 1000;
    const watchdog = setInterval(() => {
      const verdict = shouldKill({ streaming, startedAt, lastActivityAt, now: Date.now(), livenessMs, ceilingMs });
      if (!verdict.kill) return;
      clearInterval(watchdog);
      killChild(child, "SIGTERM");
      setTimeout(() => killChild(child, "SIGKILL"), 5000);
      const e = new Error(`killed: ${verdict.why}`);
      // Carry the partial streaming counts out with the failure: a timed-out run
      // BURNED real quota, and reporting zero made failed runs invisible to the
      // chain token budget (2026-07-13 finding: 30 min of burns, budget saw 0).
      e.partialUsage = acc.input_tokens || acc.output_tokens ? { ...acc } : null;
      e.elapsedMs = Date.now() - startedAt;
      e.sessionId = sessionId;
      reject(e);
    }, 5000);

    child.on("error", (e) => {
      clearInterval(watchdog);
      cleanupRun();
      reject(new Error(`could not launch \`${cmd}\` (is it installed + on PATH?): ${e.message}`));
    });
    child.on("close", (code) => {
      clearInterval(watchdog);
      cleanupRun();
      // In streaming mode, hand back the final result line (json-mode-identical); fall
      // back to the raw buffer if the run died before emitting one.
      const kimiOut = kimi && streaming
        ? kimiResultEnvelope({ text: kimiText, sessionId, durationMs: Date.now() - startedAt, code, err, numTurns: kimiTurns })
        : null;
      resolve({ code, out: kimiOut ?? (streaming ? (resultLine || lineBuf || out) : out), err, sessionId });
    });
  });
}

/**
 * Run a task on an agent. Two runner shapes:
 *  - default: a one-shot headless CLI (Claude `-p`, Gemini `-p`) via spawnAgent.
 *  - "app-server": a persistent `codex app-server` driven over JSON-RPC, because
 *    Codex's headless `exec` path auto-cancels MCP tool calls (OpenAI #16685).
 *    See bridge/codex-runner.mjs. Either way the agent calls complete_task
 *    itself, so verification (getTask) is identical.
 */
async function runAgent(cfg, agent, prompt, onProgress, retry = null, taskCtx = {}) {
  const { env } = agentEnv(cfg); // billing protection (see harden.mjs)
  const model = taskCtx.task?.model || null;
  if (model) agent = { ...agent, command: withModel(agent.command, model), model };
  if (agent.runner === "app-server") {
    const { runCodexTask } = await import("./codex-runner.mjs");
    // Persistent codex server + thread mapping (v2): threadKey gives follow-ups
    // real conversation continuity; onProgress streams agent-message deltas.
    const threadKey = taskCtx.task ? taskCtx.task.thread_root_id ?? taskCtx.task.id : undefined;
    // Codex reaches Cookbook ONLY through COOKBOOK_CODEX_TOKEN (~/.codex-bridge's
    // mcp server has no login of its own). No per-agent token → fall back to the
    // Bridge token rather than run blind: a Codex that can't read the workspace
    // reviews summaries, not files. connect-agents mints the attributed one.
    const codexToken = agent.token || cfg.codexToken || cfg.token;
    if (!agent.token && !cfg.codexToken && !warnedCodexToken) {
      warnedCodexToken = true;
      log(`! Codex has no agent token, so it runs under your Bridge token. Run \`${cli("connect")}\` so its work reads "Codex · via you".`);
    }
    return runCodexTask(agent, prompt, cfg.taskTimeoutSeconds, codexToken, env, onProgress, { threadKey, log, model });
  }
  if (agent.runner === "openclaw") {
    // The visiting-agent lane: one Gateway-backed turn, resumed by session id so a
    // thread stays a conversation. Its own token (agent.token) is what reaches
    // Cookbook — for Chef that is the scoped VISITOR credential, never the owner's.
    const { runOpenclawTask } = await import("./openclaw-runner.mjs");
    return runOpenclawTask(agent, prompt, cfg.taskTimeoutSeconds, env, onProgress, {
      sessionId: retry?.sessionId ?? taskCtx.sessionRef ?? null,
      log,
    });
  }
  if (agent.runner === "robot") {
    // Embodied runner (sim-first): structured task env, not a prompt — the robot's
    // "brain" is a skill program. Same verify-via-getTask contract as every runner.
    const { runRobotTask } = await import("./robot-runner.mjs");
    return runRobotTask(agent, taskCtx.ws, taskCtx.task, cfg.taskTimeoutSeconds, agent.token || cfg.token, cfg.cookbookUrl, env);
  }
  // liveTokens defaults ON; a user can opt out per-agent or globally.
  const live = cfg.liveTokens !== false && agent.liveTokens !== false;
  // RESUME-FIRST (Phase 1): a retry with a saved claude session CONTINUES that
  // session — the prompt becomes the next message in the conversation, carrying
  // the failure back. Other CLIs get the failure fed forward in a fresh prompt.
  const { command, resumed } = resumeCommand(agent.command, retry?.sessionId ?? null);
  return spawnAgent(agent, prompt, cfg.taskTimeoutSeconds, env, live ? onProgress : undefined, {
    command,
    resumed,
    livenessSeconds: cfg.livenessTimeoutSeconds,
    onChild: taskCtx.onChild,
  });
}

/**
 * Turn a spawn result into a human cause for the "ran but didn't complete" case —
 * the single most confusing failure in the field (the agent CLI exited fine but the
 * task isn't done because it isn't logged in / has no MCP / a tool was blocked). Reads
 * the agent's own exit code + stderr/stdout and names the likely fix. Returns "" when
 * there's nothing useful (e.g. the persistent app-server runner, whose result differs).
 */
/** Human line for a daily-cap hold: "X hit their NN-token daily cap on your subscription". */
function capHoldLine(who, res) {
  const cap = Number(res?.cap);
  const spent = Number(res?.spent);
  const capStr = Number.isFinite(cap) ? cap.toLocaleString() : "the";
  const spentStr = Number.isFinite(spent) ? ` (${spent.toLocaleString()} used today)` : "";
  return `${who} hit their ${capStr}-token daily cap on your subscription${spentStr} — held until it resets (or you raise it in Account → Agents).`;
}

function failureHint(result) {
  if (!result || typeof result !== "object") return "";
  const { code, err, out } = result;
  // JSON-mode envelopes ALWAYS contain the literal substring "permission_denials",
  // so judging on raw output misdiagnosed every failed claude+json run as "a tool
  // was blocked" (live, 2026-07-03). Parse the envelope and judge the REAL fields:
  // the denials array, and the agent's own final text.
  let denials = [];
  let display = "";
  const rawOut = String(out ?? "");
  const brace = rawOut.indexOf("{");
  if (brace >= 0) {
    try {
      const j = JSON.parse(rawOut.slice(brace));
      denials = Array.isArray(j.permission_denials) ? j.permission_denials : [];
      if (typeof j.result === "string") display = j.result;
    } catch { /* not a JSON envelope */ }
  }
  if (denials.length > 0) {
    const names = [...new Set(denials.map((d) => d?.tool_name).filter(Boolean))].slice(0, 3).join(", ");
    return `tool(s) blocked${names ? ` (${names})` : ""} → check \`allowedTools\` matches the agent's MCP server name (CLI-added = mcp__cookbook__*)`;
  }
  // Infrastructure patterns are judged on STDERR only — the model's answer text
  // (`display`) legitimately contains words like "/login" or "MCP server" whenever
  // the TASK is about those things (misdiagnosis class, audit 2026-07-03 #7).
  const infra = String(err || "").toLowerCase();
  const tailSrc = `${err || display || (brace < 0 ? rawOut : "")}`.trim();
  const tail = tailSrc.split("\n").slice(-2).join(" ").slice(0, 240);
  if (infra.includes("not logged in") || infra.includes("please log in"))
    return "the agent CLI isn't logged in → run `claude auth login`";
  // Kimi's own error strings (stderr: "error: failed to run prompt: provider.connection_error: …").
  if (infra.includes("provider.connection_error") || infra.includes("connection error"))
    return "the agent CLI can't reach its API (a network or DNS block on the vendor's hosts) → check the connection, then try `kimi -p hi` by hand";
  if (infra.includes("no provider") || infra.includes("default_model") || infra.includes("no model configured"))
    return "kimi has no provider configured → run `kimi login`";
  if (infra.includes("no mcp") || infra.includes("requires authentication"))
    return `the agent can't reach the Cookbook MCP → run \`${cli("doctor")}\``;
  if (infra.includes("not allowed") || infra.includes("allowedtools"))
    return "a tool was blocked → check `allowedTools` matches the agent's MCP server name (CLI-added = mcp__cookbook__*)";
  if (typeof code === "number" && code !== 0) return `agent exited ${code}${tail ? `: ${tail}` : ""}`;
  if (tail) return `agent said: ${tail}`;
  return "";
}

// ── PLAN HOLDS (rate limits) ─────────────────────────────────────────────────
// claude's stream says when the member's plan window is exhausted
// (rate_limit_event with utilization >= 1 and the reset time; bridge/plan.mjs).
// Retrying into a closed window burns every attempt for nothing and abandons the
// task by the time the window opens. Instead: hold that vendor until the reset,
// and do not count the attempt that discovered it. Pure helpers; tested.
const planHolds = new Map(); // vendor -> { until (ms), at (ms), noted }
export const PLAN_HOLD_DEFAULT_MS = 15 * 60_000;
export const PLAN_HOLD_MAX_MS = 8 * 3600_000;
export function notePlanHold(obs, now = Date.now()) {
  if (!obs || !obs.vendor) return null;
  const closed = [obs.five_hour, obs.seven_day].filter((w) => w && typeof w.u === "number" && w.u >= 1);
  if (!closed.length) return null;
  const resets = closed.map((w) => (typeof w.r === "number" ? w.r * 1000 : 0)).filter((r) => r > now);
  const until = Math.min(resets.length ? Math.min(...resets) : now + PLAN_HOLD_DEFAULT_MS, now + PLAN_HOLD_MAX_MS);
  const prev = planHolds.get(obs.vendor);
  const entry = { until, at: now, noted: !!(prev && prev.noted && prev.until === until) };
  planHolds.set(obs.vendor, entry);
  return entry;
}
/** The active hold for a vendor, or null (expired holds are dropped). */
export function planHoldFor(vendor, now = Date.now()) {
  const h = planHolds.get(vendor);
  if (!h) return null;
  if (h.until <= now) { planHolds.delete(vendor); return null; }
  return h;
}
/** For tests. */
export function resetPlanHolds() { planHolds.clear(); }
const agentVendor = (agent) => (vendorOf ? vendorOf(agent) : "other");
/** Is this agent's plan window closed right now? Logs once per hold. */
function agentHeld(agent) {
  const h = planHoldFor(agentVendor(agent));
  if (!h) return false;
  if (!h.noted) {
    h.noted = true;
    log(`⏸ ${agent.name}: plan limit reached. Holding its tasks until ${new Date(h.until).toLocaleTimeString()} instead of retrying into the wall.`);
  }
  return true;
}

// ── run-state persistence ────────────────────────────────────────────────────
// attempts/givenUp were in-memory only, so EVERY restart (crash, self-update
// re-exec, manual bounce) reset the counters — and the Bridge resumes its own
// claimed tasks, so a restart granted every stuck task a fresh pair of attempts
// (2026-07-13: a doomed goal would have re-burned 6x900s across restarts).
// Persisted next to the config (the config home); trimmed so it can't grow unbounded.
// A pre-0.1.11 state file next to bridge.mjs is read once when the new one is absent.
function statePath() {
  return path.join(path.dirname(CONFIG_PATH || path.join(HERE, "config.json")), "bridge.state.json");
}
function loadRunState() {
  try {
    const p = statePath();
    const legacy = path.join(HERE, "bridge.state.json");
    const src = fs.existsSync(p) ? p : legacy;
    const raw = JSON.parse(fs.readFileSync(src, "utf8"));
    for (const [id, n] of Object.entries(raw.attempts ?? {})) attempts.set(id, Number(n) || 0);
    for (const id of raw.givenUp ?? []) givenUp.add(id);
    for (const [id, ctx] of Object.entries(raw.retryCtx ?? {})) retryCtx.set(id, ctx);
    for (const id of raw.preflighted ?? []) if (typeof id === "string") preflighted.add(id);
  } catch { /* first run / unreadable — start clean */ }
}
function saveRunState() {
  try {
    // Trim: these only matter for live tasks; cap so years of ids can't accumulate.
    const attEntries = [...attempts.entries()].slice(-500);
    const given = [...givenUp].slice(-500);
    const retries = [...retryCtx.entries()].slice(-200);
    const flown = [...preflighted].slice(-500);
    fs.writeFileSync(statePath(), JSON.stringify({ attempts: Object.fromEntries(attEntries), givenUp: given, retryCtx: Object.fromEntries(retries), preflighted: flown }));
  } catch { /* best-effort — never let state persistence break a run */ }
}

const attempts = new Map(); // taskId -> count
// Grants this host has already pre-flighted (hands section). Persisted: a restart
// must not post a second pre-flight for a grant the visitor already read.
const preflighted = new Set();
// Retry context (Phase 1): what the LAST failed attempt knew — the claude session
// to resume and the failure to feed back — so a retry continues instead of redoing.
const retryCtx = new Map(); // taskId -> { sessionId, reason }
// Volunteered runs that failed with attempts left: the task is already CLAIMED (by
// this Bridge's volunteer pre-claim), so the open-task scan can't re-find it — it
// retries from this shelf instead. In-memory: a restart still strands the claim
// (visible on the board, cancel by hand) — deliberate v1 legibility over churn.
const volunteeredRetries = [];
let warnedCodexToken = false;
const BOOT_MS = Date.now();
const inFlight = new Set();
const inFlightWs = new Map(); // task id → workspace id, for release on shutdown

/**
 * GRACEFUL STOP (2026-08-29): hand every in-flight task back to the board before
 * dying (release_task: open, claim cleared, progress kept). Without this an update,
 * a sleep, or a restart strands the run as `claimed` for an hour. Budgeted —
 * launchd gives us seconds, not minutes.
 */
let releasing = null;
async function releaseInFlight(cfg, why) {
  if (releasing) return releasing;
  const ids = [...inFlight];
  if (!ids.length) return Promise.resolve();
  log(`⏏ ${why}: releasing ${ids.length} in-flight task(s) back to the board`);
  releasing = Promise.race([
    Promise.allSettled(ids.map(async (id) => {
      try {
        const { callTool } = await import("./cookbook.mjs");
        await callTool(cfg, "release_task", { workspace_id: inFlightWs.get(id), task_id: id });
        log(`  ↳ released ${id.slice(0, 8)}`);
      } catch (e) { log(`  ↳ couldn't release ${id.slice(0, 8)}: ${e.message}`); }
    })),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  return releasing;
}
/** Ctrl-C and SIGTERM take the same road: release in-flight tasks (a no-op with
 *  nothing in flight), stop the runners, exit. Installed once; a second signal
 *  while releasing exits at once. Before this the first SIGINT handler exited
 *  immediately, so a Ctrl-C stranded every running task as `claimed` for an hour
 *  while a SIGTERM released them. */
let shutdownInstalled = false;
function installShutdown(cfg) {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  let exiting = false;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      stopped = true;
      if (exiting) { process.exit(0); return; }
      exiting = true;
      log(`Stopping (${sig})…`);
      releaseInFlight(cfg, sig).finally(() => {
        try { if (cfg.persistentThreads) { killAllRunners?.(); killCodexServer?.(); } } catch { /* exiting */ }
        process.exit(0);
      });
    });
  }
}
// STOP (the Room, 2026-08-29): task id → a function that kills its run. Filled while
// a run is in flight; the push channel's `stops` list calls it. A stopped task is
// remembered so the failure path doesn't shelve it for retry.
const killers = new Map();
const stoppedRuns = new Set();
function stopRuns(ids) {
  for (const id of ids ?? []) {
    const kill = killers.get(id);
    if (!kill) continue;
    stoppedRuns.add(id);
    try { kill(); } catch { /* already gone */ }
    killers.delete(id);
    log(`⏹ stopped "${id.slice(0, 8)}" — cancelled in Cookbook`);
  }
}

// HOT MODE: while a conversation is active, the poll loop runs at 1s AND scopes
// its sweep to the hot workspace(s) so replies dispatch near-instantly; markHot()
// stamps activity per workspace, the window decays on its own.
const HOT_WINDOW_MS = 180_000;
let lastHotAt = 0;
const hotWorkspaces = new Map(); // wsId -> last activity ts
/** Bridge Local (local.mjs) — the loopback control API; null until main() starts it. */
let localServer = null;
let lastRunError = null;
/** Whether the Cookbook token has ever verified this run (gates /status.connected and
 *  keeps a token-rejected desktop Bridge alive instead of exiting). */
let tokenOk = false;
/** When this Bridge last actually REACHED Cookbook. `tokenOk` only records that the
 *  token verified once, at startup — so a Bridge whose poll loop has died still
 *  reported "connected" forever (diagnosed live 2026-08-24: 14 minutes mute, process
 *  alive, Bridge Local cheerfully green). Liveness has to be a timestamp, not a flag. */
let lastContactAt = 0;
/** The desktop app sets COOKBOOK_DESKTOP=1 when it spawns the Bridge. Only then do we
 *  stay alive on a revoked token (so the user can fix it from the app's Connect UI). A
 *  headless/terminal Bridge still exits loudly with the fix — never a silent zombie. */
const IS_DESKTOP = process.env.COOKBOOK_DESKTOP === "1";

/** Run lifecycle → Bridge Local subscribers (the desktop app's notifications). */
function emitRun(state, ws, task, agent, localMeta) {
  if (!localServer) return;
  try {
    localServer.emit("run", {
      state,
      workspaceId: ws?.id ?? null,
      workspaceName: ws?.name ?? null,
      taskId: task?.id ?? null,
      title: task?.title ?? null,
      agent: agent?.name ?? null,
      ...(localMeta ? { cwd: localMeta.local_cwd, mode: localMeta.local_mode } : {}),
      at: new Date().toISOString(),
    });
  } catch { /* notifications are best-effort */ }
}

/** Re-read config.json into the live cfg (token, agents, folders) without a restart.
 *  Used after connect-agents (the login refreshed the Bridge token) and by tools
 *  that edit the file while the Bridge runs. Version gates ran at startup only. */
function applyConfigFromDisk(cfg) {
  if (!CONFIG_PATH) return;
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (raw.token && !String(raw.token).startsWith("PASTE")) cfg.token = raw.token;
  if (raw.cookbookUrl) cfg.cookbookUrl = String(raw.cookbookUrl).replace(/\/$/, "");
  cfg.default = raw.default;
  cfg.localWorkspaces = raw.localWorkspaces ?? {};
  cfg.hosting = raw.hosting ?? {};
  const agents = (raw.agents ?? []).filter((a) => a.enabled !== false);
  for (const a of agents) a.cookbookUrl = cfg.cookbookUrl;
  cfg.agents.splice(0, cfg.agents.length, ...agents);
  // A reload usually follows connect-agents fixing the token — let the next poll
  // re-verify from scratch instead of staying stuck in the rejected state.
  consecutive401s = 0;
  log(`↻ config reloaded — agents: ${agents.map((a) => a.name).join(", ") || "(none)"}`);
  try { door.refresh?.(); } catch { /* the failsafe pull still runs */ }
}

/** Re-exec this Bridge on the same argv (the self-update restart path). */
function reexecSelf() {
  log("↻ restarting…");
  // NEVER inherit stdio here. This is called from Bridge Local's POST /restart — i.e.
  // from inside an HTTP request handler — so "inherit" hands the child the dying
  // response socket as its stdout. Once that socket closes the child has no fd 1 or 2,
  // every log() throws, and the poll loop dies while the process stays alive and
  // Bridge Local keeps reporting "connected". That is the desktop app's Restart button
  // silently wedging the Bridge, and it is exactly the failure that looks like health.
  // Diagnosed live 2026-08-24 on a Bridge that had been mute for 14 minutes.
  //
  // Append to the log file instead, so a restarted Bridge keeps a voice.
  let out = "ignore";
  let err = "ignore";
  try {
    const logPath = path.join(path.dirname(CONFIG_PATH || HERE), "bridge.log");
    const fd = fs.openSync(logPath, "a");
    out = fd;
    err = fd;
  } catch {
    /* no writable log — silence beats a wedged child */
  }
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();
  process.exit(0);
}

/** Configured agents + CLIs found on this machine, for Bridge Local's /status. */
function detectAgentsForStatus(cfg) {
  const rows = cfg.agents.map((a) => {
    const cmd = Array.isArray(a.command) ? a.command[0] : null;
    const binary = resolveBin(cmd);
    const vendor = isKimiCommand && isKimiCommand(a.command) ? "kimi" : (vendorOf ? vendorOf(a) : "other");
    return { name: a.name, vendor, binary, found: !!binary, enabled: true, runner: a.runner ?? "cli", configured: true };
  });
  try {
    for (const cli of detectClis ? detectClis() : []) {
      if (rows.some((r) => r.vendor === cli.vendor)) continue;
      rows.push({ name: cli.agent, vendor: cli.vendor, binary: cli.path, found: true, enabled: false, runner: cli.kind === "codex" ? "app-server" : "cli", configured: false });
    }
  } catch { /* detection is best-effort */ }
  return rows;
}

function markHot(wsId) {
  lastHotAt = Date.now();
  if (wsId) hotWorkspaces.set(wsId, lastHotAt);
}
function hotWorkspaceIds() {
  const now = Date.now();
  const ids = new Set();
  for (const [id, ts] of hotWorkspaces) {
    if (now - ts < HOT_WINDOW_MS) ids.add(id);
    else hotWorkspaces.delete(id);
  }
  return ids;
}
const givenUp = new Set();
const skippedLogged = new Set(); // tasks we've already logged as policy-skipped

// Volunteer decisions we've already made, so a PASS isn't re-asked every poll and a
// VOLUNTEER isn't re-burned after an approval round-trip. Key: `${taskId}:${agentName}`.
const volunteerDecisions = new Map();

/**
 * The volunteer path for one open GOAL task (stigmergy v1 — bridge/volunteer.mjs holds
 * the pure logic; this is the I/O). For each opted-in agent, in config order:
 * ask its OWN model the one-word capability question → on VOLUNTEER, run the same
 * delegation-policy gate as any dispatched task (allow / ask-parks-in-inbox / off) →
 * claim ATOMICALLY with claimed_via='volunteered' (two Bridges race in the DB; the
 * loser just moves on). Returns {ws, task, agent} for the run queue on a won claim.
 *
 * v1 honesty: a volunteered task is claimed BEFORE running, so a failed run leaves it
 * visibly claimed on the board (cancel/reassign by hand) rather than silently retried —
 * deliberate: legible failure over invisible churn while the feature earns trust.
 */
// The owner's UI settings (Account → Agent delegation → Volunteering), cached one
// minute so a busy board doesn't hammer the server. CONSENT FAILS CLOSED-ish: a
// transient fetch failure reuses the last SUCCESSFUL value (a UI "off" must not be
// overridden by local config during a server hiccup); only a server that genuinely
// lacks the tool yields null = "config decides". Also where the Bridge learns its
// own profile id (for member-scoped goal candidacy).
let volSettingsCache = { at: 0, value: null, everSucceeded: false };
let myProfileId = null;
async function cachedVolunteerSettings(cfg) {
  if (Date.now() - volSettingsCache.at > 60_000) {
    const r = await getVolunteerSettings(cfg);
    if (r.ok) {
      volSettingsCache = { at: Date.now(), value: r.value, everSucceeded: true };
      if (r.value?.profile_id) myProfileId = r.value.profile_id;
      warnIfTokenExpiring(r.value?.token_expires_at);
    } else {
      volSettingsCache.at = Date.now(); // don't hammer; keep the last-good value
    }
  }
  return volSettingsCache.value;
}

async function considerVolunteering(cfg, ws, task, budget) {
  const merged = mergeVolunteerSettings(cfg, await cachedVolunteerSettings(cfg));
  const enabled = cfg.agents.filter((a) => volunteeringEnabled(cfg, a, merged));
  if (enabled.length === 0) return null;
  const candidates = volunteerCandidates([task], {
    profileId: myProfileId ?? undefined,
    inFlight, givenUp, attempts, maxAttempts: cfg.maxAttempts,
    decided: { get: (id) => (enabled.every((a) => volunteerDecisions.get(`${id}:${a.name}`) === "PASS") ? "PASS" : undefined) },
  });
  if (candidates.length === 0) return null;

  for (const agent of enabled) {
    const key = `${task.id}:${agent.name}`;
    let decision = volunteerDecisions.get(key);
    if (decision === "PASS") continue;
    if (!decision) {
      if (budget.used >= MAX_DECISIONS_PER_POLL) return null; // next poll considers the rest
      budget.used++;
      let answered = true;
      try {
        const r = await spawnAgent(agent, decisionPrompt(task, effectiveCapabilities(agent, merged) ?? agent.capabilities), cfg.decisionTimeoutSeconds ?? 90, agentEnv(cfg).env);
        decision = parseDecision(displayText(r.out));
      } catch {
        // Conservative THIS poll — but a timeout/hiccup is not the model's answer,
        // so don't cache it: caching made one cold-start permanently mute a capable
        // agent (audit 2026-07-03 #4). The next poll re-asks.
        decision = "PASS";
        answered = false;
      }
      if (answered) volunteerDecisions.set(key, decision);
      log(`${decision === "VOLUNTEER" ? "🙋" : "🤔"} ${agent.name} ${decision === "VOLUNTEER" ? "volunteers for" : "passed on"} goal "${task.title}"`);
      if (decision === "PASS") continue;
    }

    // Same consent gate as a dispatched task: the OWNER's delegation policy decides.
    // FAILS CLOSED: an unreachable policy check skips this poll (resolveDelegation
    // itself returns "run" only for genuinely-older servers without the tool).
    let policy;
    try {
      policy = await resolveDelegation(cfg, task.id);
    } catch {
      log(`! couldn't check delegation policy for "${task.title}" — skipping this poll (will retry)`);
      return null;
    }
    if (policy.decision === "pending") {
      if (!skippedLogged.has("volpend:" + task.id)) {
        skippedLogged.add("volpend:" + task.id);
        log(`⏳ volunteer claim for "${task.title}" is waiting for your approval → /account/agents`);
      }
      return null; // decision is cached; after approval the next poll claims + runs
    }
    if (policy.decision === "skip") {
      // A daily-cap hold is temporary (resets/raises) — don't cache PASS, just wait.
      if (policy.reason === "daily_cap") {
        if (!skippedLogged.has("volcap:" + task.id)) {
          skippedLogged.add("volcap:" + task.id);
          log(`⛔ ${capHoldLine(task.assigned_by_member || task.assigned_by, policy)}`);
        }
        return null;
      }
      volunteerDecisions.set(key, "PASS"); // policy said no — stop asking
      continue;
    }

    // The atomic claim IS the cross-Bridge race.
    try {
      await volunteerClaim(cfg, ws.id, task.id);
    } catch (e) {
      log(`… lost the volunteer race for "${task.title}" (${e.message.slice(0, 80)})`);
      return null; // someone else has it; it's no longer open next poll
    }
    // Stamp locally: the queued object predates the claim (listTasks ran before it), and
    // the run prompt tells a volunteered agent it owns the judgment calls.
    return { ws, task: { ...task, claimed_via: "volunteered" }, agent };
  }
  return null;
}

async function processTask(cfg, ws, task, agent) {
  inFlight.add(task.id);
  inFlightWs.set(task.id, ws.id);
  // PRE-CLAIM (Phase 0, audit #1): a dispatched task must be OURS before we spend
  // quota on it. Without this, a to:'any' task — or the same member's Bridge on a
  // second machine — ran N times and the losers found out at the 409 after paying
  // for the whole run. The volunteer path already pre-claimed; this makes dispatch
  // identical. Losing the claim is a normal outcome, not an error.
  if (task.status === "open") {
    const claimed = await dispatchClaim(cfg, ws.id, task.id);
    if (!claimed) {
      inFlight.delete(task.id);
      return; // another Bridge won the race — their run, their receipt
    }
    task = { ...task, ...claimed };
  }
  // ANCESTOR CHECK (Phase 0, audit #6): if this task rides a chain whose root was
  // cancelled, don't burn an attempt on work the human already stopped. Server-side
  // cascade cancels open/claimed children; this catches the in-flight-retry window.
  if (task.chain_id && task.chain_id !== task.id) {
    const root = await getTask(cfg, ws.id, task.chain_id).catch(() => null);
    if (root && root.status === "cancelled") {
      inFlight.delete(task.id);
      givenUp.add(task.id);
      saveRunState();
      await abandonTask(cfg, ws.id, task.id, "parent chain was cancelled");
      log(`⨯ skipping "${task.title}" — its chain was cancelled`);
      return;
    }
  }
  markHot(ws.id); // a live conversation — poll this workspace fast until it quiets
  attempts.set(task.id, (attempts.get(task.id) ?? 0) + 1);
  saveRunState();
  const n = attempts.get(task.id);
  log(`→ waking ${agent.name} for "${task.title}" in ${ws.name} (attempt ${n}/${cfg.maxAttempts})`);
  let resume = null; // hoisted: the catch path needs to know if the run RESUMED a session
  // PLAN HOLD: a run that discovered a closed plan window (rate_limit_event) is not
  // a failed attempt. Give the attempt back, shelve the task, and let agentHeld()
  // keep it off the dispatch lanes until the window resets.
  const runStartedAt = Date.now();
  const holdDuringRun = () => { const h = planHoldFor(agentVendor(agent)); return !!h && h.at >= runStartedAt; };
  const shelveForHold = (reason, sessionId) => {
    attempts.set(task.id, Math.max(0, (attempts.get(task.id) ?? 1) - 1));
    retryCtx.set(task.id, { sessionId: sessionId ?? retryCtx.get(task.id)?.sessionId ?? null, reason: reason || "plan limit reached" });
    saveRunState();
    volunteeredRetries.push({ ws, task, agent });
    const h = planHoldFor(agentVendor(agent));
    log(`⏸ ${agent.name} hit its plan limit on "${task.title}". Not counting this attempt; it resumes after ${h ? new Date(h.until).toLocaleTimeString() : "the window resets"}.`);
  };
  try {
    // Recall-injection: the team's relevant memory rides into the prompt (best-effort;
    // [] on any failure — memory must never block a run). Query = the task title.
    // Composer follow-ups (0064) skip recall entirely: a resumed session already
    // carries what rode into the original run, and crediting notes that never rode
    // into THIS prompt would corrupt the outcome-weighted signal.
    const { memories, conventions } = task.thread_root_id
      ? { memories: [], conventions: [] }
      : await recallMemories(cfg, ws.id, task.title);
    // Credit both classes on verified completion — conventions earn helpful_count too
    // (the outcome signal that ranks proven rules first).
    const recalledIds = [...memories, ...conventions].map((m) => m && m.id).filter(Boolean);
    if (memories.length) log(`  ↳ injecting ${memories.length} team-memory note${memories.length === 1 ? "" : "s"}`);
    if (conventions.length) log(`  ↳ + ${conventions.length} team convention${conventions.length === 1 ? "" : "s"} (verbatim)`);
    // Proactive cross-workspace recall: proven knowledge from the member's OTHER projects
    // (a playbook, a gotcha) surfaces here without being pointed at it. Best-effort.
    const crossWorkspace = task.thread_root_id ? [] : await recallAcrossWorkspaces(cfg, task.title, ws.id, 3);
    if (crossWorkspace.length) log(`  ↳ + ${crossWorkspace.length} proven note${crossWorkspace.length === 1 ? "" : "s"} from your other projects`);
    const startedAt = Date.now();
    // Live ticker: stream in-flight token counts to the board so the assigner watches
    // the cost accrue. Fire-and-forget + swallow errors — a progress hiccup must never
    // touch the run. (report_task_progress is a no-op once the task leaves 'claimed'.)
    let lastProgressPost = 0;
    let localMeta = null; // { local_cwd, local_mode } once local access is decided below
    const onProgress = (p) => {
      if (Date.now() - lastProgressPost < 1000) return;
      lastProgressPost = Date.now();
      reportTaskProgress(cfg, ws.id, task.id, localMeta ? { ...p, ...localMeta } : p).catch(() => {});
    };
    // Retry attempts CONTINUE, not redo (Phase 1): with a saved claude session the
    // prompt is just the next message in the resumed conversation; without one, the
    // fresh prompt carries the failure + a don't-redo-finished-work instruction.
    const retry = n > 1 ? retryCtx.get(task.id) ?? null : null;
    // COMPOSER THREAD (0064): a follow-up run continues the thread's conversation.
    // The freshest session_ref across the thread (server-side, survives restarts) is
    // the resume handle; resume only works for claude commands (resumeCommand no-ops
    // otherwise), so the cold-baton prompt is ALWAYS the fallback shape. A retry of
    // this very task (retryCtx) outranks the thread handle — it's strictly newer.
    // LOCAL ACCESS (terminal parity): a SELF-assigned task in a locally-mapped
    // workspace runs IN the mapped folder with real tools. Teammate-assigned
    // tasks never qualify (assigner ≠ claimer). The agent object is shadowed so
    // every runner path downstream inherits cwd + widened tools consistently.
    const localMap = cfg.localWorkspaces[ws.id];
    const selfAssigned = task.assigned_by_profile && task.claimed_by_profile && task.assigned_by_profile === task.claimed_by_profile;
    let local = localMap && selfAssigned && localMap.cwd ? localMap : null;
    // ASK MODE is CLAUDE-ONLY (audit 2026-09-01, HIGH): the gate rides
    // --permission-prompt-tool + --allowedTools, which only claude-shaped
    // commands honor — codex's app-server ignores allowedTools entirely and
    // stock gemini has no flag to rewrite, so for any other agent an "ask"
    // folder would run UNGATED. Refuse folder access for them instead.
    if (local && (local.mode ?? modeForTools?.(local.allowedTools)) === "ask"
        && !(isClaudeCommand?.(agent.command) && agent.runner !== "app-server" && agent.runner !== "openclaw" && agent.runner !== "robot")) {
      log(`  ↳ ask mode supports Claude agents only for now — ${agent.name} runs WITHOUT folder access`);
      local = null;
    }
    if (local) {
      let mode = local.mode ?? modeForTools?.(local.allowedTools) ?? "run";
      let localTools = local.allowedTools;
      // ASK MODE (0086, the drive layer): reads run freely, everything else asks
      // for a click in Cookbook. Needs the machine's opt-in (cfg.drive) — without
      // it the folder safely downgrades to read-only rather than running wide.
      if (mode === "ask") {
        localTools = toolsForMode("ask");
        if (cfg.drive === true) {
          agent = { ...agent,
            // The relay pins --strict-mcp-config; without a token the Cookbook
            // server would be STRIPPED from the run (audit F3). The Bridge token
            // is the same member, so identity stays correct.
            token: agent.token ?? cfg.token,
            approvalRelay: {
            serverPath: path.join(HERE, "approve-mcp.mjs"),
            env: { CBK_URL: cfg.cookbookUrl, CBK_TOKEN: agent.token ?? cfg.token, CBK_WORKSPACE: ws.id, CBK_TASK: task.id, CBK_FOLDER: local.cwd, CBK_AGENT: agent.name },
          } };
          log(`  ↳ ask mode: reads run free; Bash/Write/Edit will wait for your click in Cookbook`);
        } else {
          log(`  ↳ ask mode requested but "drive" is off in config — running read-only`);
        }
      }
      agent = { ...agent, command: localizeCommand(agent.command, localTools), cwd: local.cwd };
      localMeta = { local_cwd: local.cwd, local_mode: mode };
      log(`  ↳ local access: running in ${local.cwd} (${mode}) with real tools (self-assigned)`);
      // Tell the thread right away where this run lives (the receipt shows it).
      reportTaskProgress(cfg, ws.id, task.id, { stage: `local: ${local.cwd}`, ...localMeta }).catch(() => {});
    }
    emitRun("started", ws, task, agent, localMeta);
    // PERSISTENT RUNNER (terminal feel, opt-in): a live process for this thread means
    // the conversation is already in memory — the prompt is just the next message,
    // and the server-side session lookup (a full list_tasks) is skippable.
    // Key includes the AGENT (vendor-switch safety) and the LOCAL flag — a jailed
    // warm process must never serve a local turn, nor vice versa.
    const threadKey = `${task.thread_root_id ?? task.id}::${agent.name}${local ? "::local" : ""}`;
    // Ask-mode runs (0086) take the ONE-SHOT path: the persistent runner's
    // stream-json input mode denies non-allowlisted tools without consulting
    // --permission-prompt-tool (verified 2026-08-31: instant DENIED, no relay
    // call), while plain -p asks the relay correctly. Correctness over warmth.
    const runnerEligible = cfg.persistentThreads && !retry && agent.runner !== "app-server" && agent.runner !== "robot" && !agent.approvalRelay;
    let warmRunner = runnerEligible ? hasRunner(threadKey) : null;
    // ADOPT a pre-warmed runner (0065) for a NEW conversation: the process booted
    // while the member was still typing, so their first words hit a live agent.
    if (!warmRunner && runnerEligible && !task.thread_root_id && !local) {
      // (Local runs never adopt from the warm pool — pooled processes are jailed
      // to workspace tools and the wrong cwd.)
      warmRunner = adoptRunner(`warm::${ws.id}::${agent.name}`, threadKey);
      if (warmRunner) log(`  ↳ adopted a pre-warmed ${agent.name} — first message hits a live process`);
    }
    let thread = null;
    if (task.thread_root_id && !warmRunner) {
      thread = await threadResumeContext(cfg, ws.id, task.thread_root_id, myProfileId).catch(() => null);
      if (thread?.root?.status === "cancelled") {
        inFlight.delete(task.id);
        givenUp.add(task.id);
        saveRunState();
        await abandonTask(cfg, ws.id, task.id, "thread was cancelled");
        log(`⨯ skipping "${task.title}" — its thread was cancelled`);
        return;
      }
    }
    // A RETRY never thread-resumes (retryCtx null-session means the resumed session
    // itself failed — go cold on the baton; thread.root still feeds it context).
    const threadSession = !retry ? thread?.sessionRef ?? null : null;
    const canResumeThread = threadSession && resumeCommand(agent.command, threadSession).resumed;
    // Codex keeps its own conversation map (persistent app-server threads).
    const codexWarm = agent.runner === "app-server" && hasCodexThread(task.thread_root_id ?? task.id);
    const conversationWarm = !!warmRunner || !!canResumeThread || codexWarm;
    // CHAT LANE (bridgeFiles): the agent's final message IS the result and the
    // Bridge files it — saves a whole model round-trip (the complete_task tool
    // call) plus the verify fetch, every single turn. Applies to claude runners
    // AND the persistent codex server (its final agent message is the answer).
    const bridgeFiles = cfg.persistentThreads && agent.runner !== "robot";
    let basePrompt = task.thread_root_id
      ? buildThreadFollowUpPrompt(ws, task, { resumed: conversationWarm, root: thread?.root ?? null, bridgeFiles })
      : buildPrompt(ws, task, { memories, conventions, crossWorkspace, volunteered: task.claimed_via === "volunteered", bridgeFiles });
    if (local) {
      basePrompt += `\n\nLOCAL ACCESS: you are running ON the member's machine in ${local.cwd} — this folder is the workspace's local project. You have real file and shell tools; use them for the actual work (build artifacts, code, sites live HERE). Mirror durable outcomes into the Cookbook workspace (files / remember) so the team side stays true.`;
    }
    const prompt = retry?.sessionId
      ? `Your previous attempt on this task was interrupted: ${String(retry.reason ?? "unknown failure").slice(0, 300)}. ` +
        `Continue EXACTLY where you left off — do not redo completed work. If you are close, finish and call complete_task; ` +
        `if the task is impossible from this environment, call abandon_task with the reason.`
      : retry
        ? `${basePrompt}\n\nNOTE: a previous attempt failed (${String(retry.reason ?? "unknown").slice(0, 300)}). ` +
          `Check the workspace and memory for work already done — continue it, don't redo it.`
        : basePrompt;
    if (retry?.sessionId) log(`  ↳ resuming previous session (continue, not redo)`);
    else if (warmRunner) log(`  ↳ warm thread runner — message goes straight to the live process`);
    else if (canResumeThread) log(`  ↳ resuming the thread's conversation (Composer follow-up)`);
    else if (task.thread_root_id) log(`  ↳ thread follow-up, no resumable session — running with the cold baton`);
    resume = retry ?? (canResumeThread ? { sessionId: threadSession } : null);
    let result = null;
    // approvalRelay runs (0086) NEVER take the runner: stream-json input mode
    // denies non-allowlisted tools without consulting --permission-prompt-tool.
    if (cfg.persistentThreads && !retry && agent.runner !== "app-server" && agent.runner !== "robot" && !agent.approvalRelay) {
      // Runner path: existing warm process, or boot one (resuming the thread's
      // saved session when there is one). ANY runner failure falls back to the
      // one-shot spawn below — the runner is an accelerator, never a dependency.
      try {
        const live = cfg.liveTokens !== false && agent.liveTokens !== false;
        const taskModel = task.model || null;
        const modelAgent = taskModel ? { ...agent, command: withModel(agent.command, taskModel), model: taskModel } : agent;
        const usable = warmRunner && (warmRunner.model ?? null) === taskModel ? warmRunner : null;
        if (warmRunner && !usable) log(`  ↳ warm runner is on another model — starting one on ${taskModel}`);
        const r = usable ?? runnerFor({
          threadId: threadKey,
          agent: pinnedAgent(cfg, modelAgent),
          env: agentEnv(cfg).env,
          resumeSessionId: canResumeThread ? threadSession : null,
          helpers: { fold: foldStreamLine, textFrom: textFromStreamLine, sessionFrom: sessionIdFrom, onPlan: notePlanHold },
          log,
          model: taskModel,
        });
        if (taskModel) log(`  ↳ model: ${taskModel}`);
        killers.set(task.id, () => r.kill());
        result = await r.send(prompt, {
          onProgress: live ? onProgress : undefined,
          timeoutMs: cfg.taskTimeoutSeconds * 1000,
          livenessMs: (cfg.livenessTimeoutSeconds ?? 0) * 1000,
        });
      } catch (e) {
        // busy / not claude / a runner that died or never launched: all fallback
        // material. Anything else is the run itself failing.
        if (/busy|not a claude-shaped|runner is dead|failed to launch/.test(e.message)) {
          log(`  ↳ runner unavailable (${e.message}) — one-shot fallback`);
          result = null;
        } else {
          throw e; // real failure: ride the existing retry/abandon machinery
        }
      }
    }
    if (!result) result = await runAgent(cfg, agent, prompt, onProgress, resume, { ws, task, onChild: (child) => killers.set(task.id, () => killChild(child, "SIGTERM")) });
    if (result && result.sessionId) retryCtx.set(task.id, { sessionId: result.sessionId, reason: retryCtx.get(task.id)?.reason ?? null });
    let after;
    if (bridgeFiles) {
      // File the final message as the result (agent may still have abandoned or
      // self-completed via tools — any conflict just falls back to reading state).
      const finalText = scrub(displayText(result?.out)).trim().slice(0, 20_000);
      // Success shape differs by runner: claude one-shots exit 0; the codex server
      // resolves with a turn status (no exit code) — failed statuses fall through.
      const cleanExit = result?.code === 0 || (result?.code === undefined && !/failed/i.test(String(result?.status ?? "")));
      // claude exits 0 even when its result envelope says the run errored (zero
      // turns, is_error, "No conversation found…"). That envelope is not an answer;
      // filing it would mark the task done and hand a crew a fake verdict.
      const envelopeError = resultError(result?.out);
      if (envelopeError) log(`  ↳ ${agent.name} returned an error envelope, not a result: ${envelopeError.slice(0, 160)}`);
      if (finalText && cleanExit && !envelopeError) {
        try {
          await completeTaskApi(cfg, ws.id, task.id, finalText);
          after = { status: "done" };
        } catch {
          after = await getTask(cfg, ws.id, task.id);
        }
      } else {
        after = await getTask(cfg, ws.id, task.id);
      }
    } else {
      after = await getTask(cfg, ws.id, task.id);
    }
    if (after?.status === "done") {
      retryCtx.delete(task.id);
      log(`✓ ${agent.name} completed "${task.title}"`);
      emitRun("done", ws, task, agent, localMeta);
      // Outcome signal: credit the memory notes that rode into this SUCCESSFUL run,
      // so proven notes surface first next time (outcome-weighted recall). Best-effort.
      if (recalledIds.length) creditRecall(cfg, ws.id, recalledIds).catch(() => {});
      // Quota visibility: tell Cookbook what this run cost (tokens/cost from the CLI's
      // own report when available, wall time always) so the assigner sees the price of
      // the delegation. Fire-and-forget — a usage hiccup must never fail a done task.
      try {
        const usage = extractUsage(result, agent.name, Date.now() - startedAt);
        if (usage) {
          await reportTaskUsage(cfg, ws.id, task.id, usage);
          const tok = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
          log(`  ↳ usage reported${tok ? `: ${tok.toLocaleString()} tokens` : ""}${usage.cost_usd ? ` · ~$${usage.cost_usd.toFixed(2)}` : ""}`);
        }
      } catch (e) {
        log(`  ↳ usage report skipped (${e.message})`);
      }
    } else {
      // The agent CLI exited but the task isn't done — surface WHY (login/MCP/tools),
      // instead of the old silent "ran but isn't marked done". This is the line that
      // turns a multi-hour debug into a one-glance fix.
      const hint = failureHint(result);
      const why = hint ? ` — ${hint}` : "";
      if (holdDuringRun()) {
        shelveForHold(hint || "plan limit reached", result?.sessionId ?? null);
      } else if (n >= cfg.maxAttempts) {
        givenUp.add(task.id);
        saveRunState();
        // Final attempt: account the burn (see catch path). extractUsage reads the
        // CLI's own final report when the run exited but didn't complete the task.
        try {
          const burned = extractUsage(result, agent.name, Date.now() - startedAt);
          if (burned) reportTaskUsage(cfg, ws.id, task.id, burned).catch(() => {});
        } catch { /* accounting only — never let it touch the failure path */ }
        // HAND BACK LOUDLY (Phase 0, audit #2/#8): mark it abandoned with the hint
        // so the ASSIGNER sees "tried, gave up, here's why" on the board — instead
        // of a task that silently rots open (or strands claimed, invisible to all).
        retryCtx.delete(task.id);
        await abandonTask(cfg, ws.id, task.id, hint || `ran ${n} attempt(s) without completing`);
        emitRun("failed", ws, task, agent, localMeta);
        log(`✗ ${agent.name} didn't complete "${task.title}" after ${n} attempts${why} — handed back as abandoned.`);
      } else {
        // THREAD SELF-HEAL: if this attempt RESUMED a session and still failed, the
        // session itself may be the problem (e.g. a safeguard refusing the replayed
        // transcript) — retry COLD on the baton instead of resuming into the same
        // wall. The cold run's own session_ref then becomes the thread's freshest
        // handle, so future replies resume a healthy conversation.
        const resumedAndFailed = task.thread_root_id && resume?.sessionId;
        retryCtx.set(task.id, {
          sessionId: resumedAndFailed ? null : result?.sessionId ?? retryCtx.get(task.id)?.sessionId ?? null,
          reason: hint || "ran but did not complete the task",
        });
        saveRunState();
        // EVERY failed run is a CLAIMED task now (Phase 0 pre-claims dispatch too),
        // so every one must ride the retry shelf or it strands invisible to the
        // open scan. (Pre-fix this was volunteered-only: assigned tasks whose
        // attempt 1 failed logged "will retry" and never did.)
        volunteeredRetries.push({ ws, task, agent });
        log(`… ${agent.name} ran but the task isn't marked done${why} — will retry${retryCtx.get(task.id)?.sessionId ? " (resumable)" : ""}.`);
      }
    }
  } catch (e) {
    if (holdDuringRun() && !stoppedRuns.has(task.id)) {
      shelveForHold(e.message, e.sessionId ?? null);
    } else if (n >= cfg.maxAttempts) {
      givenUp.add(task.id);
      saveRunState();
      retryCtx.delete(task.id);
      await abandonTask(cfg, ws.id, task.id, e.message || "failed after final attempt");
      emitRun("failed", ws, task, agent, null);
      // FINAL attempt failed: report what the failed runs actually burned, so the
      // chain token budget sees it. Only on the LAST attempt — usage is first-
      // report-wins, and an earlier report would block a successful retry's real
      // one. Best-effort: the server rejects states it won't account (e.g. open).
      if (e.partialUsage) {
        reportTaskUsage(cfg, ws.id, task.id, {
          ...e.partialUsage,
          duration_ms: e.elapsedMs ?? 0,
          runner: agent.name,
        }).then(() => {
          const tok = (e.partialUsage.input_tokens ?? 0) + (e.partialUsage.output_tokens ?? 0);
          log(`  ↳ burned quota reported despite failure: ${tok.toLocaleString()} tokens`);
        }).catch(() => {});
      }
    }
    // A volunteered task is CLAIMED — invisible to the open scan — so the throw
    // branch (timeouts are the COMMON failure here) must feed the retry shelf
    // exactly like the ran-but-not-done branch, or the claim strands.
    else if (stoppedRuns.has(task.id)) {
      // A human pressed Stop: the task is already cancelled server-side; nothing to
      // retry, nothing to abandon.
      stoppedRuns.delete(task.id);
      givenUp.add(task.id);
    }
    else {
      // Same thread self-heal as the ran-not-done branch: a failed RESUMED thread
      // attempt retries cold rather than back into the same session.
      const resumedAndFailed = task.thread_root_id && resume?.sessionId;
      retryCtx.set(task.id, { sessionId: resumedAndFailed ? null : e.sessionId ?? retryCtx.get(task.id)?.sessionId ?? null, reason: e.message });
      saveRunState();
      volunteeredRetries.push({ ws, task, agent }); // all claimed failures ride the shelf (see above)
    }
    const slow = /timed out after (\d+)s/.exec(e.message);
    lastRunError = `${agent.name}: ${String(e.message).slice(0, 300)}`;
    log(`✗ ${agent.name} error on "${task.title}": ${e.message}${slow ? ` — the run hit taskTimeoutSeconds (${slow[1]}s); raise it in config.json if this task is just slow` : ""}`);
  } finally {
    inFlight.delete(task.id);
    inFlightWs.delete(task.id);
    killers.delete(task.id);
    markHot(ws.id); // the reply usually lands right after a run finishes — stay fast for it
  }
}

let consecutive401s = 0;

// Warn (once per day) when the Bridge token is within 14 days of expiry — the
// alternative is a silent death into 401s weeks later (audit 2026-07-03 #9).
// Pairs with the 5x401 loud exit above: warned before, clean exit after.
let lastExpiryWarnDay = "";
function warnIfTokenExpiring(expiresAt) {
  if (!expiresAt) return;
  const daysLeft = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (daysLeft > 14) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastExpiryWarnDay === today) return;
  lastExpiryWarnDay = today;
  log(`! this Bridge's token expires in ${Math.max(daysLeft, 0)} day(s). Re-run \`${cli("connect")}\` before it does.`);
}

let wsCursor = 0;
/** ONE-CALL fast dispatch: list_open_work across every workspace in a single HTTP
 *  round-trip, then the same eligibility pipeline as the sweep (goal/volunteer,
 *  pending/skip messaging, and stale-claim rescue stay on the full sweep — this is
 *  the 1s dispatch lane, not the janitor). Returns false when the server predates
 *  the tool so the caller can fall back to sweeps. */
async function quickScan(cfg) {
  const { supported, work, warmHints } = await listOpenWork(cfg);
  if (!supported) return false;
  await dispatchWork(cfg, work, warmHints);
  return true;
}

// ── HOSTING: a visiting agent's hands on THIS machine (hardware grants, 0069) ─
//
// Someone the host invited — in a grant the host approved, with a scope the host
// set — queues calls; this Bridge executes them locally and posts back what
// happened. Every rule is re-checked here (bridge/hands.mjs authorizeCall), because
// the machine that runs a thing is the only honest place to decide whether it may.
// Serialized: one visiting agent, one pair of hands, one thing at a time — which is
// also what keeps the live log readable to the human watching it.
let handsBusy = false;
const hands = { supported: true, activeGrants: [] };
// Module-scoped ON PURPOSE. It used to be `let stopped` inside main(), and the
// hands path above referenced it from here — a ReferenceError on EVERY hands poll,
// so a host Bridge with hosting on accepted grants and executed nothing. Found in
// the first real rehearsal (2026-08-25); every hermetic test simulated the host
// loop with library code and never ran this file.
let stopped = false;

/** Run lifecycle → Bridge Local subscribers (the desktop tray + notifications). */
function emitHands(state, call, result) {
  if (!localServer) return;
  try {
    localServer.emit("hands", {
      state,
      callId: call?.id ?? null,
      grantId: call?.grant_id ?? null,
      workspaceId: call?.workspace_id ?? null,
      visitor: call?.visitor ?? null,
      verb: call?.verb ?? null,
      summary: describeCall ? describeCall(call) : (call?.verb ?? null),
      risk: call?.risk ?? null,
      ...(result ? { error: result.error ?? null } : {}),
      at: new Date().toISOString(),
    });
  } catch { /* notifications are best-effort */ }
}

/**
 * Something a visiting agent proposed is waiting on the HOST. It is not runnable
 * here — the whole point is that it waits — but this machine is the right place to
 * TELL them, so the desktop app can raise a notification instead of the host having
 * to be watching the browser tab. Announced once per call.
 */
const announcedAwaiting = new Set();
function noteAwaiting(awaiting) {
  for (const call of awaiting ?? []) {
    if (announcedAwaiting.has(call.id)) continue;
    announcedAwaiting.add(call.id);
    const what = describeCall ? describeCall(call) : call.verb;
    log(`⏳ ${call.visitor ?? "A visiting agent"} wants to ${what} — approve or refuse it in Cookbook.`);
    emitHands("needs-approval", call);
  }
  if (announcedAwaiting.size > 500) announcedAwaiting.clear();
}

/** The host context every hands path shares: serveCalls (visitor calls, plans) and
 *  runPreflight (the host's own first call on a new grant). */
function handsContext(cfg) {
  return {
    cfg,
    cfgPath: CONFIG_PATH,
    home: os.homedir(),
    // The host's OWN folder list. A granted folder is honoured only if it is here
    // (or inside one), so the server can never hand a visitor a directory.
    hostFolders: cfg.hosting?.folders ?? [],
    doctor: () => doctorReport(["--config", CONFIG_PATH]),
    claim: (id) => claimHandsCall(cfg, id),
    report: (id, r) => reportHandsResult(cfg, id, r),
    // Repair templates reach the same machinery the desktop app's buttons use, so
    // a fix an agent performs is exactly the fix the host could have clicked.
    restart: () => reexecSelf(),
    startConnect: () => connectAgentsProgrammatic({ cfgPath: CONFIG_PATH, baseUrl: cfg.cookbookUrl }),
    applyConfig: () => applyConfigFromDisk(cfg),
    log,
    stopped: () => stopped,
    visitorLabel: (c) => c.visitor ?? "a visiting agent",
    onCall: emitHands,
  };
}

async function serveHands(cfg, calls) {
  if (hostingMode(cfg) === "off" || handsBusy || !calls || calls.length === 0) return;
  handsBusy = true;
  try {
    await serveCalls(calls, handsContext(cfg));
  } catch (e) {
    log(`! hands error: ${e.message}`);
  } finally {
    handsBusy = false;
  }
}

/** Open a HOST-initiated call row on a grant (the pre-flight). Same bearer, same
 *  route the claim uses; the server answers { call_id }. */
async function createHostCall(cfg, grantId, verb) {
  const res = await fetch(`${cfg.cookbookUrl}/api/bridge/hands`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ grant_id: grantId, verb, host_initiated: true }),
  });
  if (!res.ok) throw new Error(`hands ${res.status}`);
  const j = await res.json().catch(() => ({}));
  return typeof j.call_id === "string" ? j.call_id : typeof j.call?.id === "string" ? j.call.id : null;
}

// ── PRE-FLIGHT: the first thing a new grant gets is what the machine already knows.
// When a grant this Bridge hosts becomes active, the host runs env + doctor +
// cli_versions + its own config's shape (tokens stripped) once, locally, read-only,
// and posts it as a host-initiated `preflight` call. The visitor reads it from
// grant_get before asking anything the machine already answered. Persisted per
// grant (bridge.state.json); at most two tries per grant per process.
const preflightTries = new Map(); // grantId -> attempts this process
async function preflightNewGrants(cfg) {
  if (hostingMode(cfg) === "off" || handsBusy || !runPreflight) return;
  const fresh = grantsNeedingPreflight(hands.activeGrants, { preflighted, tried: preflightTries });
  if (fresh.length === 0) return;
  handsBusy = true; // never alongside a visitor's call
  try {
    for (const grantId of fresh) {
      if (stopped) break;
      const n = (preflightTries.get(grantId) ?? 0) + 1;
      preflightTries.set(grantId, n);
      log(`◇ pre-flight for grant ${grantId.slice(0, 8)}: env, doctor, CLI versions, config shape`);
      try {
        const { callId } = await runPreflight(grantId, { ...handsContext(cfg), create: (gid) => createHostCall(cfg, gid, "preflight") });
        preflighted.add(grantId);
        saveRunState();
        log(`  ↳ pre-flight posted (call ${String(callId).slice(0, 8)})`);
      } catch (e) {
        log(`! pre-flight for grant ${grantId.slice(0, 8)} failed: ${e.message}${n >= 2 ? " (not retrying until the Bridge restarts)" : " (will retry once)"}`);
      }
    }
  } finally {
    handsBusy = false;
  }
}

/** Poll for granted calls (the net under the push channel, and the whole story on a
 *  server or network without SSE). No-ops entirely when not hosting. */
async function pollHands(cfg) {
  if (hostingMode(cfg) === "off" || !hands.supported || handsBusy) return;
  try {
    const r = await fetchHands(cfg);
    if (!r.supported) {
      hands.supported = false;
      log("· this Cookbook has no hardware-grant channel — hosting is unavailable");
      return;
    }
    hands.activeGrants = r.grants ?? [];
    noteAwaiting(r.awaiting ?? []);
    await preflightNewGrants(cfg);
    await serveHands(cfg, r.calls);
  } catch (e) {
    if (!/40[13]/.test(e.message)) log(`! couldn't check for granted work: ${e.message}`);
  }
}

// ── THE PUSH CHANNEL (SSE) ────────────────────────────────────────────────────
// One outbound connection; the server pushes open work + warm hints the moment
// they change (~sub-second dispatch). Connections are short-lived by design
// (serverless-honest); this loop reconnects forever. A server without the route
// marks it unsupported and the 1s poll carries on — push is an accelerator,
// never a dependency.
const sse = { connected: false, supported: true, aliveAt: 0 };

// ── THE DOORBELL (0083): Supabase Realtime wake + one-shot authenticated pull ──
// Replaces holding an SSE function open on the server. The socket carries only
// "ring"; /api/bridge/pull carries everything the stream used to push (work,
// warm hints, stops, hands) and stamps liveness. SSE remains the fallback lane.
const door = { active: false, connected: false, lastPullOkAt: 0 };

/** One authenticated pull = one former SSE frame. Returns false only when the
 *  server predates /api/bridge/pull (route missing → use the SSE lane). */
async function pullOnce(cfg, { boot = false } = {}) {
  const aq = agentsQuery(cfg);
  const bootQ = boot ? `${aq ? "&" : "?"}boot=${BOOT_MS}` : "";
  const res = await fetch(`${cfg.cookbookUrl}/api/bridge/pull${aq}${bootQ}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (res.status === 404 || res.status === 405) return false;
  if (!res.ok) throw new Error(`pull ${res.status}`);
  const j = await res.json();
  door.lastPullOkAt = Date.now();
  if (Array.isArray(j.stops) && j.stops.length) stopRuns(j.stops);
  await dispatchWork(cfg, j.work ?? [], j.warm_hints ?? []);
  if (j.hands && typeof j.hands === "object") {
    hands.activeGrants = j.hands.grants ?? hands.activeGrants;
    noteAwaiting(j.hands.awaiting ?? []);
    if (hostingMode(cfg) !== "off") void preflightNewGrants(cfg).then(() => serveHands(cfg, j.hands.calls ?? []));
  }
  // 0092: synthesis (summary, caption, vision, answer) thinks HERE, on this
  // member's subscription. Each job carries kind, model and image straight
  // through; synthesis.mjs queues them and runs one at a time.
  if (Array.isArray(j.synthesis) && j.synthesis.length) {
    import("./synthesis.mjs")
      .then((m) => m.runSynthesisJobs(cfg, j.synthesis, log, { env: agentEnv(cfg).env }))
      .catch((e) => log(`! synthesis import failed: ${e.message}`));
  }
  return true;
}

let doorbellAnnounced = false;
/** Try the doorbell lane. True = it owns push duty; false = use the SSE lane. */
async function doorbellLoop(cfg) {
  if (!wakeSocketSupported()) return false; // Node < 22: SSE lane
  let rt = null;
  try {
    const res = await fetch(`${cfg.cookbookUrl}/api/bridge/manifest`, { headers: { "Cache-Control": "no-store" } });
    if (res.ok) rt = (await res.json()).realtime ?? null;
  } catch { /* manifest unreachable — the SSE lane copes */ }
  if (!rt?.url || !rt?.anonKey) return false;
  let first;
  try { first = await pullOnce(cfg, { boot: true }); } catch { return false; }
  if (first === false) return false; // no pull route on this server
  door.active = true;
  let debounce = null;
  const ring = () => {
    if (debounce) return;
    debounce = setTimeout(() => { debounce = null; pullOnce(cfg).catch((e) => log(`! pull error: ${e.message}`)); }, 120);
  };
  const openSocket = () => connectWakeSocket({
    url: rt.url,
    anonKey: rt.anonKey,
    topic: deriveWakeTopic(cfg.token),
    log,
    onWake: ring,
    onState: (up) => {
      door.connected = up;
      if (up && !doorbellAnnounced) {
        doorbellAnnounced = true;
        log("🔔 doorbell connected — dispatch is push, no held server socket");
      }
      if (up) ring(); // anything that happened while the socket was down
    },
  });
  door.socket = openSocket();
  door.topicToken = cfg.token;
  // The topic is derived from the token. When connect-agents (or a hand edit)
  // swaps the token while running, the old socket sits on a topic the server no
  // longer rings; applyConfigFromDisk calls this to re-key it.
  door.refresh = () => {
    if (door.topicToken === cfg.token) return;
    try { door.socket?.stop(); } catch { /* replacing */ }
    door.connected = false;
    door.topicToken = cfg.token;
    door.socket = openSocket();
    log("🔔 doorbell re-keyed to the new token");
  };
  // Failsafe beat: liveness stamp + stranded-claim sweep + missed-ring cover.
  const beat = setInterval(() => {
    if (stopped) { clearInterval(beat); return; }
    pullOnce(cfg, { boot: true }).catch((e) => log(`! pull error: ${e.message}`));
  }, 60_000);
  return true;
}

function parseSseFrame(frame) {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return { event, data };
}

async function socketLoop(cfg) {
  let announced = false;
  while (!sseStopped && sse.supported) {
    try {
      const aq = agentsQuery(cfg);
      // `boot` lets the server re-open claims a previous process of ours left behind.
      const res = await fetch(`${cfg.cookbookUrl}/api/bridge/stream${aq}${aq ? "&" : "?"}boot=${BOOT_MS}`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (res.status === 404 || res.status === 405) {
        sse.supported = false;
        log("· server has no push channel — dispatching on the 1s poll");
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      sse.connected = true;
      sse.aliveAt = Date.now();
      if (!announced) {
        announced = true;
        log("⚡ push channel connected — dispatch is now sub-second");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sse.aliveAt = Date.now();
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!frame.trim() || frame.startsWith(":")) continue;
          const ev = parseSseFrame(frame);
          if (ev.event === "work" && ev.data) {
            try {
              const j = JSON.parse(ev.data);
              if (Array.isArray(j.stops) && j.stops.length) stopRuns(j.stops);
              void dispatchWork(cfg, j.work ?? [], j.warm_hints ?? []);
            } catch { /* malformed frame — next snapshot covers */ }
          }
          // A visiting agent queued a call on a grant this machine hosts. Push is
          // what makes "watch an agent work on your laptop" feel live.
          if (ev.event === "hands" && ev.data) {
            try {
              const j = JSON.parse(ev.data);
              hands.activeGrants = j.grants ?? hands.activeGrants;
              noteAwaiting(j.awaiting ?? []);
              void preflightNewGrants(cfg).then(() => serveHands(cfg, j.calls ?? []));
            } catch { /* malformed frame — the poll covers it */ }
          }
        }
      }
    } catch { /* transient — reconnect below */ }
    sse.connected = false;
    await new Promise((r) => setTimeout(r, 3000));
  }
}
let sseStopped = false;

/** The ONE dispatch pipeline — fed by the push channel (SSE) and the 1s poll alike.
 *  Re-entrancy-guarded: overlapping snapshots are redundant (each is a full picture),
 *  and claim CAS + inFlight make any stragglers harmless anyway. */
let dispatchBusy = false;
async function dispatchWork(cfg, work, warmHints) {
  if (dispatchBusy) return;
  dispatchBusy = true;
  try {
    await dispatchWorkInner(cfg, work, warmHints);
  } finally {
    dispatchBusy = false;
  }
}

async function dispatchWorkInner(cfg, work, warmHints) {
  // PRE-WARM (0065): the chat surface hinted a conversation is imminent — boot the
  // runner NOW so the first message hits a live process instead of a cold spawn.
  if (cfg.persistentThreads) {
    for (const h of warmHints ?? []) {
      const agent = agentFor(cfg, h.agent);
      if (!agent || agent.runner === "app-server" || agent.runner === "robot") continue;
      warmUp({
        poolKey: `warm::${h.workspace_id}::${agent.name}`,
        agent: pinnedAgent(cfg, agent),
        env: agentEnv(cfg).env,
        helpers: { fold: foldStreamLine, textFrom: textFromStreamLine, sessionFrom: sessionIdFrom, onPlan: notePlanHold },
        log,
      });
    }
  }
  const queue = [];
  // RETRY SHELF drains here too — the fast lane demoted the full sweep to a 30s
  // janitor, which silently made every retry wait up to 30s (Diego's SaaS thread,
  // 2026-08-20: fail at :26, retry at :03). A failed CLAIMED task must re-attempt
  // on the next second, exactly like fresh work.
  const held = []; // shelved retries whose agent is in a plan hold: back on the shelf
  while (volunteeredRetries.length > 0) {
    const retry = volunteeredRetries.shift();
    if (inFlight.has(retry.task.id) || givenUp.has(retry.task.id)) continue;
    if ((attempts.get(retry.task.id) ?? 0) >= cfg.maxAttempts) continue;
    if (agentHeld(retry.agent)) { held.push(retry); continue; }
    try {
      const fresh = await getTask(cfg, retry.ws.id, retry.task.id);
      if (fresh && fresh.status === "claimed") queue.push(retry);
    } catch {
      volunteeredRetries.push(retry); // transient — try again next scan
      break;
    }
  }
  volunteeredRetries.push(...held);
  for (const t of work) {
    if ((t.assigned_to || "").toLowerCase() === "goal") continue;
    if (inFlight.has(t.id) || givenUp.has(t.id)) continue;
    if ((attempts.get(t.id) ?? 0) >= cfg.maxAttempts) continue;
    // Round two: no configured agent for "Chef" + a support task addressed to Chef +
    // chef-persona.md shipped next to this file = a Chef synthesized from this
    // Bridge's own Claude (bridge/chef.mjs). Configured agents always win.
    const agent = agentFor(cfg, t.assigned_to) ?? resolveAgentForTask(cfg.agents, t, cfg);
    if (!agent) continue;
    if (agentHeld(agent)) continue;
    if (!allowedByPolicy(cfg, agent, t)) continue;
    let policy;
    try { policy = await resolveDelegation(cfg, t.id); } catch { continue; }
    if (policy.decision !== "run") continue;
    queue.push({ ws: { id: t.workspace_id, name: t.workspace_name ?? "workspace" }, task: t, agent });
  }
  queue.sort((a, b) => new Date(a.task.created_at ?? 0) - new Date(b.task.created_at ?? 0));
  const slots = Math.max(0, cfg.maxConcurrentRuns - inFlight.size);
  for (const item of queue.slice(0, slots)) {
    void processTask(cfg, item.ws, item.task, item.agent).catch((e) => log(`✗ run error on "${item.task.title}": ${e.message}`));
  }
}

async function pollOnce(cfg, onlyWorkspaceIds = null) {
  let workspaces = await listWorkspaces(cfg);
  // HOT-SCOPED SWEEP (chat feel): a full sweep across N workspaces costs N HTTP
  // round-trips — 12 workspaces ≈ 15s, which WAS the reply latency users felt.
  // While a conversation is hot, in-between sweeps scan only its workspace(s);
  // the full-fairness sweep still runs on the normal cadence.
  if (onlyWorkspaceIds) workspaces = workspaces.filter((w) => onlyWorkspaceIds.has(w.id));
  // FAIRNESS (Phase 1, audit #3): rotate which workspace is scanned first each
  // poll — scan order used to decide who ate the volunteer budget and the run
  // slots, starving every workspace after a busy one.
  if (workspaces.length > 1) {
    const k = wsCursor++ % workspaces.length;
    workspaces = [...workspaces.slice(k), ...workspaces.slice(0, k)];
  }
  consecutive401s = 0;
  // The token-expiry warning rides every FULL sweep (it used to run only when an
  // agent volunteered, so most Bridges never saw it). Cached a minute; best-effort.
  if (!onlyWorkspaceIds) { try { await cachedVolunteerSettings(cfg); } catch { /* a warning, never a blocker */ } }
  // Collect eligible (open, managed, not in-flight, not given-up) tasks.
  const queue = [];
  // Failed volunteered runs retry first — they're claimed by us, invisible to the
  // open scan. Verify the task is still live (not completed/cancelled by a human).
  const held = []; // plan-held agents keep their retries on the shelf
  while (volunteeredRetries.length > 0) {
    const retry = volunteeredRetries.shift();
    if (inFlight.has(retry.task.id) || givenUp.has(retry.task.id)) continue;
    if ((attempts.get(retry.task.id) ?? 0) >= cfg.maxAttempts) continue;
    if (agentHeld(retry.agent)) { held.push(retry); continue; }
    try {
      const fresh = await getTask(cfg, retry.ws.id, retry.task.id);
      if (fresh && fresh.status === "claimed") queue.push(retry);
    } catch { volunteeredRetries.push(retry); break; } // server unreachable — retry next poll
  }
  volunteeredRetries.push(...held);
  // Per-poll budget for volunteer decisions (each is a model call on the owner's quota).
  const decisionBudget = { used: 0 };
  for (const ws of workspaces) {
    let tasks;
    try {
      tasks = await listTasks(cfg, ws.id, "open");
    } catch (e) {
      log(`! couldn't list tasks for ${ws.name}: ${e.message}`);
      continue;
    }
    for (const t of tasks) {
      if (inFlight.has(t.id) || givenUp.has(t.id)) continue;
      if ((attempts.get(t.id) ?? 0) >= cfg.maxAttempts) continue;

      // Open GOAL → the volunteer path (stigmergy), never the dispatch path. OFF unless
      // an agent opted in (`"volunteer": true`) under the master switch (`volunteering`).
      if ((t.assigned_to || "").toLowerCase() === "goal") {
        const claimed = await considerVolunteering(cfg, ws, t, decisionBudget);
        if (claimed) queue.push(claimed); // {ws, task, agent} — claim already won
        continue;
      }

      // Round two: no configured agent for "Chef" + a support task addressed to Chef +
    // chef-persona.md shipped next to this file = a Chef synthesized from this
    // Bridge's own Claude (bridge/chef.mjs). Configured agents always win.
    const agent = agentFor(cfg, t.assigned_to) ?? resolveAgentForTask(cfg.agents, t, cfg);
      if (!agent) continue; // no local agent handles this assignee
      if (agentHeld(agent)) continue; // plan window closed: wait for the reset, keep the attempt

      // Optional extra LOCAL allowlist (config acceptFrom; default "anyone").
      if (!allowedByPolicy(cfg, agent, t)) {
        if (!skippedLogged.has(t.id)) {
          skippedLogged.add(t.id);
          log(`⊘ skipping "${t.title}" — assigned by ${t.assigned_by_member || t.assigned_by}, not in ${agent.name}'s local acceptFrom. Left open.`);
        }
        continue;
      }

      // UI-managed delegation policy (allow / ask / off), enforced by Cookbook.
      // FAILS CLOSED: consent unknown = don't run this poll. resolveDelegation
      // returns "run" itself for genuinely-older servers (unknown tool), so the
      // catch here only fires on transient failures — the task stays open and
      // is re-checked next poll.
      let policy;
      try {
        policy = await resolveDelegation(cfg, t.id);
      } catch {
        if (!skippedLogged.has("warn:" + t.id)) {
          skippedLogged.add("warn:" + t.id);
          log(`! couldn't check delegation policy for "${t.title}" — holding it until the check succeeds.`);
        }
        continue;
      }
      if (policy.decision === "pending") {
        if (!skippedLogged.has("pend:" + t.id)) {
          skippedLogged.add("pend:" + t.id);
          log(`⏳ "${t.title}" (from ${t.assigned_by_member || t.assigned_by}) is waiting for your approval → /account/agents`);
        }
        continue;
      }
      if (policy.decision === "skip") {
        // A daily-cap hold is temporary — log it distinctly (re-logs if the cap changes).
        const capMsg = policy.reason === "daily_cap"
          ? `⛔ ${capHoldLine(t.assigned_by_member || t.assigned_by, policy)}`
          : `⊘ "${t.title}" blocked by your delegation policy. Left open.`;
        const key = policy.reason === "daily_cap" ? "cap:" + t.id : t.id;
        if (!skippedLogged.has(key)) {
          skippedLogged.add(key);
          log(capMsg);
        }
        continue;
      }
      queue.push({ ws, task: t, agent });
    }
  }
  // PARALLEL SLOTS + FAIRNESS (Phase 1). Launch up to maxConcurrentRuns without
  // blocking the poll loop (inFlight dedupes across polls; the pre-claim makes a
  // double-launch a no-op even across Bridges). Oldest task first — newest-first
  // starved old tasks under a steady stream of new ones (audit #3).
  queue.sort((a, b) => new Date(a.task.created_at ?? 0) - new Date(b.task.created_at ?? 0));
  const slots = Math.max(0, cfg.maxConcurrentRuns - inFlight.size);
  for (const item of queue.slice(0, slots)) {
    void processTask(cfg, item.ws, item.task, item.agent).catch((e) => {
      inFlight.delete(item.task.id);
      log(`! run crashed unexpectedly for "${item.task.title}": ${e.message}`);
    });
  }
}

/** How often a RUNNING bridge re-checks the deploy manifest ("app updated → I update"). */
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

/**
 * WHO OWNS THIS INSTALL'S VERSION.
 *
 * The Bridge shipped with a bespoke self-updater because it was the only channel: an
 * unpacked tar has no package manager behind it. Where a real channel DOES exist,
 * rewriting our own files is wrong and has bitten us (2026-08-22: writing inside the
 * signed .app broke its code seal and voided notarization). So:
 *
 *   "app"  — the desktop shell spawned us (COOKBOOK_DESKTOP=1). The app ships, signs
 *            and notarizes the runtime with itself and re-seeds on upgrade. Never
 *            self-update: that is what corrupted the bundle.
 *   "npm"  — installed as a package (node_modules, npx cache, or a package.json next
 *            to us). npm is the channel; rewriting files under it fights the package
 *            manager and can poison an npx cache. Nag with the update command.
 *   "self" — a bare unpacked tar. No other channel exists, so keep the original
 *            behavior: verify, back up, replace, re-exec.
 */
function updateChannel() {
  if (IS_DESKTOP) return "app";
  if (HERE.includes(`${path.sep}node_modules${path.sep}`)) return "npm";
  if (fs.existsSync(path.join(HERE, "package.json"))) return "npm";
  return "self";
}

let updateNagged = false;

/**
 * Self-update pass. Only the "self" channel applies anything (see updateChannel).
 * autoUpdate !== false (default ON): apply + re-exec so fleets track app deploys.
 * autoUpdate === false: loud nag only — the version is pinned by the user.
 * Check failures are non-fatal (offline is fine); a FAILED apply never breaks the
 * running code (verification happens before any write; originals in bridge.backup/).
 */
async function selfUpdate(cfg, { reexec }) {
  let check;
  try {
    check = await checkForUpdate(cfg, HERE);
  } catch {
    return; // can't reach the manifest — never block on updates
  }
  if (check.changed.length === 0) return;
  const channel = updateChannel();
  if (channel !== "self") {
    // Say it once per process: drift should be visible, not noisy, and never silent.
    if (!updateNagged) {
      updateNagged = true;
      log(`⬆ ${updateLine(check.version, { here: HERE, desktop: channel === "app" })}`);
    }
    return;
  }
  if (cfg.autoUpdate === false) {
    log(`⬆ ${updateLine(check.version, { here: HERE, desktop: false })} (${check.changed.length} file(s) changed; autoUpdate is off.)`);
    return;
  }
  try {
    const replaced = await applyUpdate(cfg, HERE, check);
    log(`⬆ Bridge self-updated to deploy ${check.version} (${replaced.length} file(s), hash-verified; previous in bridge.backup/${check.version}/).`);
    if (reexec) {
      log("↻ restarting on the new code…");
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "inherit" });
      child.unref();
      process.exit(0);
    }
  } catch (e) {
    log(`! self-update failed safely (${e.message}) — still on the previous version.`);
  }
}

async function main() {
  await loadRuntime();
  const cfg = loadConfig();
  log(`Cookbook Bridge started · ${cfg.cookbookUrl}`);
  log(`Managing: ${cfg.agents.map((a) => a.name).join(", ") || "(no agents enabled!)"} · polling every ${cfg.pollSeconds}s`);

  // "When the app updates, so does the Bridge": check the deploy manifest now, then
  // every 6h while running. Set "autoUpdate": false in config to pin.
  await selfUpdate(cfg, { reexec: true });
  let lastUpdateCheck = Date.now();

  // Loud warning if the default agent (the one that runs "any"-assigned tasks) isn't
  // actually installed — otherwise those tasks silently route to a missing CLI. Run
  // `node bridge.mjs doctor` for the full preflight.
  const dflt = agentFor(cfg, "any");
  if (!dflt) {
    log(`! no default agent — "any"-assigned tasks won't run. Set "default" in config to an enabled agent.`);
  } else {
    // agentFor falls back to agents[0] when "default" names a missing/disabled
    // agent — silent rerouting is exactly the surprise class; say it out loud.
    if (cfg.default && dflt.name !== cfg.default) {
      log(`! config "default" is "${cfg.default}" but no enabled agent has that name — "any"-assigned tasks route to ${dflt.name}.`);
    }
    // Same binary derivation as the doctor: an openclaw agent has no `command` on
    // purpose (the runner builds its argv), so check the binary it will actually use
    // instead of warning "isn't installed" about a perfectly healthy agent.
    const dfltBin = Array.isArray(dflt.command) && dflt.command.length
      ? dflt.command[0]
      : dflt.runner === "openclaw"
        ? (dflt.bin || "openclaw")
        : null;
    if (!resolveBin(dfltBin)) {
      log(`! default agent "${dflt.name}" isn't installed/on PATH, so "any"-assigned tasks will fail. Run \`${cli("doctor")}\`.`);
    }
  }

  stopped = false; // module-scoped; see the hands section
  installShutdown(cfg);

  // Billing protection: say what's being stripped from agent processes (once).
  const { stripped } = agentEnv(cfg);
  if (stripped.length) {
    log(`Billing protection: ${stripped.join(", ")} hidden from agent processes so tasks run on your SUBSCRIPTION, never your API account. (Opt out: "allowApiKeyBilling": true in config.)`);
  }

  // Gemini version gate: refuse to run gemini agents below the RCE-fix version.
  // cfg.agents is pre-filtered at load and matching never re-checks `enabled`, so a
  // vulnerable agent must be REMOVED from the list, not just flagged.
  const vulnerableAgents = new Set();
  for (const agent of cfg.agents.filter((a) => isGeminiCommand(a.command?.[0]))) {
    const { version, vulnerable } = await checkGeminiVersion([agent.command[0]]);
    if (vulnerable) {
      vulnerableAgents.add(agent);
      console.error(
        `!! ${agent.name}: gemini-cli ${version} has a critical (CVSS 10.0) prompt-injection RCE — ` +
        `agent DISABLED for this run. Update to ≥ ${GEMINI_MIN_VERSION} (npm i -g @google/gemini-cli@latest) and restart.`,
      );
    } else if (!version) {
      log(`! ${agent.name}: couldn't read gemini version — make sure it's ≥ ${GEMINI_MIN_VERSION} (RCE fix).`);
    }
  }
  if (vulnerableAgents.size) cfg.agents = cfg.agents.filter((a) => !vulnerableAgents.has(a));

  // Agy (Antigravity) version gate: below 1.1.1 headless -p can't call MCP tools —
  // the task "runs" but complete_task never lands, burning every attempt. Same
  // remove-don't-flag rule as the gemini gate (matching never re-checks enabled).
  const tooOldAgy = new Set();
  for (const agent of cfg.agents.filter((a) => isAgyCommand(a.command?.[0]))) {
    const { version, tooOld } = await checkAgyVersion([agent.command[0]]);
    if (tooOld) {
      tooOldAgy.add(agent);
      console.error(
        `!! ${agent.name}: agy ${version} can't call MCP tools headlessly (fixed in ${AGY_MIN_VERSION}) — ` +
        `agent DISABLED for this run. Run \`agy update\` and restart.`,
      );
    } else if (!version) {
      log(`! ${agent.name}: couldn't read agy version — make sure it's >= ${AGY_MIN_VERSION} (headless MCP fix).`);
    }
  }
  if (tooOldAgy.size) cfg.agents = cfg.agents.filter((a) => !tooOldAgy.has(a));

  // BRIDGE LOCAL: the loopback control API (desktop app buttons: connect agents,
  // connect a folder, doctor, restart). Started BEFORE the token check on purpose:
  // the whole point of the connect UI is to FIX a broken/missing connection, so its
  // control plane must be up even when the Cookbook token is bad. Additive — a bind
  // failure never stops the Bridge from doing its real job.
  try {
    let version = "dev";
    try {
      const { createHash } = await import("node:crypto");
      version = createHash("sha256").update(fs.readFileSync(path.join(HERE, "bridge.mjs"))).digest("hex").slice(0, 8);
    } catch { /* keep dev */ }
    localServer = createLocalServer({
      cfg,
      cfgPath: CONFIG_PATH,
      version,
      log,
      doctor: () => doctorReport(["--config", CONFIG_PATH]),
      detectAgents: () => detectAgentsForStatus(cfg),
      startConnect: () => connectAgentsProgrammatic({ cfgPath: CONFIG_PATH, baseUrl: cfg.cookbookUrl }),
      applyConfig: () => applyConfigFromDisk(cfg),
      restart: () => reexecSelf(),
      hotWorkspaceIds: () => hotWorkspaceIds(),
      // SESSIONS MIRROR (0085): raw hook payloads from hook-reporter.mjs, folded +
      // redacted on this machine, batched to the server. Reporter, not brain.
      onSessionEvent: (e) => sessionReporter.onEvent(e),
      activeGrants: () => hands.activeGrants,
      // HONEST LIVENESS: a Bridge that has not reached Cookbook in two minutes is not
      // connected, whatever a startup flag says. The poll loop runs at most every
      // pollSeconds (default 15) and the push channel reconnects each minute, so two
      // minutes of silence means something is wrong — and saying so is the whole
      // point of a status endpoint.
      connected: () => tokenOk && consecutive401s === 0 && Date.now() - lastContactAt < 120_000,
      lastError: () => {
        if (tokenOk && Date.now() - lastContactAt > 120_000) {
          return `no contact with Cookbook for ${Math.round((Date.now() - lastContactAt) / 1000)}s — the Bridge may be stuck; restart it`;
        }
        return lastRunError;
      },
    });
    await localServer.start();
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { localServer.stop(); } catch { /* exiting */ } });
    process.on("exit", () => { try { localServer.stop(); } catch { /* exiting */ } });
  } catch (e) {
    localServer = null;
    log(`! Bridge Local couldn't start (${e.message}) — the desktop app's buttons won't work this session; tasks still run.`);
  }

  const sessionReporter = createSessionReporter({ cfg, log });

  // Confirm the token works before looping. A bad token is fatal for a HEADLESS
  // (terminal) Bridge — exit with the fix. But when Bridge Local is up (the desktop
  // app), stay alive in a degraded state so the user can fix the connection from the
  // app (connect-agents rewrites the token, applyConfig reloads it, the poll recovers).
  try {
    const ws = await listWorkspaces(cfg);
    tokenOk = true;
    lastContactAt = Date.now();
    log(`Connected — watching ${ws.length} workspace(s).`);
    // TEAM CONNECTORS (0068): a tool connected once in a workspace reaches every
    // member's CLIs, minus secrets (members export secret_env vars themselves).
    // Opt out with "syncConnectors": false. Startup-only; every write is .bak'd.
    if (cfg.syncConnectors !== false) {
      void (async () => {
        try {
          const { listTeamConnectors } = await import("./cookbook.mjs");
          const { applyTeamSync } = await import("./connectors.mjs");
          const byName = new Map();
          for (const w of ws) {
            for (const c of await listTeamConnectors(cfg, w.id).catch(() => [])) {
              if (!byName.has(c.name)) byName.set(c.name, c);
            }
          }
          if (!byName.size) return;
          const vendors = [...new Set(cfg.agents.map((a) => a.runner === "app-server" ? "codex" : (a.vendor ?? (/gemini/i.test(a.name) ? "gemini" : /codex/i.test(a.name) ? "codex" : "claude"))))].filter((v) => v === "claude" || v === "codex" || v === "gemini");
          const { plan, lines } = applyTeamSync([...byName.values()], vendors.length ? vendors : ["claude"], { cfgPath: CONFIG_PATH });
          if (plan.length || lines.length) {
            log(`⇄ team connectors: ${byName.size} defined, ${plan.length} write(s)`);
            for (const l of lines) log(l);
          }
        } catch (e) {
          log(`! team connector sync skipped: ${e.message}`);
        }
      })();
    }
    {
      const mode = hostingMode(cfg);
      if (mode === "always") log(`⌂ Hosting is ON: an agent you invite can run granted checks on this machine. You'll see every step; \`${cli("host --off")}\` closes the door.`);
      else if (mode === "grants") log(`⌂ Hosting: grants you approve in Cookbook run here (every change still waits for your click). \`${cli("host --off")}\` refuses all.`);
      else log(`⌂ Hosting is OFF: no visiting agent can act on this machine. \`${cli("host")}\` opens it.`);
      if (mode !== "off") await pollHands(cfg);
    }
    // Signals are handled by installShutdown (registered before connecting).
    if (cfg.persistentThreads) process.on("exit", () => { killAllRunners(); killCodexServer(); });
  } catch (e) {
    lastRunError = e.message;
    if (IS_DESKTOP && localServer) {
      log(`! Not connected to Cookbook yet: ${e.message}`);
      log(`  Fix it in the app (Connect your agents), or run \`${cli("connect")}\`. The control API stays up so you can.`);
    } else {
      console.error(`\nCouldn't connect to Cookbook: ${e.message}`);
      process.exit(1);
    }
  }

  let lastFullSweepAt = 0;
  let fastPath = true; // one-call dispatch until the server says it can't
  void (async () => {
    // Doorbell first (0083): push without a held server socket. SSE is the
    // fallback for old servers / Node < 22 — same duty, higher server cost.
    const doorUp = await doorbellLoop(cfg).catch(() => false);
    if (!doorUp) void socketLoop(cfg); // push channel: sub-second dispatch when the server has it
  })();
  while (!stopped) {
    try {
      // FAST PATH: push channel first (sub-second), 1s one-call poll as the net,
      // full sweep (volunteering, skip/hold messaging, stale-claim rescue) as the
      // 30s janitor. Falls back gracefully at every layer.
      const hotIds = hotWorkspaceIds();
      const pushHealthy =
        (sse.connected && Date.now() - sse.aliveAt < 30_000) ||
        // Doorbell lane: healthy while pulls succeed (the 60s beat keeps this
        // fresh even if the socket itself is down — dispatch degrades to ≤60s,
        // and the janitor sweep below still runs regardless).
        (door.active && Date.now() - door.lastPullOkAt < 90_000);
      if (fastPath) {
        const dueFullSweep = Date.now() - lastFullSweepAt >= Math.max(cfg.pollSeconds * 1000, 30_000);
        if (dueFullSweep) {
          lastFullSweepAt = Date.now();
          await pollOnce(cfg);
        } else if (pushHealthy) {
          // The socket carries dispatch; nothing to poll between janitor sweeps.
        } else {
          fastPath = await quickScan(cfg);
          if (!fastPath) log("· server predates list_open_work — dispatching via workspace sweeps instead");
        }
      } else {
        const fullEvery = hotIds.size > 0 ? Math.max(cfg.pollSeconds * 1000, 30_000) : cfg.pollSeconds * 1000;
        const dueFullSweep = Date.now() - lastFullSweepAt >= fullEvery;
        if (hotIds.size > 0 && !dueFullSweep) {
          await pollOnce(cfg, hotIds);
        } else {
          lastFullSweepAt = Date.now();
          await pollOnce(cfg);
        }
      }
      // HOSTING: granted calls ride the same cadence as work. When the push channel
      // is healthy it has already delivered them; this is the net.
      if (hostingMode(cfg) !== "off" && !pushHealthy) await pollHands(cfg);
      // A clean poll means the token is good — clear any prior rejection so the app's
      // /status flips back to connected once the user fixes it.
      lastContactAt = Date.now();
      if (consecutive401s || !tokenOk) { consecutive401s = 0; tokenOk = true; lastRunError = null; }
    } catch (e) {
      log(`! poll error: ${e.message}`);
      // A revoked/expired token would otherwise zombie-loop forever (re-running
      // `login`/`connect-agents` revokes the prior token by design). Exit loudly
      // with the actual fix instead of logging 401s every poll until the heat
      // death of the laptop.
      if (/401/.test(e.message)) {
        consecutive401s++;
        if (consecutive401s >= 5) {
          if (IS_DESKTOP && localServer) {
            // Desktop: keep the control API up so the user can fix the token from the
            // app. Back off to the slow cadence and stop spamming; recovers on fix.
            if (consecutive401s === 5) log("! Cookbook keeps rejecting this token — waiting. Fix it in the app (Connect your agents) or re-run login.");
            await new Promise((r) => setTimeout(r, Math.max(cfg.pollSeconds * 1000, 15_000)));
          } else {
            log("✗ Cookbook has rejected this token 5 polls in a row — it was likely revoked (a new login replaces old tokens) or expired.");
            log(`  Fix: ${cli("connect")}   (reconnects and starts the Bridge)`);
            process.exit(1);
          }
        }
      }
    }
    if (Date.now() - lastUpdateCheck > UPDATE_CHECK_MS) {
      lastUpdateCheck = Date.now();
      await selfUpdate(cfg, { reexec: true });
    }
    // HOT MODE (chat feel): while a conversation is active (a run started or
    // finished in the last 3 minutes), poll every second so a reply dispatches
    // near-instantly; decay back to the configured cadence when the room quiets.
    if (cfg.persistentThreads) { reapIdleRunners(log); reapCodexServer(log); }
    const hot = Date.now() - lastHotAt < HOT_WINDOW_MS;
    await new Promise((r) => setTimeout(r, fastPath || hot ? 1000 : cfg.pollSeconds * 1000));
  }
}

/**
 * Preflight check — the fix for the #1 onboarding problem (every prerequisite fails
 * silently or with a misleading error). Prints a ✓/✗ checklist and, for each ✗, the
 * EXACT command to fix it: Node version, config + token, token actually works, and per
 * agent: binary on PATH, CLI logged in (a real 1-token probe), allowedTools naming, and
 * the default agent installed. One screen instead of a multi-hour debug session.
 */
async function runDoctor(args) {
  const report = await doctorReport(args);
  const { rows, fails, warns } = report;
  if (args.includes("--json")) {
    console.log(JSON.stringify(report));
    process.exit(fails === 0 ? 0 : 1);
  }
  const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", x: "\x1b[0m" };
  const lines = rows.map((r) =>
    r.level === "ok" ? `  ${C.g}✓${C.x} ${r.label}`
      : r.level === "bad" ? `  ${C.r}✗${C.x} ${r.label}${r.fix ? `\n      ${C.r}↳ fix:${C.x} ${r.fix}` : ""}`
        : `  ${C.y}!${C.x} ${r.label}${r.fix ? `\n      ↳ ${r.fix}` : ""}`,
  );
  console.log(`\nCookbook Bridge — doctor\n`);
  console.log(lines.join("\n"));
  const notes = warns ? ` ${C.y}(${warns} warning${warns > 1 ? "s" : ""} above worth a look)${C.x}` : "";
  console.log(
    fails === 0
      ? `\n${C.g}No blockers — the Bridge should run tasks end-to-end.${C.x}${notes}\n`
      : `\n${C.r}${fails} problem(s) above must be fixed before the Bridge can run tasks.${C.x}${notes}\n`,
  );
  process.exit(fails === 0 ? 0 : 1);
}

/**
 * What the doctor can say about a visiting (openclaw) agent WITHOUT starting a turn
 * on its owner's subscription: is the profile configured, and does the agent id the
 * Bridge will pass actually exist. Both are local and free.
 */
async function doctorOpenclaw(agent, { ok, warn, bad }) {
  const { inspectOpenclawProfile, listOpenclawAgents } = await import("./openclaw-runner.mjs");
  for (const f of inspectOpenclawProfile(agent)) {
    if (f.level === "bad") bad(f.message, f.fix);
    else if (f.level === "warn") warn(f.message, f.fix);
    else ok(f.message);
  }
  const wanted = agent.openclawAgent || null;
  const listed = await listOpenclawAgents(agent);
  if (!listed.ok) {
    warn(`${agent.name}: couldn't list OpenClaw agents`, listed.error || "is `openclaw` on PATH?");
    return;
  }
  if (!wanted) {
    warn(`${agent.name}: no openclawAgent set — the run has no --agent and openclaw will refuse to pick one`,
      `set "openclawAgent" to one of: ${listed.ids.join(", ") || "(none listed)"}`);
  } else if (!listed.ids.includes(String(wanted))) {
    bad(`${agent.name}: openclawAgent "${wanted}" doesn't exist in profile "${agent.profile || "default"}"`,
      `known agents: ${listed.ids.join(", ") || "(none)"}`);
  } else {
    ok(`${agent.name}: agent "${wanted}" exists in profile "${agent.profile || "default"}" (no turn spent)`);
  }
}

/** The doctor's checks as data: { cfgPath, rows: [{ level, label, fix }], fails, warns }.
 *  Shared by the CLI (`doctor`, `doctor --json`) and Bridge Local's POST /doctor. */
async function doctorReport(args) {
  await loadRuntime();
  const rows = [];
  let fails = 0;
  let warns = 0;
  const ok = (s) => rows.push({ level: "ok", label: s });
  const bad = (s, fix) => { fails++; rows.push({ level: "bad", label: s, ...(fix ? { fix } : {}) }); };
  const warn = (s, note) => { warns++; rows.push({ level: "warn", label: s, ...(note ? { fix: note } : {}) }); };

  // 1. Node version
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) ok(`Node ${process.version}`);
  else bad(`Node ${process.version} is too old (need ≥18)`, "install Node 18+ (e.g. `brew install node`)");

  // 2. Config home (0.1.11): where the config lives, whether it exists, how tight it is.
  const cfgPath = configPathFromArgs(args);
  const home = configHome();
  const modeOf = (p) => { try { return (fs.statSync(p).mode & 0o777).toString(8); } catch { return null; } };
  {
    const homeMode = modeOf(home);
    if (homeMode === null) ok(`Config home ${home} (not created yet; \`${cli("connect")}\` creates it)`);
    else if (process.platform === "win32" || homeMode === "700") ok(`Config home ${home} (exists, mode ${homeMode})`);
    else warn(`Config home ${home} is mode ${homeMode}; it holds tokens and should be owner-only`, `chmod 700 "${home}"`);
  }
  let cfg = null;
  if (!fs.existsSync(cfgPath)) {
    bad(`No config at ${cfgPath}`, `run \`${cli("connect")}\` (one approval; it writes the config and starts the Bridge)`);
  } else {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      cfg.cookbookUrl = (cfg.cookbookUrl || "").replace(/\/$/, "");
      cfg.agents = (cfg.agents ?? []).filter((a) => a.enabled !== false);
      for (const a of cfg.agents) a.cookbookUrl = cfg.cookbookUrl; // for per-run MCP pinning (spawnAgent)
      if (!cfg.cookbookUrl || !cfg.token || String(cfg.token).startsWith("PASTE")) {
        bad("Config is missing cookbookUrl or a real token", `run \`${cli("connect")}\`, or set both in ${cfgPath} (token from your Cookbook > Tokens page)`);
        cfg = null;
      } else {
        const m = modeOf(cfgPath);
        if (process.platform === "win32" || m === "600") ok(`Config ${cfgPath} (mode ${m ?? "n/a"})`);
        else warn(`Config ${cfgPath} is mode ${m}; it carries your token and should be owner-only`, `chmod 600 "${cfgPath}"`);
      }
    } catch (e) {
      bad(`Config isn't valid JSON: ${e.message}`);
      cfg = null;
    }
  }

  // 2b. Another Bridge on this machine? Two on one config fight over the same token
  // (a `connect` revokes the other's); one on a different config is the classic
  // "I connected but a stale Bridge is still running" trap.
  try {
    const { scanBridgeProcesses } = await import("./device.mjs");
    const others = scanBridgeProcesses({ selfPid: process.pid });
    if (others === null) ok("Another Bridge process on this machine: could not scan (ps/tasklist unavailable)");
    else if (!others.length) ok("No other Bridge process on this machine");
    else {
      const desc = others.map((o) => `pid ${o.pid}${o.configPath ? ` (config ${o.configPath})` : o.unknownCommand ? " (node.exe; command line not visible)" : " (default config)"}`).join(", ");
      warn(`Another Bridge process on this machine: ${desc}`, `stop it if you meant to run only one (kill ${others.map((o) => o.pid).join(" ")}); two Bridges on one config fight over the same token`);
    }
  } catch (e) {
    ok(`Another Bridge process on this machine: could not scan (${e.message})`);
  }

  // 2c. Bridge Local: the loopback control API a running Bridge writes local.json for.
  {
    const localPath = path.join(path.dirname(cfgPath), "local.json");
    let local = null;
    try { local = JSON.parse(fs.readFileSync(localPath, "utf8")); } catch { /* not running */ }
    if (!local || !local.port) ok(`Bridge Local: not running (no ${localPath})`);
    else {
      let answered = false;
      try {
        const res = await fetch(`http://127.0.0.1:${local.port}/status`, { headers: { "X-Bridge-Token": String(local.token || "") }, signal: AbortSignal.timeout(2000) });
        answered = res.ok;
      } catch { answered = false; }
      if (answered) ok(`Bridge Local answering on 127.0.0.1:${local.port} (pid ${local.pid ?? "?"})`);
      else warn(`Bridge Local: ${localPath} says port ${local.port} (pid ${local.pid ?? "?"}) but nothing answers there`, `that Bridge is gone or stuck; start one with \`${cli()}\` (it rewrites local.json)`);
    }
  }

  // 2d. Staleness: the same manifest comparison startup does, with the same fix line.
  if (cfg && cfg.cookbookUrl && checkForUpdate) {
    try {
      const check = await checkForUpdate({ cookbookUrl: cfg.cookbookUrl }, HERE);
      if (check.changed.length === 0) ok(`Bridge files match the app deploy (${check.version})`);
      else warn(`Bridge files are behind the app deploy (${check.version}; ${check.changed.length} file(s) differ)`, updateLine(check.version, { here: HERE, desktop: IS_DESKTOP }));
    } catch (e) {
      warn(`Couldn't compare the Bridge to the app deploy (${e.message})`, "offline is fine; the running Bridge re-checks every 6 hours");
    }
  }

  if (cfg) {
    ensureAgentPath();

    // 3. Token actually works
    try {
      const ws = await listWorkspaces(cfg);
      ok(`Cookbook token works — ${ws.length} workspace(s) visible`);
    } catch (e) {
      bad(`Cookbook token rejected: ${e.message}`, `run \`${cli("connect")}\` to mint a fresh one (or paste a token from your Cookbook > Tokens page into ${cfgPath})`);
    }

    // 4. Default agent is one of the enabled agents
    if (cfg.default && !cfg.agents.some((a) => a.name === cfg.default)) {
      bad(`default agent "${cfg.default}" isn't in your enabled agents`,
        `set "default" to one of: ${cfg.agents.map((a) => a.name).join(", ") || "(none enabled)"}`);
    }

    if (!cfg.agents.length) warn("No agents enabled in config — nothing will run.");

    // 5. Per agent: binary, allowedTools sanity, and a real login probe
    for (const agent of cfg.agents) {
      // An openclaw agent has no `command`: its argv is assembled by the runner from
      // profile + openclawAgent, precisely so a hand-written command can't drop
      // --agent. Derive its binary the same way the runner does, or the doctor
      // reports `binary \`null\` not found` for a perfectly good config.
      const cmd = Array.isArray(agent.command) && agent.command.length
        ? agent.command[0]
        : agent.runner === "openclaw"
          ? (agent.bin || "openclaw")
          : null;
      const bin = resolveBin(cmd);
      if (!bin) {
        bad(`${agent.name}: binary \`${cmd}\` not found on PATH`,
          `install it, or put an absolute path in config (find it with \`which ${cmd}\`)`);
        continue;
      }
      ok(`${agent.name}: binary at ${bin}`);

      // Gemini RCE gate (CVSS 10.0, fixed in 0.39.1): a confirmed-old version is a
      // hard failure — the Bridge will refuse to run this agent.
      if (isGeminiCommand(cmd)) {
        const { version, vulnerable } = await checkGeminiVersion([bin]);
        if (vulnerable) {
          bad(`${agent.name}: gemini-cli ${version} has a critical prompt-injection RCE (CVSS 10.0)`,
            `update to ≥ ${GEMINI_MIN_VERSION}: npm i -g @google/gemini-cli@latest`);
        } else if (version) {
          ok(`${agent.name}: gemini-cli ${version} (≥ ${GEMINI_MIN_VERSION}, RCE-safe)`);
        } else {
          warn(`${agent.name}: couldn't read gemini version`, `make sure it's ≥ ${GEMINI_MIN_VERSION} (RCE fix)`);
        }
      }

      // Agy (Antigravity) checks: version >= 1.1.1 (headless-MCP fix), the MCP
      // config file (agy has no `mcp add` — connect-agents writes it), and login.
      if (isAgyCommand(cmd)) {
        const { version, tooOld } = await checkAgyVersion([bin]);
        if (tooOld) {
          bad(`${agent.name}: agy ${version} can't call MCP tools headlessly (fixed in ${AGY_MIN_VERSION})`,
            "run `agy update` — below 1.1.1 tasks run but never complete");
        } else if (version) {
          ok(`${agent.name}: agy ${version} (>= ${AGY_MIN_VERSION}, headless MCP works)`);
        } else {
          warn(`${agent.name}: couldn't read agy version`, `make sure it's >= ${AGY_MIN_VERSION} (headless MCP fix)`);
        }
        const agyMcpPath = path.join(process.env.HOME || os.homedir(), ".gemini", "config", "mcp_config.json");
        try {
          const mc = JSON.parse(fs.readFileSync(agyMcpPath, "utf8"));
          const srv = mc?.mcpServers?.cookbook;
          if (srv?.serverUrl === `${cfg.cookbookUrl}/api/mcp` && srv?.headers?.Authorization) {
            ok(`${agent.name}: Cookbook MCP configured (${agyMcpPath})`);
          } else if (srv) {
            warn(`${agent.name}: MCP config points at ${srv.serverUrl || "(no url)"}`,
              `expected ${cfg.cookbookUrl}/api/mcp; re-run \`${cli("connect")}\``);
          } else {
            bad(`${agent.name}: no 'cookbook' server in ${agyMcpPath}`,
              `run \`${cli("connect")}\` (agy has no \`mcp add\`; the Bridge writes this file)`);
          }
        } catch {
          bad(`${agent.name}: no agy MCP config at ${agyMcpPath}`,
            `run \`${cli("connect")}\` (agy has no \`mcp add\`; the Bridge writes this file)`);
        }
        if (!fs.existsSync(path.join(process.env.HOME || os.homedir(), ".gemini", "oauth_creds.json"))) {
          warn(`${agent.name}: no Google login found (~/.gemini/oauth_creds.json)`,
            "run `agy` once interactively and sign in with Google");
        }
      }

      // Kimi Code: version (no gate), login (config.toml providers / credentials),
      // the user-level mcp.json the Bridge writes, and the two flags a headless
      // run needs (the jail and the stream).
      if (isKimiCommand && isKimiCommand(cmd)) {
        const { version } = await checkKimiVersion([bin]);
        if (version) ok(`${agent.name}: kimi ${version}`);
        else warn(`${agent.name}: couldn't read kimi version`, "run `kimi --version` by hand");
        const login = kimiLoginState();
        if (login.loggedIn) ok(`${agent.name}: logged in (${login.providers.length ? `provider ${login.providers.join(", ")}` : `${login.credentials} OAuth credential(s)`})`);
        else bad(`${agent.name}: no Kimi login found (no provider with a key in ${login.configPath}, nothing under credentials/)`, "run `kimi login` (device code), or `/login` inside `kimi`");
        const mcp = kimiMcpState({ cookbookUrl: cfg.cookbookUrl });
        if (mcp.server && mcp.matches && mcp.hasAuth) ok(`${agent.name}: Cookbook MCP configured (${mcp.file})`);
        else if (mcp.server) warn(`${agent.name}: MCP server 'cookbook' in ${mcp.file} points at ${mcp.url || "(no url)"}${mcp.hasAuth ? "" : " with no Authorization header"}`, `expected ${cfg.cookbookUrl}/api/mcp with a bearer token; re-run \`${cli("connect")}\``);
        else bad(`${agent.name}: no 'cookbook' server in ${mcp.file}`, `run \`${cli("connect")}\` (kimi has no \`mcp add\`; the Bridge writes this file)`);
        const cmdArgs = agent.command || [];
        if (!cmdArgs.includes("--allowedTools")) {
          bad(`${agent.name}: no --allowedTools in the command; kimi's headless mode auto-approves EVERY tool (Bash included) and has no flag of its own`,
            `add "--allowedTools", "mcp__cookbook__*" to this agent's command (the Bridge turns it into a per-run agent file)`);
        } else if (cmdArgs.includes("-S") || cmdArgs.includes("--session") || cmdArgs.includes("-c")) {
          warn(`${agent.name}: the command resumes a session by hand, so --allowedTools is ignored on that run (kimi binds the agent at session creation)`);
        }
        if (!cmdArgs.includes("stream-json")) warn(`${agent.name}: no --output-format stream-json; the board gets no live progress and no work log from this agent`, `add "--output-format", "stream-json" to this agent's command`);
      }

      if (isClaudeCommand && isClaudeCommand(agent.command)) {
        if (agent.token) ok(`${agent.name}: runs carry their own Cookbook connection (per-agent token) — identity is this Bridge's member`);
        else warn(`${agent.name}: no per-agent token — runs use the claude CLI's OWN Cookbook login, which may be a different account and inherits stale claude.ai connectors`,
          `run \`${cli("connect")}\` (mints a token for this agent) or add "token" to this agent in ${cfgPath}`);
      }
      if ((agent.command || []).join(" ").includes("mcp__claude_ai_Cookbook__")) {
        warn(`${agent.name}: allowedTools uses mcp__claude_ai_Cookbook__* — a CLI-added server is usually mcp__cookbook__*`,
          "if tasks 'run but never complete', switch allowedTools to mcp__cookbook__*");
      }

      if (agent.runner === "app-server") { warn(`${agent.name}: app-server runner — start it to verify login/MCP (probe skipped)`); continue; }
      // A visiting agent (openclaw) is driven through the Gateway with its own
      // token, so we will not spend a turn on someone's subscription to probe it.
      // But "probe skipped" used to mean NOTHING was checked, and a Chef whose
      // profile had no gateway credentials, no model and no such agent id sat here
      // reported as fine until the first real question hit it (2026-08-24). Every
      // check below is local and free, and each one is a failure seen for real.
      if (agent.runner === "openclaw") {
        await doctorOpenclaw(agent, { ok, warn, bad });
        continue;
      }
      if (agent.runner === "robot") {
        const r = await spawnAgent(agent, "", 15, agentEnv(cfg).env);
        if (r.code === 0 && String(r.out).trim().endsWith("ok")) ok(`${agent.name}: robot agent responds (probe ok)`);
        else warn(`${agent.name}: robot agent probe inconclusive`, String(r.err || r.out).slice(0, 160));
        continue;
      }

      try {
        const r = await spawnAgent(agent, "Reply with the single word: ok", 30, agentEnv(cfg).env);
        const text = `${r.out || ""}\n${r.err || ""}`.toLowerCase();
        if (text.includes("not logged in") || text.includes("/login") || text.includes("please log in")) {
          bad(`${agent.name}: CLI is NOT logged in`, `run \`${cmd} auth login\` (persists; setup-token does not)`);
        } else if (text.includes("no mcp") || text.includes("mcp server")) {
          bad(`${agent.name}: no Cookbook MCP connected`,
            `${cmd} mcp add --scope user --transport http cookbook ${cfg.cookbookUrl}/api/mcp --header "Authorization: Bearer <token>"`);
        } else if (r.code === 0) {
          ok(`${agent.name}: CLI responds (logged in)`);
        } else {
          const probeTail = `${r.err || r.out || ""}`.trim().split("\n").slice(-2).join(" ").slice(0, 200);
          // Account/tier lockouts (gemini's IneligibleTierError, quota exhaustion,
          // auth expiry) are REAL blockers, not inconclusive noise — a CLI that
          // starts but can't serve burns every attempt at runtime (2026-07-03).
          if (/ineligible|no longer supported|quota exceeded|not authenticated|login required|migrate to/i.test(probeTail)) {
            bad(`${agent.name}: the CLI refuses this account/tier — ${probeTail}`, "fix the account (or remove the agent from config.json — removal, not enabled:false)");
          } else {
            warn(`${agent.name}: probe exited ${r.code} — inconclusive`, probeTail);
          }
        }
      } catch (e) {
        warn(`${agent.name}: probe couldn't run (${e.message}) — inconclusive`);
      }
    }
  }

  return { cfgPath, rows, fails, warns };
}

// Dispatch ONLY when bridge.mjs is the entry script. Without this guard, any
// test/tool that IMPORTS this module (for streamingCommand etc.) fell through
// to main() and started a REAL polling Bridge on the importer's machine.
// `import.meta.main` only exists from Node 22.18 / 24.2 on. Before that it is
// undefined, the guard read false, and EVERY command (connect, doctor, the Bridge
// itself) exited 0 in silence on Node 18/20/22.x. The argv[1] comparison is the
// portable fallback. Exported for tests.
export function isMainModule(meta = import.meta, argv = process.argv) {
  if (meta.main === true) return true;
  if (meta.main === false) return false;
  try {
    return !!argv[1] && path.resolve(argv[1]) === fileURLToPath(meta.url);
  } catch {
    return false;
  }
}
const IS_MAIN = isMainModule();
const sub = process.argv[2];
if (!IS_MAIN) {
  /* library import — export-only, no dispatch */
} else if (sub === "doctor") {
  runDoctor(process.argv.slice(3)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (sub === "login") {
  import("./device.mjs")
    .then((m) => m.login(process.argv.slice(3)))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
} else if (sub === "connectors") {
  // Connect a tool once, every agent has it: survey/sync MCP connectors across
  // Claude, Codex, and Gemini (three files, three schemas, silent drift).
  import("./connectors.mjs")
    .then(async (m) => {
      const args = process.argv.slice(3);
      const cfgPath = configPathFromArgs(args, { positional: false });
      if (args[0] === "approve") {
        // A team STDIO connector runs a command on this machine; it is recorded on
        // sync and written only after this explicit approval (connectors.mjs).
        const name = args[1];
        if (!name) { console.error(`Usage: ${cli("connectors approve <name>")}`); process.exit(1); }
        const lines = m.approveConnector(name, { cfgPath });
        console.log(`\n  Approved "${name}". Written to your agent CLIs:`);
        for (const l of lines) console.log(l);
        console.log("\n  Restart your agents to pick it up.\n");
        return;
      }
      if (args[0] === "pending") {
        const waiting = Object.entries(m.readPendingConnectors(cfgPath)).filter(([, e]) => !e?.approved);
        if (!waiting.length) return console.log("\n  No team connectors are waiting for your approval.\n");
        console.log("\n  Team connectors waiting for your approval (each runs a command on this machine):");
        for (const [n, e] of waiting) console.log(`    ${n.padEnd(22)} ${[e.command, ...(e.args ?? [])].join(" ").slice(0, 80)}`);
        console.log(`\n  Approve one with: ${cli("connectors approve <name>")}\n`);
        return;
      }
      const doSync = args.includes("sync");
      const dryRun = args.includes("--dry-run");
      const rows = m.survey();
      const vendors = Object.keys(m.VENDORS);
      if (rows.length === 0) return console.log("No MCP connectors found for Claude, Codex, or Gemini.");
      console.log("\n  " + "connector".padEnd(22) + vendors.map((v) => m.VENDORS[v].label.padEnd(9)).join(""));
      for (const r of rows) {
        const cells = vendors.map((v) => (r.present[v] ? "  ✓      " : "  ·      ")).join("");
        console.log("  " + r.name.padEnd(22) + cells + (r.drift ? "⚠ drift" : ""));
      }
      for (const r of rows.filter((x) => x.drift)) {
        console.log(`\n  ⚠ "${r.name}" points somewhere different per vendor:`);
        for (const t of r.targets) console.log(`      ${t}`);
      }
      if (!doSync) {
        const missing = rows.filter((r) => vendors.some((v) => !r.present[v])).length;
        console.log(`\n  ${missing} connector(s) aren't on every agent.`);
        console.log(`  Run \`${cli("connectors sync")}\` to give every agent the same tools.\n`);
        return;
      }
      const only = args.filter((a) => !a.startsWith("--") && a !== "sync");
      const actions = m.sync({ only: only.length ? only : null, dryRun });
      if (actions.length === 0) return console.log("\n  Already in sync — every agent has the same connectors.\n");
      console.log(`\n  ${dryRun ? "Would apply" : "Applied"} ${actions.length} change(s):`);
      for (const a of actions) console.log(`    ${a.error ? "!" : a.action === "add" ? "+" : "~"} ${m.VENDORS[a.vendor].label.padEnd(7)} ${a.name}${a.error ? ` (skipped: ${a.error})` : ""}`);
      if (!dryRun) console.log("\n  Backups written next to each config (.bak-<timestamp>). Restart your agents to pick them up.\n");
      else console.log("\n  (dry run — nothing written)\n");
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
} else if (sub === "chat") {
  // Talk to your workspace's agents without leaving the terminal. chat.mjs is a
  // standalone script that reads its config from argv[2], so reshape argv to make
  // `cookbook-bridge chat [config.json]` behave like `node chat.mjs [config.json]`.
  // Without this subcommand the file shipped in every install but was unreachable
  // by any obvious command.
  process.argv = [process.argv[0], path.join(HERE, "chat.mjs"), ...process.argv.slice(3)];
  import("./chat.mjs").catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (sub === "connect" || sub === "connect-agents") {
  // `connect` is the documented first command (the connect page and the npm bin both
  // say it); `connect-agents` is the original name, kept working forever.
  // 0.1.11: after the approval the Bridge RUNS, right here, unless --no-run. Stopping
  // at "connected" was the single most confusing moment (nothing polls, and the
  // approval just revoked whatever older Bridge was polling).
  import("./device.mjs")
    .then(async (m) => {
      const args = process.argv.slice(3);
      const noRun = args.includes("--no-run");
      const r = await m.connectAgents(args.filter((a) => a !== "--no-run"), { willRun: !noRun });
      if (!r || !r.ok) {
        // Nothing to run (no agent CLI found): the doctor says what is missing and how to fix it.
        if (r && r.reason === "no-agents") await runDoctor(["--config", r.cfgPath]);
        return;
      }
      if (noRun || !r.startBridge) return;
      console.log("Connected. Running the Bridge now; leave this window open. Ctrl-C stops it.\n");
      process.argv = [process.argv[0], process.argv[1], r.cfgPath];
      await main();
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
} else if (sub === "host") {
  // Open the door for a visiting agent (hardware grants). Ends with a RUNNING
  // Bridge, because a door nobody is standing behind isn't open.
  import("./device.mjs")
    .then(async (m) => {
      const hostArgs = process.argv.slice(3);
      const r = await m.host(hostArgs);
      if (r && r.startBridge) {
        // main() reads its config from argv[2]: carry `--config <path>` over, or
        // the Bridge that opens the door runs on a different config than `host`
        // just wrote.
        process.argv = [process.argv[0], process.argv[1], r.cfgPath || m.configPath(hostArgs)];
        await main();
      }
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
} else if (sub === "sessions") {
  // SESSIONS MIRROR (0085): install/remove the Claude Code hooks that mirror
  // terminal sessions into the Room. `sessions on|off|status`.
  import("./sessions.mjs")
    .then((m) => m.sessionsCli(process.argv.slice(3), { here: HERE }))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
} else if (sub === "status") {
  import("./device.mjs")
    .then((m) => m.status(process.argv.slice(3)))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
} else if (sub === "update") {
  // One-shot: check the deploy manifest, verify + apply, report. Exit 0 either way
  // unless the apply itself failed.
  (async () => {
    // Deliberately import ONLY update.mjs — this path must work from a broken install.
    // Config is read minimally here (no loadConfig: that treats argv[2] as a path and
    // demands a token — updates need only the cookbookUrl, both endpoints are public).
    const upd = await import("./update.mjs");
    const cfgPath = configPathFromArgs(process.argv.slice(3));
    let cookbookUrl = "";
    try {
      cookbookUrl = String(JSON.parse(fs.readFileSync(cfgPath, "utf8")).cookbookUrl || "").replace(/\/$/, "");
    } catch { /* fall through to the error below */ }
    if (!cookbookUrl) {
      console.error(`Can't read cookbookUrl from ${cfgPath}. Pass --config <path>, or run \`${cli("connect")}\` to write one.`);
      process.exit(1);
    }
    const cfg = { cookbookUrl };
    const check = await upd.checkForUpdate(cfg, HERE);
    if (check.changed.length === 0) {
      console.log(`Up to date with the app deploy (${check.version}).`);
      return;
    }
    console.log(`Update available (deploy ${check.version}) — ${check.changed.length} file(s): ${check.changed.join(", ")}`);
    const replaced = await upd.applyUpdate(cfg, HERE, check);
    console.log(`Updated ${replaced.length} file(s), hash-verified. Previous version in bridge.backup/${check.version}/. Restart the Bridge to run the new code.`);
  })().catch((e) => {
    console.error(`Update failed safely (nothing partially applied): ${e.message}`);
    process.exit(1);
  });
} else {
  main();
}
