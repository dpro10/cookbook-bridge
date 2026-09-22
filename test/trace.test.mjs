// Hermetic tests for the trace collector (bridge/trace.mjs, the Record J1): every
// tool call with input and result, from claude stream-json, gemini stream-json,
// kimi events and codex app-server items; caps and truncation markers; redaction
// of a planted secret. No network, no CLI.
//   node --test bridge/test/trace.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createTrace, traceEnvelope, resultText, maskSecretKeys, TRACE_CALLS_CAP, INPUT_CAP, RESULT_CAP, TRACE_BYTES_CAP } from "../trace.mjs";
import { kimiFromLine } from "../harden.mjs";

const claudeUse = (id, name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const claudeResult = (id, content, isError = false) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });

test("claude: a call keeps its full input and its result text, in order, with ok", () => {
  const t = createTrace({ home: "/Users/dp" });
  t.onStreamLine(claudeUse("c1", "mcp__cookbook__read_file", { workspace_id: "w", path: "plans/x.md" }), 1000);
  t.onStreamLine(claudeResult("c1", [{ type: "text", text: "# Plan\nline two" }]), 1500);
  t.onStreamLine(claudeUse("c2", "Bash", { command: "npm test" }), 2000);
  t.onStreamLine(claudeResult("c2", "1 failing", true), 2600);
  const r = t.finish();
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].n, "read_file");
  assert.equal(r.calls[0].input, JSON.stringify({ workspace_id: "w", path: "plans/x.md" }));
  assert.equal(r.calls[0].result, "# Plan\nline two");
  assert.equal(r.calls[0].ok, true);
  assert.equal(r.calls[0].at, 1000);
  assert.equal(r.calls[0].ended, 1500);
  assert.equal(r.calls[1].n, "bash");
  assert.equal(r.calls[1].ok, false);
  assert.equal(r.calls[1].result, "1 failing");
  assert.equal(r.truncated.complete, true);
});

test("a planted secret in an input or a result never reaches the trace", () => {
  const t = createTrace({ home: "/Users/dp" });
  t.onStreamLine(claudeUse("c1", "Bash", { command: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' https://x" }), 1);
  t.onStreamLine(claudeResult("c1", "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012345 at /Users/dp/secret.txt"), 2);
  const r = t.finish();
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), "anthropic key leaked");
  assert.ok(!blob.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "github token leaked");
  assert.ok(!blob.includes("/Users/dp/"), "home path leaked");
});

test("an opaque secret under a credential-shaped key is masked, in an input and in a JSON-text result; paths are not", () => {
  const t = createTrace({ home: "/h" });
  t.onStreamLine(claudeUse("c1", "WebFetch", { url: "https://x", headers: { Authorization: "Basic dXNlcjpwYXNz", "X-Api-Key": "opaque-value-123" }, path: "plans/x.md" }), 1);
  t.onStreamLine(claudeResult("c1", JSON.stringify({ access_token: "ya29.opaque-token-value", refresh_token: "1//abc", pathname: "/keep/me", data: { client_secret: "shh", nested: [{ password: "pw" }] } })), 2);
  const r = t.finish();
  const blob = JSON.stringify(r);
  for (const leak of ["dXNlcjpwYXNz", "opaque-value-123", "ya29.opaque", "1//abc", "shh", '"pw"']) assert.ok(!blob.includes(leak), `${leak} leaked`);
  assert.ok(blob.includes("plans/x.md") && blob.includes("/keep/me"), "paths must survive");
  assert.deepEqual(maskSecretKeys({ api_key: "k", path: "p", session_token: "s", empty_token: "", n: 1 }), { api_key: "[redacted]", path: "p", session_token: "[redacted]", empty_token: "", n: 1 });
});

test("ToolSearch plumbing is skipped; a re-emitted call id is not doubled", () => {
  const t = createTrace({ home: "/h" });
  t.onStreamLine(claudeUse("s1", "ToolSearch", { query: "x" }), 1);
  t.onStreamLine(claudeUse("c1", "Read", { file_path: "a" }), 2);
  t.onStreamLine(claudeUse("c1", "Read", { file_path: "a" }), 3);
  assert.equal(t.finish().calls.length, 1);
});

test("caps: inputs and results are clipped and counted; more than the cap drops the oldest", () => {
  const t = createTrace({ home: "/h" });
  t.onStreamLine(claudeUse("c1", "Write", { content: "x".repeat(INPUT_CAP * 3) }), 1);
  t.onStreamLine(claudeResult("c1", "y".repeat(RESULT_CAP * 3)), 2);
  let r = t.finish();
  assert.ok(r.calls[0].input.length <= INPUT_CAP && r.calls[0].result.length <= RESULT_CAP);
  assert.equal(r.truncated.clipped, 2);
  const big = createTrace({ home: "/h" });
  for (let i = 0; i < TRACE_CALLS_CAP + 25; i++) { big.onStreamLine(claudeUse(`c${i}`, "Read", { file_path: `f${i}` }), i); big.onStreamLine(claudeResult(`c${i}`, "ok"), i); }
  r = big.finish();
  assert.equal(r.calls.length, TRACE_CALLS_CAP);
  assert.equal(r.calls[0].input, JSON.stringify({ file_path: "f25" }), "the oldest were dropped");
  assert.equal(r.truncated.dropped, 25);
  assert.equal(r.truncated.complete, false);
});

test("the wire body stays under the byte cap, trimming the oldest and saying so", () => {
  const t = createTrace({ home: "/h" });
  for (let i = 0; i < 300; i++) { t.onStreamLine(claudeUse(`c${i}`, "Read", { p: i }), i); t.onStreamLine(claudeResult(`c${i}`, "r".repeat(RESULT_CAP - 10)), i); }
  const r = t.finish();
  assert.ok(r.bytes <= TRACE_BYTES_CAP, `bytes ${r.bytes}`);
  assert.ok(r.calls.length < 300 && r.truncated.dropped > 0 && r.truncated.complete === false);
});

test("a call still open when the run ends is marked not ok with a note", () => {
  const t = createTrace({ home: "/h" });
  t.onStreamLine(claudeUse("c1", "Bash", { command: "sleep 999" }), 1);
  const r = t.finish();
  assert.equal(r.calls[0].ok, false);
  assert.match(r.calls[0].result, /no result before the run ended/);
});

test("gemini stream-json and kimi events are captured too", () => {
  const t = createTrace({ home: "/h" });
  t.onStreamLine(JSON.stringify({ type: "tool_use", tool_id: "g1", tool_name: "read_file", parameters: { absolute_path: "/tmp/a" } }), 1);
  t.onStreamLine(JSON.stringify({ type: "tool_result", tool_id: "g1", status: "success", output: "hello" }), 2);
  // Real kimi lines through harden.mjs, so the result's content is what kimi actually emits.
  t.onKimiEvent(kimiFromLine(JSON.stringify({ role: "assistant", tool_calls: [{ id: "k1", function: { name: "mcp__cookbook__recall", arguments: JSON.stringify({ workspace_id: "w" }) } }] })), 3);
  t.onKimiEvent(kimiFromLine(JSON.stringify({ role: "tool", tool_call_id: "k1", content: "3 notes" })), 4);
  const r = t.finish();
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].n, "read");
  assert.equal(r.calls[0].result, "hello");
  assert.equal(r.calls[1].n, "recall");
  assert.equal(r.calls[1].result, "3 notes");
});

