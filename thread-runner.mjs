/**
 * Persistent per-thread agent processes (the terminal-feel unlock, Diego 2026-08-20).
 *
 * A terminal feels instant because the process is already alive: you pay CLI boot +
 * MCP handshake once per SESSION, not once per message. This module gives Composer
 * threads the same physics: one `claude -p --input-format stream-json` process per
 * active thread, held open; each follow-up message is written to stdin and the turn
 * ends at the CLI's `result` line. Reply latency collapses to model time.
 *
 * Design walls:
 *  - claude-only (the one CLI with a streaming stdin protocol here); callers fall
 *    back to the one-shot spawn path for anything else, and on ANY runner error —
 *    the runner is an accelerator, never a dependency.
 *  - one in-flight send per runner (`busy`); concurrent sends are the caller's cue
 *    to use the one-shot path (claim serialization makes this rare).
 *  - idle runners are reaped (default 3 hours: a chat that pauses for lunch comes
 *    back to a live process, the way Buzz keeps its ACP sessions warm) and the pool
 *    is capped; every runner dies with the Bridge.
 *  - stream-parsing helpers are INJECTED (bridge.mjs dispatches on import, so this
 *    module must not import it back).
 */
import { spawn } from "node:child_process";
import { callsFromStreamLine, foldCallEvent, wireCalls } from "./live.mjs";
import { planFromStreamLine, notePlan, planLine } from "./plan.mjs";
import { which, redact, killTree } from "./hands.mjs";
import { materializeMcpConfig } from "./harden.mjs";

export const IDLE_MS = 3 * 60 * 60_000;
// A pre-warmed spare that never got a message is cheap to rebuild: it does not
// earn the long idle window a real conversation does.
export const SPARE_IDLE_MS = 15 * 60_000;
export const MAX_RUNNERS = 8;
// Live-text cadence. Deltas arrive per token now (--include-partial-messages), so
// the emit throttle is the only thing between the model and the screen.
export const TEXT_EMIT_MS = 250;
export const EVENT_EMIT_MS = 150;
const runners = new Map(); // threadRootId -> Runner

/** Build the persistent variant of a one-shot claude command: same binary and
 *  allowlist flags, minus the inline prompt, plus the streaming stdin protocol.
 *  Returns null when the command isn't claude-shaped (caller falls back). */
export function isClaudeBinary(cmd) {
  return String(cmd ?? "").split(/[\\/]/).pop().toLowerCase() === "claude";
}

export function persistentCommand(command, resumeSessionId) {
  // Compare on the basename: an absolute path (/opt/homebrew/bin/claude, the
  // desktop app's resolved binary) is just as claude-shaped as the bare name.
  if (!Array.isArray(command) || !isClaudeBinary(command[0])) return null;
  // --include-partial-messages: token deltas, not whole turns. Verified 2026-09-14 on
  // claude 2.1.272 that a session recorded with partials RESUMES cleanly (the
  // 2026-08-20 [reasoning_extraction] refusal no longer reproduces); the one-shot
  // path keeps whole-turn streaming, and any runner failure still falls back to it.
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  // Carry over safety-relevant flags from the configured command (allowlist etc.),
  // dropping prompt/format flags this protocol replaces.
  const skip = new Set(["-p", "--print", "{prompt}", "--output-format", "--input-format", "--verbose", "--include-partial-messages", "--resume"]);
  for (let i = 1; i < command.length; i++) {
    const a = command[i];
    if (a === "--output-format" || a === "--input-format" || a === "--resume") { i++; continue; }
    if (skip.has(a)) continue;
    args.push(a);
  }
  return [command[0], ...args];
}

