// Hermetic tests for the Kimi Code vendor (0.1.12): the stream-json parser against
// lines captured from kimi 0.39.1 and lines built from its emitter source, the
// claude-shaped result envelope, the per-run tool jail (--allowedTools → --agent-file),
// model/resume rewrites, login + MCP state under a temp home, and connect's mcp.json
// merge. No network, no real kimi.
//   node --test bridge/test/kimi.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  API_BILLING_KEYS, agentEnv, isKimiCommand, kimiFromLine, kimiResultEnvelope, kimiCommand,
  kimiTools, kimiAgentFile, kimiLoginState, kimiMcpState, kimiHome, KIMI_TOOL_ALIASES,
} from "../harden.mjs";
import { kimiConfigure, seedConfigFromExample, findKimiBinary } from "../device.mjs";
import { withModel, resumeCommand, resultError } from "../bridge.mjs";
import { displayText, extractUsage } from "../usage.mjs";
import { shortTool, argFor, foldCallEvent } from "../live.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bridge-kimi-"));
const posix = process.platform !== "win32";

// Captured verbatim from `kimi -p 'Reply with exactly the word ready' --output-format
// stream-json` on 2026-09-02 (kimi 0.39.1). The run never reached the model: the
// network resolved api.moonshot.ai to a DNS block page, so the capture holds the
// version line and the retry meta lines. The assistant/tool/resume lines below are
// built from the CLI's own PromptJsonWriter / writeResumeHint source.
const CAPTURED = [
  '{"role":"meta","type":"system.version","version":"0.39.1"}',
  '{"role":"meta","type":"turn.step.retrying","failed_attempt":1,"next_attempt":2,"max_attempts":10,"delay_ms":557.5286992107355,"error_name":"APIConnectionError","error_message":"Connection error."}',
];
const SHAPED = [
  '{"role":"assistant","tool_calls":[{"type":"function","id":"call_1","function":{"name":"Read","arguments":"{\\"path\\":\\"notes/plan.md\\"}"}}]}',
  '{"role":"tool","tool_call_id":"call_1","content":"# plan\\n1. ship"}',
  '{"role":"assistant","tool_calls":[{"type":"function","id":"call_2","function":{"name":"FetchURL","arguments":"{\\"url\\":\\"https://example.com\\"}"}},{"type":"function","id":"call_3","function":{"name":"mcp__cookbook__complete_task","arguments":"{\\"task_id\\":\\"t1\\",\\"summary\\":\\"done\\"}"}}]}',
  '{"role":"tool","tool_call_id":"call_2","content":"<html>"}',
  '{"role":"tool","tool_call_id":"call_3","content":"Error: task not found"}',
  '{"role":"assistant","content":"ready"}',
  '{"role":"meta","type":"session.resume_hint","session_id":"session_99de5878-abd9-439a-badc-96b90799d68c","command":"kimi -r session_99de5878-abd9-439a-badc-96b90799d68c","content":"To resume this session: kimi -r session_99de5878-abd9-439a-badc-96b90799d68c"}',
];

test("isKimiCommand: bare, pathed, .exe, argv arrays; never another CLI", () => {
  assert.ok(isKimiCommand("kimi") && isKimiCommand("/Users/x/.kimi-code/bin/kimi") && isKimiCommand("C:\\Users\\x\\kimi.exe"));
  assert.ok(isKimiCommand(["kimi", "-p", "{prompt}"]));
  assert.ok(!isKimiCommand("claude") && !isKimiCommand("agy") && !isKimiCommand("") && !isKimiCommand(null) && !isKimiCommand(["claude"]));
});

