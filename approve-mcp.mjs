#!/usr/bin/env node
/**
 * THE PERMISSION RELAY (0086) — Claude Code's --permission-prompt-tool server.
 *
 * In an ask-mode folder, Claude Code pre-approves only reads; any other tool call
 * makes the CLI ask THIS process (a one-tool MCP server over stdio, spawned by
 * the CLI itself). We redact the request ON the machine, POST it to Cookbook as
 * a pending approval, poll for the owner's click, and answer the CLI with
 * {"behavior":"allow"|"deny"}. No decision in 4.5 minutes = deny — the fail-safe
 * direction, matching the row's 5-minute server expiry.
 *
 * Standalone on purpose: newline-delimited JSON-RPC, zero dependencies beyond
 * the redaction corpus it shares with everything else that leaves this machine.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./hands.mjs";

const URL_BASE = String(process.env.CBK_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.CBK_TOKEN ?? "";
const WORKSPACE = process.env.CBK_WORKSPACE ?? "";
const TASK = process.env.CBK_TASK ?? "";
const FOLDER = process.env.CBK_FOLDER ?? "";
const AGENT = process.env.CBK_AGENT ?? "Claude";
const POLL_MS = 2000;
const WAIT_MS = 4.5 * 60_000;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

/** One line a human can judge: the command for Bash, the path for edits. */
export function summarize(toolName, input) {
  try {
    const i = input && typeof input === "object" ? input : {};
    const core = toolName === "Bash" ? String(i.command ?? "")
      : (i.file_path ?? i.notebook_path ?? i.path ?? i.url ?? JSON.stringify(i));
    return redact(String(core)).slice(0, 500);
  } catch {
    return "";
  }
}

/** The CLI contract: a JSON string in the tool result's text content. */
export function verdictPayload(status) {
  if (status === "allowed") return { behavior: "allow", updatedInput: undefined };
  return { behavior: "deny", message: status === "expired" ? "Timed out waiting for approval in Cookbook (5 minutes). Ask again if still needed." : "Denied by the owner in Cookbook." };
}

async function decide(toolName, input) {
  if (!URL_BASE || !TOKEN || !WORKSPACE) return { behavior: "deny", message: "Approval relay is not configured." };
  const res = await fetch(`${URL_BASE}/api/bridge/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      workspace_id: WORKSPACE,
      task_id: TASK || undefined,
      folder: FOLDER || undefined,
      agent: AGENT,
      tool_name: String(toolName ?? "tool").slice(0, 60),
      input_summary: summarize(toolName, input),
    }),
  });
  if (res.status === 403) return { behavior: "deny", message: "The drive layer isn't enabled for this account." };
  if (!res.ok) return { behavior: "deny", message: `Approval relay error (${res.status}).` };
  const { id } = await res.json();
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const poll = await fetch(`${URL_BASE}/api/bridge/approvals/${id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (!poll.ok) continue;
      const { status } = await poll.json();
      if (status && status !== "pending") return verdictPayload(status);
    } catch { /* transient; keep polling */ }
  }
  return verdictPayload("expired");
}

// ── minimal MCP stdio server: initialize, tools/list, tools/call(approve) ────
const TOOL = {
  name: "approve",
  description: "Ask the owner in Cookbook whether this tool call may run.",
  inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } } },
};

// Start the server ONLY when run as the entry script — importers (tests) get the
// pure exports without a live stdin listener holding their process open.
// `import.meta.main` is undefined before Node 22.18 / 24.2; without the argv[1]
// fallback the relay never started on older Nodes and every ask-mode call was denied.
const IS_MAIN = import.meta.main === true
  || (import.meta.main !== false && !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
let buf = "";
if (IS_MAIN) {
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    void handle(msg);
  }
});
}

async function handle(msg) {
  const { id, method, params } = msg ?? {};
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cbapprove", version: "1" } } });
  }
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
  if (method === "tools/call" && params?.name === "approve") {
    const a = params.arguments ?? {};
    let verdict;
    try { verdict = await decide(a.tool_name, a.input); } catch (e) { verdict = { behavior: "deny", message: `Relay failed: ${e.message}` }; }
    return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(verdict) }] } });
  }
  if (id !== undefined && method) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
}
