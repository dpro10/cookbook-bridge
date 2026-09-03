// Hermetic tests for Bridge Local (bridge/local.mjs): no network, no real agents.
//   node --test bridge/test/local.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalServer, validateFolder, toolsForMode, modeForTools, vendorOf, MODE_TOOLS, readLocalJson } from "../local.mjs";

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-local-"));
  fs.mkdirSync(path.join(home, "projects", "foo"), { recursive: true });
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, "projects", "file.txt"), "x");
  return home;
}

test("modes map to allowlists and back", () => {
  assert.equal(toolsForMode("run"), MODE_TOOLS.run);
  assert.equal(toolsForMode("nope"), null);
  assert.equal(modeForTools(MODE_TOOLS.read), "read");
  assert.equal(modeForTools(MODE_TOOLS.edit), "edit");
  assert.equal(modeForTools(MODE_TOOLS.run), "run");
  assert.equal(modeForTools("Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,mcp__cookbook__*"), "run"); // legacy DEFAULT_LOCAL_TOOLS
  assert.ok(!MODE_TOOLS.read.includes("Write") && !MODE_TOOLS.read.includes("Bash"));
  assert.ok(MODE_TOOLS.edit.includes("Write") && !MODE_TOOLS.edit.includes("Bash"));
});

test("validateFolder: only real directories under home, never credential dirs", () => {
  const home = tmpHome();
  assert.equal(validateFolder(path.join(home, "projects", "foo"), home).ok, true);
  assert.equal(validateFolder("projects/foo", home).ok, false);
  assert.equal(validateFolder(path.join(home, "projects", "missing"), home).ok, false);
  assert.equal(validateFolder(path.join(home, "projects", "file.txt"), home).ok, false);
  assert.equal(validateFolder(home, home).ok, false);
  assert.equal(validateFolder(path.join(home, ".ssh"), home).ok, false);
  assert.equal(validateFolder(os.tmpdir() === home ? "/" : "/", home).ok, false);
});

test("vendorOf reads the command", () => {
  assert.equal(vendorOf({ command: ["claude", "-p"] }), "claude");
  assert.equal(vendorOf({ command: ["/opt/homebrew/bin/claude"] }), "claude");
  assert.equal(vendorOf({ command: ["/Applications/ChatGPT.app/Contents/Resources/codex"], runner: "app-server" }), "codex");
  assert.equal(vendorOf({ command: ["agy"] }), "gemini");
  assert.equal(vendorOf({ runner: "robot" }), "robot");
});

async function withServer(fn) {
  const home = tmpHome();
  const cfgPath = path.join(home, "config.json");
  const cfg = { cookbookUrl: "https://cookbook.team", token: "t", agents: [], localWorkspaces: {} };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const calls = { restart: 0, applied: 0 };
  const srv = createLocalServer({
    cfg, cfgPath, version: "test", log: () => {}, home,
    doctor: async () => ({ fails: 1, warns: 0, rows: [{ level: "bad", label: "x", fix: "y" }] }),
    detectAgents: () => [{ name: "Claude", vendor: "claude", binary: "/x/claude", found: true, enabled: true, runner: "cli" }],
    startConnect: async () => ({ approveUrl: "https://cookbook.team/account/bridge/authorize?c=1", userCode: "ABCD-EFGH", expiresAt: "2030-01-01T00:00:00Z", agents: ["Claude"], done: Promise.resolve({ results: [{ agent: "Claude", ok: true, detail: "ok" }] }) }),
    applyConfig: () => { calls.applied++; },
    restart: () => { calls.restart++; },
    hotWorkspaceIds: () => new Set(["w1"]),
    connected: () => true,
    lastError: () => null,
  });
  const { port, token } = await srv.start();
  const base = `http://127.0.0.1:${port}`;
  const call = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { "X-Bridge-Token": token, "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    await fn({ base, token, call, cfg, cfgPath, home, calls, srv });
  } finally {
    srv.stop();
  }
}

