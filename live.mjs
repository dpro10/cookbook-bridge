/**
 * LIVE CALLS — "show the work, not just the words" (Diego, 2026-08-26).
 *
 * The Bridge already streams what an agent is SAYING (live_text). This streams what
 * it is DOING: every tool call, as a short human line — `read_file notes/plan.md`,
 * `bash npm test`, `search "canvas ics feed"` — with a running/ok/err state. The
 * thread shows it as a work log, the stage shows the current line, the chat
 * sidebar shows it under the conversation. Same progress tick, one more field.
 *
 * Pure parsers over the vendors' own streams (no network, no fs) so they're
 * testable: claude stream-json (`tool_use` / `tool_result` blocks), gemini
 * stream-json (`tool_use` / `tool_result` events), codex app-server item
 * notifications (`item/started` / `item/completed`).
 *
 * Shape on the wire (progress.live_calls, ≤ LIVE_CALLS_CAP entries, oldest first):
 *   { n: "read_file", a: "notes/plan.md", s: "run" | "ok" | "err", at: <epoch ms> }
 * The server re-validates every field (src/lib/workspaces/live-calls.ts).
 */

import os from "node:os";
import { redact } from "./hands.mjs";

export const LIVE_CALLS_CAP = 12;
const NAME_CAP = 60;
const ARG_CAP = 120;

/** Claude Code's built-in tools → the verb a teammate would say. MCP tools keep their
 *  own name (`read_file`); other servers' tools are prefixed (`github:create_issue`). */
const BUILTIN = {
  read: "read", edit: "edit", multiedit: "edit", write: "write", notebookedit: "edit",
  bash: "bash", grep: "grep", glob: "glob", ls: "ls",
  webfetch: "fetch", websearch: "search", task: "agent", todowrite: "todo",
  // gemini-cli built-ins
  read_file: "read", write_file: "write", replace: "edit", run_shell_command: "bash",
  list_directory: "ls", search_file_content: "grep", glob_files: "glob", web_fetch: "fetch", google_web_search: "search",
};

/** Harness plumbing nobody wants in a work log (Claude Code loads deferred tool
 *  schemas through ToolSearch before the real call). */
const SKIP = new Set(["toolsearch"]);

export function shortTool(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "tool";
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(raw);
  if (m) {
    const server = m[1].toLowerCase();
    const tool = m[2];
    return (server === "cookbook" ? tool : `${server}:${tool}`).slice(0, NAME_CAP);
  }
  const key = raw.toLowerCase();
  if (BUILTIN[key]) return BUILTIN[key];
  return raw.slice(0, NAME_CAP);
}

const ARG_KEYS = [
  "path", "file_path", "filePath", "notebook_path", "absolute_path", "dir_path", "directory",
  "command", "cmd", "query", "pattern", "url", "title", "verb", "name", "folder", "from", "to", "src", "dest",
  "description", "prompt",
];

/** One short, safe argument for the line. Paths and commands are what people want to
 *  see; ids and prose are last resort. Whitespace collapsed, capped. */
export function argFor(input) {
  if (input == null) return "";
  if (typeof input === "string") return clip(input);
  if (typeof input !== "object") return clip(String(input));
  for (const k of ARG_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return clip(v);
    if (Array.isArray(v) && v.length && typeof v[0] === "string") return clip(v.slice(0, 3).join(", "));
  }
  return "";
}

function clip(s) {
  // Redact FIRST: a `curl -H "Authorization: Bearer …"` or an exported key must never
  // reach the work log (every viewer of the thread sees it, and it persists).
  const one = redact(String(s).replace(/\s+/g, " ").trim(), { home: os.homedir() });
  return one.length > ARG_CAP ? one.slice(0, ARG_CAP - 1) + "…" : one;
}

/**
 * Pull tool events out of one stream-json line. Returns an array (a claude turn can
 * carry several tool_use blocks; a user line several tool_results), empty when the
 * line is prose/usage/init. Event: {kind:'call', id, name, arg} | {kind:'result', id, err}.
 */