test("codex app-server items: started opens, completed closes with output; a failed exit is not ok", () => {
  const t = createTrace({ home: "/h" });
  t.onCodexEvent("item/started", { item: { id: "i1", type: "command_execution", command: "npm test" } }, 1);
  t.onCodexEvent("item/completed", { item: { id: "i1", type: "command_execution", command: "npm test", status: "completed", exit_code: 1, aggregated_output: "2 failing" } }, 2);
  t.onCodexEvent("item/started", { item: { id: "i2", type: "mcp_tool_call", server: "cookbook", tool: "read_file", arguments: { path: "a.md" } } }, 3);
  t.onCodexEvent("item/completed", { item: { id: "i2", type: "mcp_tool_call", server: "cookbook", tool: "read_file", status: "completed", result: { content: [{ type: "text", text: "# a" }] } } }, 4);
  t.onCodexEvent("item/completed", { item: { id: "i3", type: "file_change", changes: [{ path: "b.md" }], status: "completed" } }, 5);
  const r = t.finish();
  assert.equal(r.calls.length, 3);
  assert.equal(r.calls[0].n, "bash"); assert.equal(r.calls[0].ok, false); assert.equal(r.calls[0].result, "2 failing");
  assert.equal(r.calls[1].n, "read_file"); assert.ok(r.calls[1].result.includes("# a"));
  assert.equal(r.calls[2].n, "edit"); assert.equal(r.calls[2].ok, true);
});

test("resultText reads strings, text blocks, objects", () => {
  assert.equal(resultText("x"), "x");
  assert.equal(resultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\n[image]\nb");
  assert.equal(resultText({ output: "o" }), "o");
  assert.equal(resultText(null), "");
});

test("the envelope carries the run's conditions and never a raw home path", () => {
  const env = traceEnvelope({
    workspaceId: "w", taskId: "t", outcome: "done",
    agent: { name: "Claude", command: "claude -p", allowedTools: "mcp__cookbook__*", cwd: "/Users/dp/proj" },
    cfg: { pinMcp: true, persistentThreads: true }, model: "claude-fable-5-1", promptVersion: "chat/3", bridgeVersion: "0.1.18",
    recalled: ["m1", "m2", 3], crossRecalled: [], resume: { sessionId: "s1" }, chat: true,
    stages: { claimed: 1, booted: 2 }, localMeta: { cwd: "/Users/dp/proj", mode: "edit" }, trace: createTrace({ home: "/Users/dp" }).finish(), home: "/Users/dp",
  });
  assert.equal(env.agent.vendor, "claude");
  assert.equal(env.recalled.length, 2);
  assert.equal(env.resume.resumed, true);
  assert.equal(env.config.mode, "edit");
  assert.ok(!env.config.cwd.includes("/Users/dp/"));
  assert.equal(env.trace.truncated.complete, true);
});