class Runner {
  constructor({ threadId, agent, env, resumeSessionId, helpers, log, model = null }) {
    this.model = model ?? agent.model ?? null;
    this.threadId = threadId;
    this.agent = agent;
    this.helpers = helpers; // { fold, textFrom, sessionFrom }
    this.log = log;
    this.busy = false;
    this.lastUsedAt = Date.now();
    this.sessionId = resumeSessionId ?? null;
    this.dead = false;
    this.sends = 0; // 0 = still adoptable (a pre-warmed process with no history)
    const command = persistentCommand(agent.command, resumeSessionId);
    if (!command) throw new Error("not a claude-shaped command");
    // The bearer token leaves argv (harden.mjs): 0600 temp file, removed on close.
    const mat = materializeMcpConfig(command);
    this.cleanup = mat.cleanup;
    const [rawCmd, ...args] = mat.command;
    // Same resolution as the one-shot path: a bare name goes through hands.which
    // (PATHEXT-aware, knows the home-dir install spots the GUI PATH misses).
    const cmd = /[\\/]/.test(rawCmd) ? rawCmd : (which(rawCmd) ?? rawCmd);
    // Local-access agents carry a cwd (the workspace's mapped folder).
    this.child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env, ...(agent.cwd ? { cwd: agent.cwd } : {}) });
    this.lineBuf = "";
    this.err = "";
    this.turn = null; // in-flight send state
    // A write after the CLI died is an EPIPE on stdin; unhandled, it would take
    // the whole Bridge down. The close handler reports the death instead.
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("data", (d) => this.#onData(String(d)));
    this.child.stderr.on("data", (d) => { this.err = (this.err + String(d)).slice(-4000); });
    this.child.on("close", (code) => {
      this.dead = true;
      try { this.cleanup?.(); } catch { /* best effort */ }
      const t = this.turn;
      this.turn = null;
      if (t) t.reject(Object.assign(new Error(`thread runner exited (${code}): ${this.err.slice(-300)}`), { sessionId: this.sessionId }));
    });
    this.child.on("error", (e) => {
      this.dead = true;
      try { this.cleanup?.(); } catch { /* best effort */ }
      const t = this.turn;
      this.turn = null;
      if (t) t.reject(new Error(`thread runner failed to launch: ${e.message}`));
    });
  }

  #onData(chunk) {
    this.lineBuf += chunk;
    let nl;
    while ((nl = this.lineBuf.indexOf("\n")) >= 0) {
      const line = this.lineBuf.slice(0, nl).trim();
      this.lineBuf = this.lineBuf.slice(nl + 1);
      if (!line || !this.turn) continue;
      const t = this.turn;
      t.lastActivityAt = Date.now();
      if (!this.sessionId) this.sessionId = this.helpers.sessionFrom(line);
      const spoke = this.helpers.textFrom(line);
      if (spoke) {
        if (spoke.kind === "delta") t.partialText += spoke.text;
        else { t.turnsText += (t.turnsText && spoke.text ? "\n\n" : "") + spoke.text; t.partialText = ""; }
      }
      let touched = false;
      for (const ev of callsFromStreamLine(line)) { t.calls = foldCallEvent(t.calls, ev); touched = true; }
      if (t.trace) { try { t.trace.onStreamLine(line); } catch { /* evidence is best-effort */ } }
      const plan = planFromStreamLine(line);
      if (plan && notePlan(plan)) this.log?.(`  ↳ plan ${planLine(plan.vendor, plan)}`);
      if (plan) { try { this.helpers.onPlan?.(plan); } catch { /* hold bookkeeping is best-effort */ } }
      const r = this.helpers.fold(line, t.acc);
      t.acc = r.acc;
      if (r.resultLine) {
        clearInterval(t.watchdog);
        // Final flush: whatever streamed inside the last throttle window goes out
        // now, so the fast lane shows the complete answer the moment it exists.
        t.emit(true, true);
        this.turn = null;
        this.busy = false;
        this.lastUsedAt = Date.now();
        t.resolve({ code: 0, out: r.resultLine, err: "", sessionId: this.sessionId });
      } else {
        t.emit(touched);
      }
    }
  }

  /** Send one user message; resolves with a one-shot-shaped result envelope. */
  send(text, { onProgress, timeoutMs, livenessMs, trace = null }) {
    if (this.dead) return Promise.reject(new Error("thread runner is dead"));
    if (this.busy) return Promise.reject(new Error("thread runner busy"));
    this.busy = true;
    this.sends++;
    this.lastUsedAt = Date.now();
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const t = {
        resolve, reject,
        acc: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, num_turns: 0 },
        turnsText: "", partialText: "",
        calls: [], // live CALLS (bridge/live.mjs): the work log
        trace, // the Record (bridge/trace.mjs): every call with its result, or null
        lastEmit: 0, lastActivityAt: startedAt,
        // `event` = a tool call started/finished: jumps the text throttle (≥300ms).
        emit: (event = false, force = false) => {
          if (!onProgress) return;
          if (!force && Date.now() - t.lastEmit < (event ? EVENT_EMIT_MS : TEXT_EMIT_MS)) return;
          t.lastEmit = Date.now();
          const full = t.partialText ? `${t.turnsText}${t.turnsText ? "\n\n" : ""}${t.partialText}` : t.turnsText;
          const live_text = redact(full.length > 1800 ? "…" + full.slice(-1800) : full);
          if (t.acc.input_tokens === 0 && t.acc.output_tokens === 0 && !live_text && !t.calls.length) return;
          try {
            onProgress({ ...t.acc, runner: this.agent.name, ...(live_text ? { live_text } : {}), ...(t.calls.length ? { live_calls: wireCalls(t.calls) } : {}), ...(this.sessionId ? { session_ref: this.sessionId } : {}) });
          } catch { /* best-effort */ }
        },
        watchdog: setInterval(() => {
          const now = Date.now();
          const stalled = livenessMs > 0 && now - t.lastActivityAt >= livenessMs;
          const over = now - startedAt >= timeoutMs;
          if (!stalled && !over) return;
          clearInterval(t.watchdog);
          this.kill();
          const e = new Error(stalled ? `thread runner silent for ${Math.round(livenessMs / 1000)}s` : `thread runner hit the ${Math.round(timeoutMs / 1000)}s ceiling`);
          e.partialUsage = t.acc.input_tokens || t.acc.output_tokens ? { ...t.acc } : null;
          e.elapsedMs = now - startedAt;
          e.sessionId = this.sessionId;
          this.turn = null;
          reject(e);
        }, 5000),
      };
      this.turn = t;
      const msg = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
      this.child.stdin.write(msg + "\n", (err) => {
        if (err) { clearInterval(t.watchdog); this.turn = null; this.busy = false; reject(new Error(`stdin write failed: ${err.message}`)); }
      });
    });
  }

  kill() {
    this.dead = true;
    killTree(this.child, "SIGTERM");
    setTimeout(() => killTree(this.child, "SIGKILL"), 5000);
  }
}