export function callsFromStreamLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return []; }
  if (!j || typeof j !== "object") return [];
  const out = [];
  // claude stream-json: assistant turn with tool_use blocks / user turn with tool_result blocks
  if ((j.type === "assistant" || j.type === "user") && Array.isArray(j.message?.content)) {
    for (const b of j.message.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use") {
        if (SKIP.has(String(b.name ?? "").toLowerCase())) continue;
        out.push({ kind: "call", id: String(b.id ?? ""), name: shortTool(b.name), arg: argFor(b.input) });
      } else if (b.type === "tool_result") out.push({ kind: "result", id: String(b.tool_use_id ?? ""), err: b.is_error === true });
    }
    return out;
  }
  // gemini stream-json: flat tool_use / tool_result events
  if (j.type === "tool_use" && (j.tool_name || j.name)) {
    out.push({ kind: "call", id: String(j.tool_id ?? j.id ?? ""), name: shortTool(j.tool_name ?? j.name), arg: argFor(j.parameters ?? j.input) });
  } else if (j.type === "tool_result") {
    const st = String(j.status ?? "").toLowerCase();
    out.push({ kind: "result", id: String(j.tool_id ?? j.tool_use_id ?? ""), err: st === "error" || st === "failed" || j.is_error === true });
  }
  return out;
}

/**
 * Codex app-server: `item/started` + `item/completed` notifications carry a typed
 * item. Defensive about naming (camel/snake, slash/dot) — the protocol is young.
 * Returns one event or null.
 */
export function codexCallEvent(method, params) {
  const meth = String(method ?? "");
  const started = /item[/.]started$/.test(meth);
  const completed = /item[/.]completed$/.test(meth);
  if (!started && !completed) return null;
  const item = params?.item;
  if (!item || typeof item !== "object") return null;
  const type = String(item.type ?? item.item_type ?? "").replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const id = String(item.id ?? "");
  let name = null;
  let arg = "";
  if (type === "commandExecution") { name = "bash"; arg = argFor(item.command ?? item.cmd); }
  else if (type === "fileChange") {
    name = "edit";
    const ch = Array.isArray(item.changes) ? item.changes : [];
    arg = clip(ch.map((c) => c?.path).filter(Boolean).slice(0, 3).join(", "));
  }
  else if (type === "mcpToolCall") {
    const server = String(item.server ?? "").toLowerCase();
    const tool = String(item.tool ?? item.name ?? "tool");
    name = server && server !== "cookbook" ? `${server}:${tool}`.slice(0, NAME_CAP) : tool.slice(0, NAME_CAP);
    arg = argFor(item.arguments ?? item.input ?? item.params);
  }
  else if (type === "webSearch") { name = "search"; arg = argFor(item.query ?? item); }
  else return null; // agentMessage, reasoning, etc. are not calls
  if (started) return { kind: "call", id, name, arg };
  const st = String(item.status ?? "").toLowerCase();
  const err = st === "failed" || st === "error" || st === "declined" || (typeof item.exit_code === "number" && item.exit_code !== 0) || (typeof item.exitCode === "number" && item.exitCode !== 0);
  return { kind: "result", id, err };
}

/**
 * Fold one event into the running list (pure; returns a new array). A result closes
 * the matching call by id — or, when the vendor gave no id, the oldest still-running
 * one. Capped to the newest LIVE_CALLS_CAP so the tick stays small.
 */
export function foldCallEvent(list, ev, now = Date.now()) {
  const cur = Array.isArray(list) ? list : [];
  if (!ev) return cur;
  if (ev.kind === "call") {
    if (ev.id && cur.some((c) => c.id === ev.id)) return cur; // vendor re-emitted the same call
    const next = [...cur, { id: ev.id || "", n: ev.name, a: ev.arg || "", s: "run", at: now }];
    return next.length > LIVE_CALLS_CAP ? next.slice(next.length - LIVE_CALLS_CAP) : next;
  }
  if (ev.kind === "result") {
    // Close by id; fall back to the oldest running call ONLY for id-less vendors.
    // A known-but-unmatched id (e.g. a skipped ToolSearch) must not close a peer.
    let i = ev.id ? cur.findIndex((c) => c.id === ev.id && c.s === "run") : -1;
    if (i < 0 && !ev.id) i = cur.findIndex((c) => c.s === "run");
    if (i < 0) return cur;
    const next = cur.slice();
    next[i] = { ...next[i], s: ev.err ? "err" : "ok" };
    return next;
  }
  return cur;
}

/** Wire shape: drop the vendor id, keep what the UI renders. */
export function wireCalls(list) {
  return (Array.isArray(list) ? list : []).map((c) => ({ n: c.n, ...(c.a ? { a: c.a } : {}), s: c.s, at: c.at }));
}
