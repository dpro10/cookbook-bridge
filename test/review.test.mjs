// Hermetic tests for the 2026-09-01 review fixes: no network, no real agents.
//   node --test bridge/test/review.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule, notePlanHold, planHoldFor, resetPlanHolds } from "../bridge.mjs";
import { stripTomlSection, renderTomlSection, tomlString, readVendor, writeConnector, gateTeamRows, VENDORS, NAME_RE } from "../connectors.mjs";
import { materializeMcpConfig, withCookbookMcp } from "../harden.mjs";
import { persistentCommand } from "../thread-runner.mjs";
import { resolveCmdShim, stripTokens, projectedConfig, LOCAL_CEILING, RUN_TEMPLATES, SETUP_FILES } from "../hands.mjs";
import { seedConfigFromExample } from "../device.mjs";
import { synthesisArgs, argsForKind, extFromMime, substituteImageFile, validateJob, kindOf, modelFor, timeoutForKind,
  imageMaxBytes, scrubUrls, describeJob, runSynthesisJobs, resetSynthesisQueue, synthesisQueueSize,
  SYNTHESIS_TIMEOUT_MS, VISION_TIMEOUT_MS, IMAGE_MAX_BYTES_DEFAULT } from "../synthesis.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bridge-review-"));

test("isMainModule falls back to argv[1] when import.meta.main is undefined", () => {
  const meta = { main: undefined, url: "file:///tmp/x/bridge.mjs" };
  assert.equal(isMainModule(meta, ["node", "/tmp/x/bridge.mjs"]), true);
  assert.equal(isMainModule(meta, ["node", "/tmp/x/other.mjs"]), false);
  assert.equal(isMainModule(meta, ["node"]), false);
  assert.equal(isMainModule({ main: true, url: meta.url }, ["node"]), true);
  assert.equal(isMainModule({ main: false, url: meta.url }, ["node", "/tmp/x/bridge.mjs"]), false);
});

test("plan holds: a closed window holds the vendor until its reset, open windows do not", () => {
  resetPlanHolds();
  const now = 1_000_000_000_000;
  assert.equal(notePlanHold({ vendor: "claude", five_hour: { u: 0.7, r: now / 1000 + 600 } }, now), null);
  assert.equal(planHoldFor("claude", now), null);
  const h = notePlanHold({ vendor: "claude", five_hour: { u: 1.02, r: now / 1000 + 600 } }, now);
  assert.equal(h.until, now + 600_000);
  assert.ok(planHoldFor("claude", now + 1000));
  assert.equal(planHoldFor("claude", now + 600_001), null);
  // no reset time: a bounded default, never forever
  const d = notePlanHold({ vendor: "claude", seven_day: { u: 1 } }, now);
  assert.ok(d.until > now && d.until <= now + 8 * 3600_000);
  resetPlanHolds();
});

test("TOML: the LAST section is found and stripped (the \\Z bug)", () => {
  const toml = `[mcp_servers.first]\nurl = "https://a"\n\n[mcp_servers.last]\ncommand = "npx"\nargs = ["-y", "x"]\n\n[mcp_servers.last.env]\nK = "v"\n`;
  assert.equal(stripTomlSection(toml, "last"), `[mcp_servers.first]\nurl = "https://a"\n\n`);
  assert.ok(!stripTomlSection(toml, "first").includes("first"));
  const dir = tmp();
  const saved = VENDORS.codex.file;
  VENDORS.codex.file = path.join(dir, "config.toml");
  try {
    fs.writeFileSync(VENDORS.codex.file, toml);
    const m = readVendor("codex");
    assert.deepEqual([...m.keys()], ["first", "last"]);
    assert.deepEqual(m.get("last").args, ["-y", "x"]);
    writeConnector("codex", { name: "last", kind: "http", url: "https://b", headers: {}, env: {} });
    const after = fs.readFileSync(VENDORS.codex.file, "utf8");
    assert.equal((after.match(/\[mcp_servers\.last\]/g) || []).length, 1, "no duplicate table");
    assert.ok(!after.includes("[mcp_servers.last.env]"), "subtable removed with its parent");
    assert.equal(readVendor("codex").get("last").url, "https://b");
  } finally { VENDORS.codex.file = saved; }
});