test("billing protection hides Kimi's key names too", () => {
  for (const k of ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_MODEL_API_KEY"]) assert.ok(API_BILLING_KEYS.includes(k), k);
  const { env, stripped } = agentEnv({}, { PATH: "/usr/bin", KIMI_API_KEY: "sk-k", MOONSHOT_API_KEY: "sk-m", KIMI_MODEL_API_KEY: "sk-x", KIMI_CODE_HOME: "/h/.kimi-code" });
  assert.deepEqual(stripped.sort(), ["KIMI_API_KEY", "KIMI_MODEL_API_KEY", "MOONSHOT_API_KEY"]);
  assert.equal(env.KIMI_CODE_HOME, "/h/.kimi-code", "non-key kimi vars stay");
});

test("kimiFromLine: captured lines (version, retry) and non-kimi lines", () => {
  const v = kimiFromLine(CAPTURED[0]);
  assert.equal(v.role, "meta");
  assert.equal(v.text, null); assert.deepEqual(v.calls, []); assert.equal(v.sessionId, null); assert.equal(v.retry, null);
  const r = kimiFromLine(CAPTURED[1]);
  assert.deepEqual(r.retry, { attempt: 1, max: 10, error: "APIConnectionError: Connection error." });
  // claude lines are keyed by `type`, never `role`: not ours
  assert.equal(kimiFromLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'), null);
  assert.equal(kimiFromLine('{"type":"result","result":"ok"}'), null);
  assert.equal(kimiFromLine("not json"), null);
  assert.equal(kimiFromLine(""), null);
});

test("kimiFromLine: tool calls, results, text, session id", () => {
  const c1 = kimiFromLine(SHAPED[0]);
  assert.equal(c1.calls.length, 1);
  assert.deepEqual(c1.calls[0], { kind: "call", id: "call_1", name: "Read", input: { path: "notes/plan.md" } });
  // what the Bridge turns it into for the work log (live.mjs helpers)
  assert.equal(shortTool(c1.calls[0].name), "read");
  assert.equal(argFor(c1.calls[0].input), "notes/plan.md");
  const t1 = kimiFromLine(SHAPED[1]);
  assert.deepEqual(t1.calls, [{ kind: "result", id: "call_1", err: false }]);
  const c2 = kimiFromLine(SHAPED[2]);
  assert.equal(c2.calls[0].name, "fetch", "FetchURL reads as the verb live.mjs uses");
  assert.equal(c2.calls[1].name, "mcp__cookbook__complete_task", "MCP names pass through");
  assert.equal(shortTool(c2.calls[1].name), "complete_task");
  assert.equal(argFor(c2.calls[1].input), "t1".length ? argFor({ task_id: "t1", summary: "done" }) : "");
  const t3 = kimiFromLine(SHAPED[4]);
  assert.deepEqual(t3.calls, [{ kind: "result", id: "call_3", err: true }], "an 'Error:' tool output marks the call failed");
  const a = kimiFromLine(SHAPED[5]);
  assert.equal(a.text, "ready"); assert.deepEqual(a.calls, []);
  const s = kimiFromLine(SHAPED[6]);
  assert.equal(s.sessionId, "session_99de5878-abd9-439a-badc-96b90799d68c");
  // partial JSON arguments (tool.call.delta mid-flight) keep the string
  const partial = kimiFromLine('{"role":"assistant","tool_calls":[{"type":"function","id":"x","function":{"name":"Bash","arguments":"{\\"command\\":\\"npm te"}}]}');
  assert.equal(typeof partial.calls[0].input, "string");
});

test("folding a whole kimi run into live_calls closes calls by id", () => {
  let calls = [];
  for (const line of [...CAPTURED, ...SHAPED]) {
    const ev = kimiFromLine(line);
    for (const c of ev?.calls ?? []) calls = foldCallEvent(calls, c.kind === "call" ? { kind: "call", id: c.id, name: shortTool(c.name), arg: argFor(c.input) } : c);
  }
  assert.deepEqual(calls.map((c) => [c.n, c.s]), [["read", "ok"], ["fetch", "ok"], ["complete_task", "err"]]);
});

test("kimiResultEnvelope: claude-shaped, so displayText/resultError/extractUsage need no kimi branch", () => {
  const okOut = kimiResultEnvelope({ text: "ready", sessionId: "session_1", durationMs: 4179.6, code: 0, numTurns: 1 });
  const j = JSON.parse(okOut);
  assert.equal(j.type, "result"); assert.equal(j.is_error, false); assert.equal(j.result, "ready"); assert.equal(j.session_id, "session_1"); assert.equal(j.duration_ms, 4180);
  assert.equal(displayText(okOut), "ready");
  assert.equal(resultError(okOut), null);
  // No usage object in the envelope, so the receipt is the Bridge's own wall clock and nothing else.
  const usage = extractUsage({ out: okOut, code: 0 }, "Kimi", 9000);
  assert.deepEqual(usage, { duration_ms: 9000, runner: "Kimi" }, "duration only: kimi reports no tokens");
  const bad = kimiResultEnvelope({ text: "", code: 1, err: "error: failed to run prompt: provider.connection_error: Connection error.\nSee log: /x/kimi-code.log", durationMs: 100 });
  const b = JSON.parse(bad);
  assert.equal(b.is_error, true); assert.equal(b.subtype, "error_during_execution");
  assert.match(resultError(bad), /provider\.connection_error/);
  assert.equal(displayText(bad), "");
  // a signal kill (code null) is not an error envelope by itself; the caller reports the kill
  assert.equal(JSON.parse(kimiResultEnvelope({ code: null, text: "partial" })).is_error, false);
});

test("kimiTools: aliases, dedupe, only plain tokens reach YAML", () => {
  assert.deepEqual(kimiTools("Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,mcp__cookbook__*"), ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "FetchURL", "WebSearch", "mcp__cookbook__*"]);
  assert.deepEqual(kimiTools("Read, Read ,TodoWrite,Task"), ["Read", "TodoList", "Agent"]);
  assert.deepEqual(kimiTools("mcp__cookbook__*, evil: [x]\n  - Bash"), ["mcp__cookbook__*"], "a YAML-shaped entry is dropped");
  assert.deepEqual(kimiTools(""), []);
  assert.equal(KIMI_TOOL_ALIASES.WebFetch, "FetchURL");
});

test("kimiAgentFile: frontmatter allowlist, empty list disables every tool, base prompt kept", () => {
  const f = kimiAgentFile("mcp__cookbook__*");
  assert.match(f, /^---\nname: cookbook-bridge\n/);
  assert.match(f, /\ntools:\n  - mcp__cookbook__\*\n---\n\$\{base_prompt\}\n$/);
  assert.match(kimiAgentFile(""), /\ntools: \[\]\n/);
  assert.ok(!/\u2014/.test(f), "no em dash");
});

test("kimiCommand: --allowedTools becomes a 0600 --agent-file; dropped on resume; identity otherwise", () => {
  const dir = tmp();
  const cmd = ["kimi", "-p", "{prompt}", "--allowedTools", "Bash,mcp__cookbook__*", "--output-format", "stream-json"];
  const r = kimiCommand(cmd, { dir });
  assert.deepEqual(r.command.slice(0, 2), ["kimi", "--agent-file"]);
  assert.deepEqual(r.command.slice(3), ["-p", "{prompt}", "--output-format", "stream-json"], "the flag and its value are gone");
  assert.ok(!r.command.includes("--allowedTools"));
  assert.ok(fs.existsSync(r.file));
  assert.match(fs.readFileSync(r.file, "utf8"), /- Bash\n  - mcp__cookbook__\*/);
  assert.deepEqual(r.tools, ["Bash", "mcp__cookbook__*"]);
  if (posix) {
    assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(r.file)).mode & 0o777, 0o700);
  }
  r.cleanup();
  assert.ok(!fs.existsSync(r.file), "cleanup removes the private dir");
  assert.deepEqual(cmd[3], "--allowedTools", "input not mutated");
  // resume: no agent file (kimi refuses it there), the flag just disappears
  const resumed = kimiCommand(["kimi", "-S", "session_1", "-p", "{prompt}", "--allowedTools", "mcp__cookbook__*"], { dir });
  assert.deepEqual(resumed.command, ["kimi", "-S", "session_1", "-p", "{prompt}"]);
  assert.equal(resumed.file, null);
  // identity: not kimi, or no flag
  const claude = ["claude", "-p", "{prompt}", "--allowedTools", "mcp__cookbook__*"];
  assert.equal(kimiCommand(claude, { dir }).command, claude);
  const bare = ["kimi", "-p", "{prompt}"];
  assert.equal(kimiCommand(bare, { dir }).command, bare);
  // an agent the user chose by hand wins over the jail
  const own = kimiCommand(["kimi", "--agent", "reviewer", "-p", "{prompt}", "--allowedTools", "Read"], { dir });
  assert.deepEqual(own.command, ["kimi", "--agent", "reviewer", "-p", "{prompt}"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withModel / resumeCommand: kimi uses -m and -S", () => {
  const cmd = ["kimi", "-p", "{prompt}", "--allowedTools", "mcp__cookbook__*", "--output-format", "stream-json"];
  const m = withModel(cmd, "moonshot-ai/kimi-k3");
  assert.deepEqual(m.slice(-2), ["-m", "moonshot-ai/kimi-k3"]);
  assert.deepEqual(withModel(["kimi", "-m", "old", "-p", "{prompt}"], "new"), ["kimi", "-p", "{prompt}", "-m", "new"], "an existing -m is replaced");
  assert.equal(withModel(["agy", "-p", "{prompt}"], "x").length, 3, "other CLIs untouched");
  const r = resumeCommand(cmd, "session_abc");
  assert.equal(r.resumed, true);
  assert.deepEqual(r.command.slice(0, 3), ["kimi", "-S", "session_abc"]);
  assert.deepEqual(resumeCommand(["kimi", "-S", "s1", "-p", "{prompt}"], "s2"), { command: ["kimi", "-S", "s1", "-p", "{prompt}"], resumed: true });
  assert.equal(resumeCommand(["agy", "-p", "{prompt}"], "s").resumed, false);
  // resume + jail together: the -S run carries no agent file
  const jailed = kimiCommand(resumeCommand(cmd, "session_abc").command, { dir: tmp() });
  assert.ok(!jailed.command.includes("--agent-file") && !jailed.command.includes("--allowedTools"));
});

test("kimiLoginState: providers in config.toml, OAuth credential files, nothing", () => {
  const home = tmp();
  const env = {};
  assert.equal(kimiHome({ home, env }), path.join(home, ".kimi-code"));
  assert.equal(kimiLoginState({ home, env }).loggedIn, false, "no install");
  const root = path.join(home, ".kimi-code");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.toml"), 'default_model = "moonshot-ai/kimi-k3"\n\n[providers.moonshot-ai]\nbase_url = "https://api.moonshot.ai/v1"\ntype = "kimi"\napi_key = ""\n\n[models."moonshot-ai/kimi-k3"]\nprovider = "moonshot-ai"\n');
  assert.equal(kimiLoginState({ home, env }).loggedIn, false, "an empty api_key is not a login");
  fs.writeFileSync(path.join(root, "config.toml"), 'default_model = "moonshot-ai/kimi-k3"\n\n[providers.moonshot-ai]\nbase_url = "https://api.moonshot.ai/v1"\ntype = "kimi"\napi_key = "sk-redacted"\n\n[models."moonshot-ai/kimi-k3"]\nprovider = "moonshot-ai"\n');
  const s = kimiLoginState({ home, env });
  assert.equal(s.loggedIn, true); assert.deepEqual(s.providers, ["moonshot-ai"]); assert.equal(s.configPath, path.join(root, "config.toml"));
  fs.writeFileSync(path.join(root, "config.toml"), '[providers.kimi]\ntype = "kimi"\n\n[providers.kimi.env]\nKIMI_API_KEY = "sk-x"\n');
  assert.deepEqual(kimiLoginState({ home, env }).providers, ["kimi"], "an env sub-table key counts");
  fs.writeFileSync(path.join(root, "config.toml"), '[providers.kimi-code]\ntype = "kimi"\n\n[providers.kimi-code.oauth]\nstorage = "file"\nkey = "kimi-code"\n');
  assert.deepEqual(kimiLoginState({ home, env }).providers, ["kimi-code"], "an oauth sub-table counts");
  fs.writeFileSync(path.join(root, "config.toml"), "");
  fs.mkdirSync(path.join(root, "credentials", "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "credentials", "mcp", "x.json"), "{}");
  assert.equal(kimiLoginState({ home, env }).loggedIn, false, "MCP credentials are not a provider login");
  fs.writeFileSync(path.join(root, "credentials", "kimi-code.json"), "{}");
  const c = kimiLoginState({ home, env });
  assert.equal(c.loggedIn, true); assert.equal(c.credentials, 1);
  // KIMI_CODE_HOME moves the root
  const other = tmp();
  assert.equal(kimiLoginState({ home, env: { KIMI_CODE_HOME: other } }).root, other);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true });
});

test("kimiConfigure + kimiMcpState: merge-write, owner-only, other servers kept, auth replaced", () => {
  const home = tmp();
  const env = {};
  const root = path.join(home, ".kimi-code");
  fs.mkdirSync(root, { recursive: true });
  // Diego's real file before connect: an OAuth-style entry with no header
  fs.writeFileSync(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { cookbook: { url: "https://cookbook.team/api/mcp" }, linear: { url: "https://mcp.linear.app/mcp" } } }, null, 2));
  const before = kimiMcpState({ home, env, cookbookUrl: "https://cookbook.team" });
  assert.equal(before.exists, true); assert.equal(before.matches, true); assert.equal(before.hasAuth, false);
  const wrote = kimiConfigure("https://cookbook.team/api/mcp", "cbk_agent_token", { home, env });
  assert.equal(wrote, path.join(root, "mcp.json"));
  const json = JSON.parse(fs.readFileSync(wrote, "utf8"));
  assert.deepEqual(json.mcpServers.cookbook, { url: "https://cookbook.team/api/mcp", headers: { Authorization: "Bearer cbk_agent_token" } });
  assert.deepEqual(json.mcpServers.linear, { url: "https://mcp.linear.app/mcp" }, "other servers untouched");
  if (posix) assert.equal(fs.statSync(wrote).mode & 0o777, 0o600);
  const after = kimiMcpState({ home, env, cookbookUrl: "https://cookbook.team" });
  assert.equal(after.hasAuth, true); assert.equal(after.matches, true);
  assert.equal(kimiMcpState({ home, env, cookbookUrl: "https://other.example" }).matches, false);
  // re-connect: a stale bearerTokenEnvVar / transport goes, tuning stays
  fs.writeFileSync(wrote, JSON.stringify({ mcpServers: { cookbook: { url: "https://old/api/mcp", bearerTokenEnvVar: "OLD", transport: "sse", toolTimeoutMs: 5000 } } }));
  kimiConfigure("https://cookbook.team/api/mcp", "cbk_new", { home, env });
  assert.deepEqual(JSON.parse(fs.readFileSync(wrote, "utf8")).mcpServers.cookbook, { toolTimeoutMs: 5000, url: "https://cookbook.team/api/mcp", headers: { Authorization: "Bearer cbk_new" } });
  // fresh machine: no file, no dir
  const fresh = tmp();
  const p2 = kimiConfigure("https://cookbook.team/api/mcp", "t", { home: fresh, env });
  assert.deepEqual(JSON.parse(fs.readFileSync(p2, "utf8")).mcpServers.cookbook.headers, { Authorization: "Bearer t" });
  assert.equal(kimiMcpState({ home: tmp(), env }).exists, false);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(fresh, { recursive: true, force: true });
});