test("local.json is written with the port and token, removed on stop", async () => {
  await withServer(async ({ port, token, cfgPath, srv }) => {
    const doc = readLocalJson(cfgPath);
    assert.ok(doc && doc.port > 0 && doc.token === token);
    assert.equal(doc.pid, process.pid);
    srv.stop();
    assert.equal(readLocalJson(cfgPath), null);
  });
});

test("auth: no token → 401; preflight works without a token; foreign origin gets no CORS grant", async () => {
  await withServer(async ({ base, token }) => {
    const noTok = await fetch(base + "/status");
    assert.equal(noTok.status, 401);
    const pre = await fetch(base + "/folders", { method: "OPTIONS", headers: { Origin: "https://cookbook.team", "Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://cookbook.team");
    assert.equal(pre.headers.get("access-control-allow-private-network"), "true");
    const evil = await fetch(base + "/status", { headers: { "X-Bridge-Token": token, Origin: "https://evil.example" } });
    assert.equal(evil.status, 200);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });
});

test("status reports agents, folders, hot workspaces", async () => {
  await withServer(async ({ call }) => {
    const s = await (await call("GET", "/status")).json();
    assert.equal(s.ok, true);
    assert.equal(s.version, "test");
    assert.equal(s.agents[0].vendor, "claude");
    assert.deepEqual(s.hotWorkspaceIds, ["w1"]);
    assert.deepEqual(s.localWorkspaces, []);
  });
});

test("folders: validate, persist to config.json, hot-apply, delete", async () => {
  await withServer(async ({ call, cfg, cfgPath, home }) => {
    const wsId = "11111111-2222-4333-8444-555555555555";
    const bad = await call("POST", "/folders", { workspaceId: wsId, cwd: path.join(home, ".ssh"), mode: "edit" });
    assert.equal(bad.status, 400);
    const badId = await call("POST", "/folders", { workspaceId: "nope", cwd: path.join(home, "projects", "foo") });
    assert.equal(badId.status, 400);
    const ok = await call("POST", "/folders", { workspaceId: wsId, cwd: path.join(home, "projects", "foo"), mode: "read" });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.mode, "read");
    assert.equal(body.allowedTools, MODE_TOOLS.read);
    assert.equal(cfg.localWorkspaces[wsId].allowedTools, MODE_TOOLS.read); // hot
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(onDisk.localWorkspaces[wsId].mode, "read");
    assert.equal(onDisk.token, "t"); // untouched
    const del = await call("DELETE", `/folders/${wsId}`);
    assert.equal(del.status, 200);
    assert.equal(cfg.localWorkspaces[wsId], undefined);
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, "utf8")).localWorkspaces[wsId], undefined);
  });
});

test("doctor, connect-agents, restart route through deps", async () => {
  await withServer(async ({ call, calls }) => {
    const d = await (await call("POST", "/doctor")).json();
    assert.equal(d.fails, 1);
    assert.equal(d.rows[0].fix, "y");
    const c = await (await call("POST", "/connect-agents")).json();
    assert.equal(c.state, "pending");
    assert.match(c.approveUrl, /authorize/);
    await new Promise((r) => setTimeout(r, 20));
    const c2 = await (await call("GET", "/connect-agents")).json();
    assert.equal(c2.state, "done");
    assert.equal(c2.results[0].ok, true);
    assert.equal(calls.applied, 1);
    const r = await (await call("POST", "/restart")).json();
    assert.equal(r.ok, true);
    await new Promise((r2) => setTimeout(r2, 200));
    assert.equal(calls.restart, 1);
  });
});

test("events: SSE delivers run events (token via query param, for EventSource)", async () => {
  await withServer(async ({ base, token, srv }) => {
    assert.equal((await fetch(base + "/events?token=wrong")).status, 401);
    const res = await fetch(base + "/events?token=" + token);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body.getReader();
    srv.emit("run", { state: "done", title: "t" });
    let text = "";
    const deadline = Date.now() + 2000;
    while (!text.includes("event: run") && Date.now() < deadline) {
      const { value } = await reader.read();
      text += Buffer.from(value).toString();
    }
    assert.match(text, /event: run\ndata: {"state":"done","title":"t"}/);
    reader.cancel();
  });
});
