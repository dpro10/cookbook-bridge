/**
 * THE TRACE (the Record, J1, 2026-09-17). Pure module: no imports from bridge.mjs.
 *
 * The live lane keeps the last 12 tool calls as one-line verbs so people can watch
 * a run. The trace keeps EVERY tool call of a run with its input and its result,
 * bounded and redacted, so the run can later be replayed, graded, exported and
 * trained on. It is the evidence behind the receipt.
 *
 * What it records per call: the vendor's call id, the short tool name, the full
 * input (JSON, capped), the result text (capped), ok or error, and when it
 * started and ended. What it records per run rides in the envelope (trace
 * envelope()): the prompt version, the model and config, the memory recalled,
 * the resume handle, the stages, the outcome, and explicit truncation markers so
 * a reader never mistakes a cut log for a complete one.
 *
 * Every string passes through the hands redactor first (tokens, keys, home paths),
 * and credential-shaped JSON keys are masked whatever their value looks like: a
 * trace persists and every member of the workspace can read it. One trace per
 * task: a task re-run after an abandon keeps the last run's trace.
 */
import os from "node:os";
import { redact, redactDeep } from "./hands.mjs";
import { shortTool } from "./live.mjs";

export const TRACE_VERSION = 1;
/** Calls kept per run; beyond this the OLDEST are dropped and `dropped` counts them. */
export const TRACE_CALLS_CAP = 400;
export const INPUT_CAP = 2_000;
export const RESULT_CAP = 4_000;
/** The wire body must stay under the server's 1 MB reader with room to spare. */
export const TRACE_BYTES_CAP = 900_000;

const SKIP = new Set(["toolsearch"]);

/**
 * Redact, then clip. Structured values are redacted LEAF BY LEAF (redactDeep) and
 * then serialized: the text redactor's JSON-key rule masks any key that contains
 * "pat" or "key", which would turn every `"path": …` into [redacted] and leave
 * the trace without the one thing a replay needs. A string that happens to be
 * JSON gets the same treatment.
 */
function clipText(s, cap, home) {
  const one = redactValue(s, cap, home);
  return one.length > cap ? { text: one.slice(0, cap - 1) + "…", cut: true } : { text: one, cut: false };
}

/** A JSON key whose VALUE is a credential whatever it looks like. `path`, `pathname`
 *  and friends are exempt: the text redactor's key rule catches "pat" inside them. */
const SECRET_KEY = /(token|secret|password|passwd|credential|client[_-]?secret|authorization|bearer|cookie|session[_-]?(id|key|token)|api[_-]?key|access[_-]?key|private[_-]?key|refresh|signature)/i;
const PATHY_KEY = /path|pattern/i;
export const MASK = "[redacted]";

/** Mask credential-shaped KEYS before leaf redaction: redactDeep sees values without
 *  their keys, so an opaque token under `api_key` would otherwise pass. Pure. */
export function maskSecretKeys(v) {
  if (Array.isArray(v)) return v.map(maskSecretKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SECRET_KEY.test(k) && !PATHY_KEY.test(k) && val != null && val !== "" ? MASK : maskSecretKeys(val);
    }
    return out;
  }
  return v;
}

/** Cut string leaves before the regexes run: a multi-megabyte Write input must not
 *  cost twenty regex passes in the stream loop. Prefix-shaped secrets still match at a cut. */
function preclip(v, max) {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) : v;
  if (Array.isArray(v)) return v.map((x) => preclip(x, max));
  if (v && typeof v === "object") { const out = {}; for (const [k, val] of Object.entries(v)) out[k] = preclip(val, max); return out; }
  return v;
}

function redactValue(v, cap, home) {
  if (v == null) return "";
  const max = cap * 4;
  if (typeof v === "object") {
    try { return JSON.stringify(redactDeep(maskSecretKeys(preclip(v, max)), { home })); } catch { return redact(String(v).slice(0, max), { home }); }
  }
  const text = String(v).length > max ? String(v).slice(0, max) : String(v);
  const t = text.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try { return JSON.stringify(redactDeep(maskSecretKeys(JSON.parse(t)), { home })); } catch { /* not JSON: plain text below */ }
  }
  return redact(text, { home });
}

