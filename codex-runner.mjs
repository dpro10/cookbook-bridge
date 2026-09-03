/**
 * Codex runner — drives OpenAI's Codex CLI autonomously with FULL Cookbook MCP.
 *
 * Why app-server: `codex exec` auto-cancels every MCP tool call in headless mode
 * (OpenAI bug #16685 — closed stdin reads as "user declined"). The app-server
 * JSON-RPC interface answers approvals explicitly, so tools work.
 *
 * v2 (chat lane, 2026-08-21): the server is now PERSISTENT — one process, one
 * handshake, reused across turns — and Cookbook threads map to Codex threads, so
 * a follow-up turn CONTINUES the same Codex conversation (claude-resume parity).
 * Agent-message deltas stream out via onProgress as live_text. Codex Perplexity
 * lane: boot once, then every turn is model time.
 *
 * SECURITY UNCHANGED from v1 (audit 2026-07-03): elicitations/input requests are
 * accepted (that's what lets MCP tools run), but exec/patch APPROVALS are always
 * DECLINED — with approvalPolicy "never" those only arrive as requests to escalate
 * beyond the sandbox, and the sandbox is the boundary only if we never approve
 * leaving it.
 *
 * Node built-ins only.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { codexCallEvent, foldCallEvent, wireCalls } from "./live.mjs";
import { planFromCodexRateLimits, notePlan, planLine } from "./plan.mjs";
import { redact, killTree } from "./hands.mjs";

const IDLE_MS = 15 * 60_000;
const LIVE_TEXT_CAP = 1800;
// A server that never answers `initialize` (wrong binary, no login, a hung
// launch) used to hold every turn forever; the turn itself has a watchdog but
// `await this.ready` sat in front of it. Bounded now: 30s to say hello, 60s for
// any other request (turn/start acknowledges quickly; the work streams as
// notifications and is governed by the turn's own timeout).
export const INIT_TIMEOUT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 60_000;

let server = null; // one persistent app-server per Bridge
const codexThreads = new Map(); // cookbook threadKey -> codex threadId

/** Does a live Codex conversation exist for this Cookbook thread? (Prompt shaping:
 *  resumed follow-ups skip the cold baton.) */
export function hasCodexThread(threadKey) {
  return !!(server && !server.dead && codexThreads.has(threadKey));
}

export function killCodexServer() {
  if (server) {
    server.kill();
    server = null;
  }
  codexThreads.clear();
}

/** Reap the server after idleness (call from the Bridge's janitor tick). */
export function reapCodexServer(log) {
  if (server && !server.dead && !server.turn && Date.now() - server.lastUsedAt > IDLE_MS) {
    log?.("  ↳ codex app-server reaped (idle)");
    killCodexServer();
  }
}

