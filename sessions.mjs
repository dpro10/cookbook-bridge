/**
 * THE SESSIONS MIRROR, Bridge side (0085) — terminal sessions into the Room,
 * with zero behavior change in the terminal.
 *
 * `sessions on` installs Claude Code hooks (SessionStart, UserPromptSubmit,
 * PostToolUse, SessionEnd) that run hook-reporter.mjs; the reporter POSTs each
 * payload to the Bridge's local listener; this module folds them into COMPACT,
 * REDACTED events (secrets stripped here, on the machine — the server never sees
 * a raw transcript) and batches them to /api/bridge/sessions. A session in a
 * folder with no workspace mapping NEVER leaves the machine.
 *
 * Reporter, not brain: no state beyond the flush queue, no policy, fails silent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "./hands.mjs";

export const SESSION_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "SessionEnd"];
export const REPORTER_BASENAME = "hook-reporter.mjs";

/** Deepest folder mapping that contains cwd, or null (drop on the floor). */
export function matchWorkspace(localWorkspaces, cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  let best = null;
  for (const [workspaceId, m] of Object.entries(localWorkspaces ?? {})) {
    const root = m?.cwd;
    if (!root || typeof root !== "string") continue;
    if (cwd === root || cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
      if (!best || root.length > best.root.length) best = { workspaceId, root };
    }
  }
  return best;
}