/** Inputs stay structured until redaction; strings stay strings. Pure. */
function inputText(input) {
  return input;
}

/** The text of a tool result as the vendor gave it: a string, or content blocks. Pure. */
export function resultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : b && typeof b === "object" ? (typeof b.text === "string" ? b.text : b.type === "image" ? "[image]" : "") : "")).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.output === "string") return content.output;
    try { return JSON.stringify(content); } catch { return ""; }
  }
  return String(content);
}

/** One run's collector. Feed it the vendor's own events; read `finish()` at the end. */
export function createTrace({ home = os.homedir() } = {}) {
  const calls = [];
  const open = new Map(); // vendor call id -> call (still running)
  let dropped = 0;
  let cut = 0; // strings clipped to a cap

  function push(id, name, input, at) {
    if (SKIP.has(String(name ?? "").toLowerCase())) return null;
    const vid = String(id ?? "");
    if (vid && open.has(vid)) return open.get(vid); // re-emitted
    const inp = clipText(inputText(input), INPUT_CAP, home);
    if (inp.cut) cut++;
    const call = { id: vid, n: shortTool(name), input: inp.text, result: "", ok: null, at, ended: null };
    calls.push(call);
    if (vid) open.set(vid, call);
    if (calls.length > TRACE_CALLS_CAP) {
      const gone = calls.shift();
      if (gone?.id) open.delete(gone.id);
      dropped++;
    }
    return call;
  }

  function close(id, content, err, at) {
    const vid = String(id ?? "");
    let call = vid ? open.get(vid) : null;
    // An id-less vendor closes the oldest still-open call, like the live lane.
    if (!call && !vid) call = calls.find((c) => c.ok === null) ?? null;
    if (!call) return;
    const res = clipText(resultText(content), RESULT_CAP, home);
    if (res.cut) cut++;
    call.result = res.text;
    call.ok = !err;
    call.ended = at;
    if (call.id) open.delete(call.id);
  }

  return {
    /** claude / gemini stream-json: tool_use (full input) and tool_result (content). */
    onStreamLine(line, now = Date.now()) {
      let j;
      try { j = JSON.parse(line); } catch { return; }
      if (!j || typeof j !== "object") return;
      if ((j.type === "assistant" || j.type === "user") && Array.isArray(j.message?.content)) {
        for (const b of j.message.content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "tool_use") push(b.id, b.name, b.input, now);
          else if (b.type === "tool_result") close(b.tool_use_id, b.content, b.is_error === true, now);
        }
        return;
      }
      if (j.type === "tool_use" && (j.tool_name || j.name)) push(j.tool_id ?? j.id, j.tool_name ?? j.name, j.parameters ?? j.input, now);
      else if (j.type === "tool_result") {
        const st = String(j.status ?? "").toLowerCase();
        close(j.tool_id ?? j.tool_use_id, j.output ?? j.content ?? j.result, st === "error" || st === "failed" || j.is_error === true, now);
      }
    },
    /** kimi: the events harden.mjs kimiFromLine already parsed ({calls:[…]} with full input). */
    onKimiEvent(kev, now = Date.now()) {
      for (const c of kev?.calls ?? []) {
        if (c.kind === "call") push(c.id, c.name, c.input, now);
        else if (c.kind === "result") close(c.id, c.content ?? "", !!c.err, now);
      }
    },
    /** codex app-server: item/started opens, item/completed closes with the item's output. */
    onCodexEvent(method, params, now = Date.now()) {
      const meth = String(method ?? "");
      const started = /item[/.]started$/.test(meth);
      const completed = /item[/.]completed$/.test(meth);
      if (!started && !completed) return;
      const item = params?.item;
      if (!item || typeof item !== "object") return;
      const type = String(item.type ?? item.item_type ?? "").replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const id = String(item.id ?? "");
      let name = null, input = null;
      if (type === "commandExecution") { name = "bash"; input = item.command ?? item.cmd ?? ""; }
      else if (type === "fileChange") { name = "edit"; input = (Array.isArray(item.changes) ? item.changes : []).map((c) => c?.path).filter(Boolean); }
      else if (type === "mcpToolCall") {
        // Spelled the way claude spells an MCP tool, so shortTool keeps the tool's own
        // name ("read_file") instead of reading it as a gemini built-in ("read").
        const server = String(item.server ?? "cookbook").toLowerCase() || "cookbook";
        const tool = String(item.tool ?? item.name ?? "tool");
        name = `mcp__${server}__${tool}`;
        input = item.arguments ?? item.input ?? item.params ?? null;
      }
      else if (type === "webSearch") { name = "search"; input = item.query ?? ""; }
      else return;
      if (started) { push(id, name, input, now); return; }
      const st = String(item.status ?? "").toLowerCase();
      const err = st === "failed" || st === "error" || st === "declined" || (typeof item.exit_code === "number" && item.exit_code !== 0) || (typeof item.exitCode === "number" && item.exitCode !== 0);
      const out = item.aggregated_output ?? item.aggregatedOutput ?? item.output ?? item.result ?? item.stdout ?? "";
      if (!open.has(id) && id) push(id, name, input, now); // completed without a started
      close(id, out, err, now);
    },
    /** The bounded, redacted record. Never throws. */
    finish() {
      // Anything still open when the run ended never returned: say so.
      for (const c of calls) if (c.ok === null) { c.ok = false; c.result = c.result || "(no result before the run ended)"; }
      let body = calls;
      let trimmed = 0;
      let bytes = JSON.stringify(body).length;
      while (bytes > TRACE_BYTES_CAP && body.length > 1) {
        body = body.slice(Math.ceil(body.length / 4));
        trimmed = calls.length - body.length;
        bytes = JSON.stringify(body).length;
      }
      return {
        version: TRACE_VERSION,
        calls: body,
        bytes,
        truncated: { dropped: dropped + trimmed, clipped: cut, complete: dropped + trimmed === 0 },
      };
    },
  };
}