test("TOML strings are escaped and names are validated", () => {
  assert.equal(tomlString('say "hi"\\'), '"say \\"hi\\"\\\\"');
  assert.equal(tomlString("a\nb"), '"a\\nb"');
  assert.ok(renderTomlSection({ name: "x", kind: "stdio", command: "c:\\tools\\x", args: ['"q"'], env: {} }).includes('command = "c:\\\\tools\\\\x"'));
  assert.ok(NAME_RE.test("my-tool.v2"));
  assert.ok(!NAME_RE.test("bad name]"));
  assert.throws(() => writeConnector("codex", { name: "evil]\n[x", kind: "http", url: "u", headers: {}, env: {} }), /not allowed/);
});

test("writeConnector never rewrites an unparseable ~/.claude.json", () => {
  const dir = tmp();
  const saved = VENDORS.claude.file;
  VENDORS.claude.file = path.join(dir, ".claude.json");
  try {
    fs.writeFileSync(VENDORS.claude.file, "{ this is not json");
    assert.throws(() => writeConnector("claude", { name: "t", kind: "http", url: "https://x", headers: {}, env: {} }), /does not parse/);
    assert.equal(fs.readFileSync(VENDORS.claude.file, "utf8"), "{ this is not json");
    fs.writeFileSync(VENDORS.claude.file, JSON.stringify({ mcpServers: { keep: { url: "https://k" } }, projects: { a: 1 } }));
    writeConnector("claude", { name: "t", kind: "http", url: "https://x", headers: {}, env: {} });
    const j = JSON.parse(fs.readFileSync(VENDORS.claude.file, "utf8"));
    assert.ok(j.mcpServers.keep && j.mcpServers.t && j.projects);
  } finally { VENDORS.claude.file = saved; }
});

test("team stdio connectors wait for approval; http ones write; approved ones sync", () => {
  const rows = [{ name: "h", kind: "http", url: "https://h" }, { name: "s", kind: "stdio", command: "npx", args: ["-y", "thing"] }];
  const g = gateTeamRows(rows, {});
  assert.deepEqual(g.writable.map((r) => r.name), ["h"]);
  assert.deepEqual(g.waiting.map((r) => r.name), ["s"]);
  assert.equal(g.pending.s.approved, false);
  assert.equal(g.changed, true);
  const g2 = gateTeamRows(rows, { s: { ...g.pending.s, approved: true } });
  assert.deepEqual(g2.writable.map((r) => r.name), ["h", "s"]);
  assert.equal(g2.changed, false);
  // a changed command needs a fresh approval
  const g3 = gateTeamRows([{ name: "s", kind: "stdio", command: "npx", args: ["-y", "other"] }], { s: { ...g.pending.s, approved: true } });
  assert.equal(g3.writable.length, 0);
  assert.equal(g3.pending.s.approved, false);
  assert.equal(g3.pending.s.changed, true);
});

test("the bearer token leaves argv: inline --mcp-config becomes a 0600 file, cleaned up", () => {
  const pinned = withCookbookMcp(["claude", "-p", "{prompt}"], { token: "cbk_secret", cookbookUrl: "https://c" }).command;
  const m = materializeMcpConfig(pinned);
  assert.ok(!m.command.join(" ").includes("cbk_secret"));
  assert.ok(fs.readFileSync(m.file, "utf8").includes("cbk_secret"));
  if (process.platform !== "win32") assert.equal(fs.statSync(m.file).mode & 0o777, 0o600);
  m.cleanup();
  assert.ok(!fs.existsSync(m.file));
  assert.deepEqual(materializeMcpConfig(["claude", "--mcp-config", "/etc/x.json"]).command, ["claude", "--mcp-config", "/etc/x.json"]);
});

test("persistentCommand accepts an absolute claude path and keeps it", () => {
  const c = persistentCommand(["/opt/homebrew/bin/claude", "-p", "{prompt}", "--allowedTools", "mcp__cookbook__*", "--output-format", "json"], null);
  assert.equal(c[0], "/opt/homebrew/bin/claude");
  assert.ok(c.includes("--input-format") && c.includes("--allowedTools") && !c.includes("{prompt}"));
  assert.equal(persistentCommand(["agy", "-p", "{prompt}"], null), null);
});