class CodexServer {
  constructor(agent, env, log) {
    const codexBin = (agent.command && agent.command[0]) || "codex";
    const codexHome = agent.codexHome || path.join(os.homedir(), ".codex-bridge");
    this.cwd = path.join(os.tmpdir(), "codex-bridge-work");
    try { fs.mkdirSync(this.cwd, { recursive: true }); } catch { /* best effort */ }
    this.agent = agent;
    this.log = log;
    this.dead = false;
    this.turn = null; // the single in-flight turn's handlers
    this.queue = Promise.resolve(); // turns serialize on this chain
    this.nextId = 10;
    this.pending = new Map(); // request id -> {resolve, reject}
    this.lastUsedAt = Date.now();
    this.buf = "";
    this.child = spawn(codexBin, ["app-server"], { env: { ...env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {}); // EPIPE after the server died: #die reports it
    this.child.stderr.on("data", () => {});
    this.child.on("error", (e) => this.#die(new Error(`could not launch \`${codexBin} app-server\`: ${e.message}`)));
    this.child.on("close", () => this.#die(new Error("codex app-server exited")));
    this.child.stdout.on("data", (d) => this.#onData(String(d)));
    // Handshake once for the process lifetime.
    this.ready = this.request("initialize", {
      clientInfo: { name: "cookbook-bridge", title: "Cookbook Bridge", version: "0.2.0" },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    }, INIT_TIMEOUT_MS).then(() => {
      this.notify("initialized");
      // Where the member's ChatGPT plan stands (5h + weekly windows). Best effort:
      // an older app-server without the method just doesn't report (bridge/plan.mjs).
      this.request("account/rateLimits/read", {})
        .then((res) => { const p = planFromCodexRateLimits(res); if (p && notePlan(p)) this.log?.(`  ↳ plan ${planLine(p.vendor, p)}`); })
        .catch(() => {});
    });
  }

  #die(err) {
    if (this.dead) return;
    this.dead = true;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    const t = this.turn;
    this.turn = null;
    if (t) t.reject(err);
  }

  kill() {
    this.dead = true;
    killTree(this.child, "SIGTERM");
    setTimeout(() => killTree(this.child, "SIGKILL"), 3000);
  }

  send(o) {
    try { this.child.stdin.write(JSON.stringify(o) + "\n"); } catch { /* closed */ }
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const err = new Error(`codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`);
        if (method === "initialize") { this.kill(); this.#die(err); }
        reject(err);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const meth = m.method || "";

      // Server→client REQUESTS (id + method): tool elicitations accepted, sandbox
      // escalation approvals DECLINED — see header; semantics identical to v1.
      if (m.id !== undefined && meth) {
        if (/elicitation\/request$/.test(meth)) this.send({ id: m.id, result: { action: "accept" } });
        else if (/requestUserInput$/.test(meth)) this.send({ id: m.id, result: { answers: [{ value: "accept" }] } });
        else if (/requestApproval$|Approval$/.test(meth)) this.send({ id: m.id, result: "decline" });
        continue;
      }

      // RESPONSES to our requests.
      if (m.id !== undefined && (m.result !== undefined || m.error)) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(`codex app-server error: ${m.error.message || JSON.stringify(m.error).slice(0, 200)}`));
          else p.resolve(m.result);
        }
        continue;
      }

      // Plan windows move as turns burn quota; the app-server pushes the new snapshot.
      if (/account\/rateLimits\/updated$/.test(meth)) {
        const p = planFromCodexRateLimits(m.params);
        if (p && notePlan(p)) this.log?.(`  ↳ plan ${planLine(p.vendor, p)}`);
      }

      // NOTIFICATIONS — routed to the single in-flight turn.
      const t = this.turn;
      if (!t) continue;
      t.lastActivityAt = Date.now();
      if (meth === "item/agentMessage/delta" && m.params && m.params.delta) {
        t.text += m.params.delta;
        t.emit();
      }
      const callEv = codexCallEvent(meth, m.params);
      if (callEv) { t.calls = foldCallEvent(t.calls, callEv); t.emit(true); }
      if (m.params) {
        const u = m.params.usage ?? m.params.tokenUsage ?? m.params.token_usage ?? (m.params.turn && m.params.turn.usage);
        if (u && typeof u === "object") t.usage = u;
      }
      if (meth === "turn/completed" || meth === "turn/failed") {
        const status = (m.params && m.params.turn && m.params.turn.status) || meth;
        this.turn = null;
        this.lastUsedAt = Date.now();
        clearInterval(t.watchdog);
        t.resolve({ status, out: t.text.trim(), usage: t.usage });
      }
    }
  }

  /** Run one turn (serialized). threadKey maps to a persistent Codex thread —
   *  reused when known, created otherwise. */
  runTurn({ threadKey, prompt, timeoutSeconds, onProgress, cwd, model }) {
    const exec = async () => {
      if (this.dead) throw new Error("codex app-server is dead");
      await this.ready;
      // A model is fixed per Codex thread: a different one gets its own thread.
      const mapKey = model ? `${threadKey}::${model}` : threadKey;
      let threadId = codexThreads.get(mapKey);
      if (!threadId) {
        // Per-THREAD cwd: local-access threads live in the mapped folder (the
        // workspace-write sandbox is the wall); jailed threads use the tmp dir.
        const r = await this.request("thread/start", {
          cwd: cwd || this.cwd,
          sandbox: this.agent.sandbox || "workspace-write",
          approvalPolicy: "never",
          ...(model ? { model } : {}),
        });
        threadId = r && r.thread && r.thread.id;
        if (!threadId) throw new Error("codex app-server: thread/start returned no thread id");
        codexThreads.set(mapKey, threadId);
        if (model) this.log?.(`  ↳ model: ${model}`);
      } else {
        this.log?.(`  ↳ continuing the codex conversation (thread reuse)`);
      }
      return await new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const t = {
          resolve, reject,
          text: "", usage: null, calls: [],
          lastEmit: 0, lastActivityAt: startedAt,
          // `event` = a tool call started/finished: jumps the text throttle (≥300ms).
          emit: (event = false) => {
            if (!onProgress || Date.now() - t.lastEmit < (event ? 300 : 1200)) return;
            t.lastEmit = Date.now();
            const tail = t.text.length > LIVE_TEXT_CAP ? "…" + t.text.slice(-LIVE_TEXT_CAP) : t.text;
            try { onProgress({ input_tokens: 0, output_tokens: 0, runner: this.agent.name, ...(tail ? { live_text: redact(tail) } : {}), ...(t.calls.length ? { live_calls: wireCalls(t.calls) } : {}) }); } catch { /* best-effort */ }
          },
          watchdog: setInterval(() => {
            if (Date.now() - startedAt < timeoutSeconds * 1000) return;
            clearInterval(t.watchdog);
            if (this.turn === t) this.turn = null;
            reject(new Error(`timed out after ${timeoutSeconds}s`));
          }, 5000),
        };
        this.turn = t;
        this.request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
        }).catch((e) => {
          clearInterval(t.watchdog);
          if (this.turn === t) this.turn = null;
          reject(e);
        });
      });
    };
    // Serialize turns; a failed turn must not break the chain for the next one.
    const run = this.queue.then(exec, exec);
    this.queue = run.catch(() => {});
    return run;
  }
}

/**
 * Run a Codex turn against the persistent server (booted on first use, kept warm).
 * Signature kept close to v1's runCodexTask; extra opts carry the thread key and
 * the live-progress sink. Falls back to a fresh server if the old one died.
 */
export function runCodexTask(agent, prompt, timeoutSeconds, token, baseEnv, onProgress, opts = {}) {
  const env = { ...(baseEnv ?? process.env) };
  if (token) env.COOKBOOK_CODEX_TOKEN = token;
  if (!server || server.dead) {
    // Codex thread ids belong to the process that minted them: a replacement
    // server would answer "unknown thread" for every mapped key, so start clean.
    if (server) codexThreads.clear();
    server = new CodexServer(agent, env, opts.log);
    server.ready.catch(() => {}); // surfaced per turn by `await this.ready`
  }
  return server.runTurn({
    threadKey: opts.threadKey ?? `oneshot::${Date.now()}`,
    prompt,
    timeoutSeconds,
    onProgress,
    cwd: agent.cwd,
    model: opts.model ?? null,
  });
}