test("findKimiBinary falls back to $KIMI_CODE_HOME/bin when kimi is not on PATH", () => {
  const home = tmp();
  const env = { KIMI_CODE_HOME: path.join(home, "kc"), PATH: "" };
  assert.equal(findKimiBinary({ home, env }) === null || typeof findKimiBinary({ home, env }) === "string", true);
  if (posix) {
    fs.mkdirSync(path.join(home, "kc", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, "kc", "bin", "kimi"), "#!/bin/sh\necho 0.39.1\n", { mode: 0o755 });
    const found = findKimiBinary({ home, env });
    // `which` consults the real PATH; if a real kimi is installed it wins, else the home copy
    assert.ok(found === path.join(home, "kc", "bin", "kimi") || /kimi$/.test(found));
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("seedConfigFromExample keeps the Kimi entry only when kimi is installed, and can default to it", () => {
  const example = JSON.parse(fs.readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
  const kimiOnly = seedConfigFromExample(example, [{ agent: "Kimi", vendor: "kimi", path: "/x/kimi", kind: "kimi" }]);
  assert.deepEqual(kimiOnly.agents.map((a) => a.name), ["Kimi"]);
  assert.equal(kimiOnly.default, "Kimi");
  assert.deepEqual(kimiOnly.agents[0].command, ["kimi", "-p", "{prompt}", "--allowedTools", "mcp__cookbook__*", "--output-format", "stream-json"]);
  const both = seedConfigFromExample(example, [{ vendor: "kimi" }, { vendor: "claude" }]);
  assert.equal(both.default, "Claude", "Claude stays the preferred default");
  assert.deepEqual(both.agents.map((a) => a.name).sort(), ["Claude", "Kimi"]);
  const none = seedConfigFromExample(example, [{ vendor: "claude" }]);
  assert.ok(!none.agents.some((a) => a.name === "Kimi"));
  for (const a of example.agents.filter((x) => x.name === "Kimi")) {
    for (const v of Object.values(a)) if (typeof v === "string") assert.ok(!/\u2014/.test(v), "no em dash in the Kimi example entry");
  }
});