test("resolveCmdShim finds the node script behind an npm .cmd shim, refuses anything else", () => {
  const shim = '@ECHO off\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const found = resolveCmdShim("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", { platform: "win32", readFile: () => shim, exists: () => true });
  assert.equal(found, "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js");
  assert.equal(resolveCmdShim("x.cmd", { platform: "win32", readFile: () => "@echo off\r\nsomething.exe %*", exists: () => true }), null);
  assert.equal(resolveCmdShim("x.cmd", { platform: "win32", readFile: () => shim, exists: () => false }), null);
  assert.equal(resolveCmdShim("missing.cmd", { platform: "win32", readFile: () => { throw new Error("ENOENT"); } }), null);
});

test("a first config is shaped to the CLIs on the machine", () => {
  const example = JSON.parse(fs.readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
  const c = seedConfigFromExample(example, [{ vendor: "claude", path: "/x/claude" }]);
  assert.deepEqual(c.agents.map((a) => a.name), ["Claude"]);
  assert.equal(c.default, "Claude");
  assert.equal(c.token, undefined);
  assert.deepEqual(c.localWorkspaces, {});
  const two = seedConfigFromExample(example, [{ vendor: "gemini", path: "/x/agy" }, { vendor: "codex", path: "/Apps/codex" }]);
  assert.deepEqual(two.agents.map((a) => a.name).sort(), ["Codex", "Gemini"]);
  assert.equal(two.default, "Gemini"); // Codex is disabled in the example until connect enables it
  assert.deepEqual(two.agents.find((a) => a.name === "Codex").command, ["/Apps/codex"]);
  const hints = [];
  const none = seedConfigFromExample(example, [], { log: (m) => hints.push(m) });
  assert.deepEqual(none.agents.map((a) => a.name), ["Claude"]);
  assert.equal(none.agents[0].enabled, true);
  assert.equal(hints.length, 1);
});

test("synthesis runs with no tools and no MCP", () => {
  const a = synthesisArgs({ model: "haiku" });
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(a[a.indexOf("--tools") + 1], "");
  assert.ok(!a.includes("{prompt}"));
});

test("hands: tokens are stripped from projected configs, the add template is fixed argv", () => {
  const s = stripTokens({ token: "cbk_x", agents: [{ name: "Claude", token: "abc", codex_token: "" }], nested: { AUTH_TOKEN: "t", url: "https://u" } });
  assert.deepEqual(s, { token: "<present, not sent>", agents: [{ name: "Claude", token: "<present, not sent>", codex_token: null }], nested: { AUTH_TOKEN: "<present, not sent>", url: "https://u" } });
  const p = projectedConfig('{"token":"cbk_secret","cookbookUrl":"https://c"}');
  assert.ok(!JSON.stringify(p).includes("cbk_secret") && p.cookbookUrl === "https://c" && p.note);
  assert.ok(projectedConfig("nope").parse_error);
  for (const f of ["Library/CookbookBridge/config.json", "Library/Application Support/ai.cookbook.desktop/config.json", ".cookbook/config.json", "Library/CookbookBridge/bridge.state.json"]) assert.ok(SETUP_FILES.includes(f), f);
  assert.ok(LOCAL_CEILING.run_allow.includes("claude_mcp_add_cookbook"));
  const noUrl = RUN_TEMPLATES.claude_mcp_add_cookbook({}, { cfg: {} });
  assert.ok(noUrl.error === undefined ? false : /cookbookUrl|claude CLI/.test(noUrl.error));
  const bad = RUN_TEMPLATES.claude_mcp_add_cookbook({}, { cfg: { cookbookUrl: "not a url" } });
  assert.ok(bad.error === undefined ? false : /valid URL|claude CLI/.test(bad.error));
  const ok = RUN_TEMPLATES.claude_mcp_add_cookbook({}, { cfg: { cookbookUrl: "https://cookbook.team/some/path" } });
  if (!ok.error) assert.deepEqual(ok.argv.slice(1), ["mcp", "add", "--transport", "http", "--scope", "user", "cookbook", "https://cookbook.team/api/mcp"]);
});

// ── synthesis kinds (captions, vision, answers on the subscription) ──

test("synthesis argv per kind: text kinds get no tools, vision gets Read only, all get no MCP", () => {
  for (const kind of ["summary", "caption", "answer"]) {
    const a = argsForKind(kind, { model: "haiku" });
    assert.ok(a.includes("-p") && a.includes("--strict-mcp-config"), kind);
    assert.equal(a[a.indexOf("--mcp-config") + 1], '{"mcpServers":{}}', kind);
    assert.equal(a[a.indexOf("--tools") + 1], "", kind);
    assert.equal(a[a.indexOf("--model") + 1], "haiku", kind);
  }
  const v = argsForKind("vision", { model: "sonnet" });
  assert.equal(v[v.indexOf("--tools") + 1], "Read");
  assert.equal(v[v.indexOf("--model") + 1], "sonnet");
  assert.ok(v.includes("--strict-mcp-config"));
  assert.ok(!argsForKind("vision").includes("--model"), "no alias, no --model (the fallback run)");
  assert.deepEqual(synthesisArgs({ model: "haiku" }), argsForKind("summary", { model: "haiku" }));
});

test("synthesis: kind, model and timeout defaults", () => {
  assert.equal(kindOf({}), "summary");
  assert.equal(kindOf({ kind: "caption" }), "caption");
  assert.equal(modelFor({}), "haiku");
  assert.equal(modelFor({ model: "sonnet" }), "sonnet");
  assert.equal(modelFor({ model: "opus-9" }), "haiku", "unknown alias falls back to haiku");
  assert.equal(timeoutForKind("vision"), VISION_TIMEOUT_MS);
  assert.equal(timeoutForKind("caption"), SYNTHESIS_TIMEOUT_MS);
  assert.equal(VISION_TIMEOUT_MS, 240_000);
  assert.equal(SYNTHESIS_TIMEOUT_MS, 180_000);
  assert.equal(imageMaxBytes({}), IMAGE_MAX_BYTES_DEFAULT);
  assert.equal(imageMaxBytes({ max_bytes: 1024 }), 1024);
  assert.equal(imageMaxBytes({ max_bytes: -1 }), IMAGE_MAX_BYTES_DEFAULT);
});

test("extFromMime accepts png/jpg/gif/webp and refuses the rest", () => {
  assert.equal(extFromMime("image/png"), "png");
  assert.equal(extFromMime("image/jpeg"), "jpg");
  assert.equal(extFromMime("image/jpg"), "jpg");
  assert.equal(extFromMime("IMAGE/JPEG; charset=binary"), "jpg");
  assert.equal(extFromMime("image/gif"), "gif");
  assert.equal(extFromMime("image/webp"), "webp");
  for (const bad of ["image/svg+xml", "text/html", "application/pdf", "image/heic", "", null, undefined]) assert.equal(extFromMime(bad), null, String(bad));
});

test("{{IMAGE_FILE}} is replaced everywhere; prompts without it are untouched", () => {
  assert.equal(substituteImageFile("Read {{IMAGE_FILE}} then describe {{IMAGE_FILE}}.", "image.png"), "Read image.png then describe image.png.");
  assert.equal(substituteImageFile("no placeholder", "image.png"), "no placeholder");
  assert.equal(substituteImageFile("{{IMAGE_FILE}}", "image.webp"), "image.webp");
});

test("validateJob: vision needs an https image of a known type; unknown kinds are refused", () => {
  assert.equal(validateJob({ id: "a", prompt: "p" }), null);
  assert.equal(validateJob({ id: "a", prompt: "p", kind: "answer", model: "sonnet" }), null);
  assert.equal(validateJob({ id: "a", prompt: "p", kind: "vision", image: { url: "https://x/y", mime: "image/png" } }), null);
  assert.match(validateJob({ id: "a", prompt: "p", kind: "vision" }), /no image/);
  assert.match(validateJob({ id: "a", prompt: "p", kind: "vision", image: { url: "http://x/y", mime: "image/png" } }), /https/);
  assert.match(validateJob({ id: "a", prompt: "p", kind: "vision", image: { url: "https://x/y", mime: "image/svg+xml" } }), /unsupported image type/);
  assert.match(validateJob({ id: "a", prompt: "p", kind: "vision", image: { url: "not a url", mime: "image/png" } }), /valid URL/);
  assert.match(validateJob({ id: "a", prompt: "p", kind: "poem" }), /unsupported synthesis kind/);
  assert.match(validateJob({ id: "a", prompt: "", kind: "summary" }), /no prompt/);
});

test("synthesis log labels never carry the prompt or the URL", () => {
  assert.equal(describeJob({ kind: "caption", files: 8, prompt: "SECRET" }), "caption (8 files)");
  assert.equal(describeJob({ kind: "vision", image: { url: "https://signed/abc?sig=1" } }), "vision");
  assert.equal(describeJob({ files: 1 }), "summary (1 file)");
  assert.equal(scrubUrls("fetch failed for https://signed.example/abc?sig=xyz today"), "fetch failed for [url] today");
});

test("synthesis queue: jobs that arrive mid-run are queued, not dropped, and run FIFO one at a time", async () => {
  resetSynthesisQueue();
  const order = [], reported = [];
  let active = 0, maxActive = 0;
  const run = async (job) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 15));
    order.push(job.id); active--;
    return { ok: true, text: `out:${job.id}` };
  };
  const report = async (_cfg, id, payload) => { reported.push([id, payload]); return true; };
  const cfg = { agents: [] };
  const opts = { run, report };
  const a = runSynthesisJobs(cfg, [{ id: "q1", prompt: "p", kind: "caption" }, { id: "q2", prompt: "p", kind: "answer" }], null, opts);
  await new Promise((r) => setTimeout(r, 2)); // q1 is running now
  assert.equal(synthesisQueueSize(), 1, "q2 waits");
  const b = runSynthesisJobs(cfg, [{ id: "q3", prompt: "p", kind: "summary" }, { id: "q1", prompt: "dup", kind: "caption" }], null, opts);
  await b; // enqueue only: resolves at once while a drains
  assert.equal(synthesisQueueSize(), 2, "q3 joined the queue behind q2; the duplicate q1 did not");
  await a;
  assert.deepEqual(order, ["q1", "q2", "q3"]);
  assert.equal(maxActive, 1, "never two runs at once");
  assert.deepEqual(reported.map(([id, p]) => [id, p.result]), [["q1", "out:q1"], ["q2", "out:q2"], ["q3", "out:q3"]]);
  assert.equal(synthesisQueueSize(), 0);
  // a failed run reports an error and the queue keeps going
  const r2 = [];
  await runSynthesisJobs(cfg, [{ id: "q4", prompt: "p" }, { id: "q5", prompt: "p" }], null, {
    run: async (job) => (job.id === "q4" ? { ok: false, error: "exit 1: boom https://signed/x" } : { ok: true, text: "fine" }),
    report: async (_c, id, p) => { r2.push([id, p]); return true; },
  });
  assert.deepEqual(r2, [["q4", { error: "exit 1: boom [url]" }], ["q5", { result: "fine" }]]);
  resetSynthesisQueue();
});

test("synthesis: a vision job with no image reports an error and never runs", async () => {
  resetSynthesisQueue();
  const reported = [];
  let ran = 0;
  await runSynthesisJobs({ agents: [] }, [
    { id: "v1", prompt: "look at {{IMAGE_FILE}}", kind: "vision" },
    { id: "v2", prompt: "look at {{IMAGE_FILE}}", kind: "vision", image: { url: "http://plain/x", mime: "image/png" } },
    { id: "v3", prompt: "look at {{IMAGE_FILE}}", kind: "vision", image: { url: "https://ok/x", mime: "image/bmp" } },
    { id: "t1", prompt: "caption these", kind: "caption" },
  ], null, {
    run: async (job) => { ran++; return { ok: true, text: `ran ${job.id}` }; },
    report: async (_c, id, p) => { reported.push([id, p]); return true; },
  });
  assert.equal(ran, 1, "only the caption ran");
  assert.equal(reported.length, 4);
  assert.match(reported[0][1].error, /no image/);
  assert.match(reported[1][1].error, /https/);
  assert.match(reported[2][1].error, /unsupported image type/);
  assert.deepEqual(reported[3], ["t1", { result: "ran t1" }]);
  resetSynthesisQueue();
});