/**
 * The wire body for POST /api/bridge/trace. Everything a replay or a grader needs
 * to know about the run's conditions, plus the calls. Pure.
 */
export function traceEnvelope({ workspaceId, taskId, outcome, agent, cfg, model, promptVersion, bridgeVersion, recalled, crossRecalled, resume, chat, stages, localMeta, trace, home = os.homedir() }) {
  const cwd = localMeta?.cwd ?? agent?.cwd ?? null;
  return {
    version: TRACE_VERSION,
    workspace_id: workspaceId,
    task_id: taskId,
    outcome: String(outcome ?? "unknown").slice(0, 20),
    agent: {
      name: String(agent?.name ?? "").slice(0, 80),
      vendor: String(agent?.runner === "app-server" ? "codex" : agent?.vendor ?? vendorOf(agent?.command)).slice(0, 20),
      model: model ? String(model).slice(0, 80) : null,
    },
    config: {
      cwd: cwd ? redact(String(cwd), { home }).slice(0, 300) : null,
      mode: localMeta?.mode ?? null,
      allowed_tools: agent?.allowedTools ? String(agent.allowedTools).slice(0, 500) : null,
      pinned: !!cfg?.pinMcp,
      persistent: !!cfg?.persistentThreads,
    },
    prompt_version: String(promptVersion ?? "").slice(0, 40),
    bridge_version: String(bridgeVersion ?? "").slice(0, 20),
    recalled: (recalled ?? []).filter((x) => typeof x === "string").slice(0, 64),
    cross_recalled: (crossRecalled ?? []).filter((x) => typeof x === "string").slice(0, 16),
    resume: { session_ref: resume?.sessionId ? String(resume.sessionId).slice(0, 120) : null, resumed: !!resume?.sessionId },
    chat: !!chat,
    stages: stages && typeof stages === "object" ? stages : {},
    trace: trace ?? { version: TRACE_VERSION, calls: [], bytes: 0, truncated: { dropped: 0, clipped: 0, complete: true } },
  };
}

function vendorOf(command) {
  const c = String(command ?? "").toLowerCase();
  if (/\bclaude\b/.test(c)) return "claude";
  if (/\bcodex\b/.test(c)) return "codex";
  if (/\bkimi\b/.test(c)) return "kimi";
  if (/\bagy\b|gemini/.test(c)) return "gemini";
  if (/openclaw/.test(c)) return "openclaw";
  return "other";
}