/** "~/Desktop/Cookbook/app" — display-safe, home collapsed. */
export function displayFolder(root, home = os.homedir()) {
  const p = String(root ?? "");
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function fileOf(toolInput, root) {
  const p = toolInput && typeof toolInput === "object"
    ? (toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? null)
    : null;
  if (typeof p !== "string" || !p) return null;
  const rel = root && p.startsWith(root) ? p.slice(root.length).replace(/^\/+/, "") : p;
  return redact(rel).slice(0, 160);
}

const CALL_VERB = { Read: "reading", Write: "writing", Edit: "editing", Bash: "running", Grep: "searching", Glob: "searching", Task: "delegating", WebFetch: "fetching", WebSearch: "searching" };

/** Raw hook payload → the compact event that may leave the machine, or null. */
export function compactEvent(raw, mapping, home = os.homedir()) {
  if (!raw || typeof raw !== "object" || !mapping) return null;
  const sessionRef = String(raw.session_id ?? "").slice(0, 120);
  if (!sessionRef) return null;
  const base = {
    workspace_id: mapping.workspaceId,
    session_ref: sessionRef,
    agent: "Claude Code",
    folder: displayFolder(mapping.root, home),
    at: new Date().toISOString(),
  };
  const kind = String(raw.hook_event_name ?? "");
  if (kind === "SessionStart") return { ...base, event: "start" };
  if (kind === "UserPromptSubmit") {
    return { ...base, event: "prompt", prompt: redact(String(raw.prompt ?? "")).slice(0, 300) };
  }
  if (kind === "PostToolUse") {
    const tool = String(raw.tool_name ?? "tool").slice(0, 60);
    const file = fileOf(raw.tool_input, mapping.root);
    const verb = CALL_VERB[tool] ?? tool.toLowerCase();
    return { ...base, event: "call", call: `${verb}${file ? ` ${file}` : ""}`.slice(0, 160), ...(file ? { file } : {}) };
  }
  if (kind === "SessionEnd") return { ...base, event: "end" };
  return null; // unknown hook kinds never leave the machine
}

const FLUSH_MS = 1500;
const MAX_QUEUE = 100; // matches the server-side batch cap (audit F10)

/** The batcher: hold events briefly, ship them on the authenticated lane. */
export function createSessionReporter({ cfg, log = () => {}, fetchImpl = fetch }) {
  let queue = [];
  let timer = null;
  let lastErrAt = 0;
  async function flush() {
    timer = null;
    if (queue.length === 0) return;
    const events = queue.splice(0, MAX_QUEUE);
    try {
      const res = await fetchImpl(`${cfg.cookbookUrl}/api/bridge/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ events }),
      });
      if (!res.ok && res.status !== 404) throw new Error(`sessions ${res.status}`);
    } catch (e) {
      if (Date.now() - lastErrAt > 60_000) { lastErrAt = Date.now(); log(`! session mirror: ${e.message} (queued work is dropped; the terminal is unaffected)`); }
    }
  }
  return {
    onEvent(raw) {
      try {
        const mapping = matchWorkspace(cfg.localWorkspaces ?? {}, raw?.cwd);
        if (!mapping) return; // unmapped folder: nothing leaves the machine
        const ev = compactEvent(raw, mapping);
        if (!ev) return;
        if (queue.length >= MAX_QUEUE) queue.shift();
        queue.push(ev);
        if (!timer) timer = setTimeout(() => { void flush(); }, FLUSH_MS);
      } catch { /* the mirror must never throw into the caller */ }
    },
    flush,
    stop() { if (timer) { clearTimeout(timer); timer = null; } queue = []; },
  };
}

// ── hooks install/remove (pure merge logic, tested) ──────────────────────────

/** Is this hook entry ours? Matched by the reporter's basename in the command. */
export function isOurHook(entry) {
  const cmds = (entry?.hooks ?? []).map((h) => String(h?.command ?? ""));
  return cmds.length > 0 && cmds.every((c) => c.includes(REPORTER_BASENAME));
}

/** Add our reporter to the hook events, APPENDING next to whatever exists. */
export function hooksWithReporter(existingHooks, command) {
  const out = { ...(existingHooks ?? {}) };
  for (const event of SESSION_HOOK_EVENTS) {
    const entries = Array.isArray(out[event]) ? out[event].filter((e) => !isOurHook(e)) : [];
    entries.push({ hooks: [{ type: "command", command }] });
    out[event] = entries;
  }
  return out;
}

/** Remove ONLY our entries; everything else byte-identical. */
export function hooksWithoutReporter(existingHooks) {
  const out = {};
  for (const [event, entries] of Object.entries(existingHooks ?? {})) {
    const kept = Array.isArray(entries) ? entries.filter((e) => !isOurHook(e)) : entries;
    if (Array.isArray(kept) ? kept.length > 0 : kept) out[event] = kept;
  }
  return out;
}

/** The CLI: `cookbook-bridge sessions on|off|status`. */
export async function sessionsCli(args, { here, home = os.homedir(), log = console.log }) {
  const mode = args.find((a) => ["on", "off", "status"].includes(a)) ?? "status";
  const settingsPath = path.join(home, ".claude", "settings.json");
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch (e) {
    if (fs.existsSync(settingsPath)) { log(`✗ ${settingsPath} isn't valid JSON — fix it first (nothing was touched).`); process.exit(1); }
  }
  const installed = Object.values(settings.hooks ?? {}).some((entries) => (entries ?? []).some?.((e) => isOurHook(e)));

  if (mode === "status") {
    log(installed ? "Sessions mirror: ON (hooks installed in ~/.claude/settings.json)" : "Sessions mirror: off. `cookbook-bridge sessions on` installs the hooks.");
    return;
  }
  if (mode === "off") {
    settings.hooks = hooksWithoutReporter(settings.hooks);
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    log("Sessions mirror OFF — Cookbook's hooks removed; your other hooks are untouched.");
    return;
  }
  // on: copy the reporter somewhere stable, point the hooks at it + this install's local.json
  const destDir = path.join(home, ".cookbook");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, REPORTER_BASENAME);
  fs.copyFileSync(path.join(here, REPORTER_BASENAME), dest);
  const cfgDirArgIdx = args.indexOf("--config");
  const cfgPath = cfgDirArgIdx >= 0 && args[cfgDirArgIdx + 1] ? path.resolve(args[cfgDirArgIdx + 1]) : path.join(here, "config.json");
  const localJsonPath = path.join(path.dirname(cfgPath), "local.json");
  const command = `"${process.execPath}" "${dest}" "${localJsonPath}"`;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  settings.hooks = hooksWithReporter(settings.hooks, command);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  log("Sessions mirror ON.");
  log(`  hooks → ${settingsPath} (appended; your existing hooks are untouched)`);
  log(`  reporter → ${dest}`);
  log("  Claude Code sessions in folders mapped to a workspace now appear in that workspace's Room.");
  log("  Unmapped folders never leave this machine. `cookbook-bridge sessions off` removes it.");
}