/** The live runner for a thread, or null — never creates. */
export function hasRunner(threadId) {
  const r = runners.get(threadId);
  return r && !r.dead ? r : null;
}

/** PRE-WARM (0065): boot an idle runner under a pool key before any task exists.
 *  No-op if one is already there or the pool is full. */
export function warmUp({ poolKey, agent, env, helpers, log, cap = MAX_RUNNERS }) {
  if (hasRunner(poolKey)) return;
  if (runners.size >= cap) return;
  try {
    const r = new Runner({ threadId: poolKey, agent, env, resumeSessionId: null, helpers, log });
    runners.set(poolKey, r);
    log(`  ↳ pre-warming ${agent.name} (${poolKey.slice(0, 24)}…)`);
  } catch { /* not claude-shaped — nothing to warm */ }
}

/** Adopt a pre-warmed, never-used runner into a real thread key. Returns the runner
 *  or null (dead, busy, or already carrying a conversation — adoption would leak
 *  one thread's context into another). */
export function adoptRunner(fromKey, toKey) {
  const r = runners.get(fromKey);
  if (!r || r.dead || r.busy || r.sends > 0) return null;
  runners.delete(fromKey);
  runners.set(toKey, r);
  r.threadId = toKey;
  return r;
}

/** Get the live runner for a thread, or create one (resuming a prior session when
 *  given). Throws when the agent isn't claude-shaped; callers fall back. */
export function runnerFor({ threadId, agent, env, resumeSessionId, helpers, log, model = null }) {
  const existing = runners.get(threadId);
  const want = model ?? agent.model ?? null;
  if (existing && !existing.dead && (existing.model ?? null) === want) return existing;
  if (existing && !existing.dead) {
    // Same conversation, different model: resume the session on the new one.
    if (existing.busy) throw new Error("runner busy");
    resumeSessionId = existing.sessionId ?? resumeSessionId;
    existing.kill();
    log(`  ↳ thread runner for ${threadId.slice(0, 8)} restarted on ${want ?? "the default model"}`);
  }
  if (existing) runners.delete(threadId);
  const r = new Runner({ threadId, agent, env, resumeSessionId, helpers, log, model: want });
  runners.set(threadId, r);
  log(`  ↳ thread runner started for ${threadId.slice(0, 8)}${resumeSessionId ? " (resuming session)" : ""}`);
  return r;
}

export function reapIdleRunners(log, idleMs = IDLE_MS, max = MAX_RUNNERS) {
  const now = Date.now();
  for (const [id, r] of runners) {
    const limit = r.sends === 0 ? Math.min(idleMs, SPARE_IDLE_MS) : idleMs;
    if (r.dead || (now - r.lastUsedAt > limit && !r.busy)) {
      if (!r.dead) { r.kill(); log(`  ↳ thread runner for ${id.slice(0, 8)} reaped (idle${r.sends === 0 ? " spare" : ""})`); }
      runners.delete(id);
    }
  }
  // Pool cap: long-lived runners must not grow without bound. Least recently used
  // idle runners go first; a busy runner is never touched. Pre-warmed spares (no
  // conversation yet) are the cheapest to lose, so they go before real threads.
  if (runners.size > max) {
    const idle = [...runners.entries()].filter(([, r]) => !r.busy && !r.dead)
      .sort((a, b) => (a[1].sends === 0) === (b[1].sends === 0) ? a[1].lastUsedAt - b[1].lastUsedAt : (a[1].sends === 0 ? -1 : 1));
    for (const [id, r] of idle) {
      if (runners.size <= max) break;
      r.kill();
      runners.delete(id);
      log(`  ↳ thread runner for ${id.slice(0, 8)} reaped (pool cap ${max})`);
    }
  }
}

export function killAllRunners() {
  for (const [, r] of runners) r.kill();
  runners.clear();
}

export function runnerStats() {
  return { count: runners.size, busy: [...runners.values()].filter((r) => r.busy).length };
}
