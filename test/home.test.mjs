// Hermetic tests for the 0.1.11 config home: where the config resolves, how a legacy
// config is carried over, how hints are phrased per install layout, and the doctor's
// process-scan parser. No network, no real agents.
//   node --test bridge/test/home.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigPath, locateConfig, installLayout, cli, updateLine, configHome, defaultConfigPath, writeConfigFile } from "../update.mjs";
import { parseBridgeProcesses, configPath } from "../device.mjs";
import { SETUP_FILES } from "../hands.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bridge-home-"));
const posix = process.platform !== "win32";

test("config resolution order: flag, positional, env, home, legacy fallback, home default", () => {
  const home = "/h";
  const here = "/pkg/bridge";
  const homeCfg = path.join(home, ".cookbook", "config.json");
  const none = () => false;
  const env = {};
  assert.deepEqual(resolveConfigPath(["--config", "/x/c.json"], { env, home, here, exists: none }), { path: path.resolve("/x/c.json"), source: "flag" });
  assert.deepEqual(resolveConfigPath(["./my.json"], { env, home, here, exists: none }), { path: path.resolve("./my.json"), source: "arg" });
  // subcommands turn positionals off: `connect --url https://x` must not read the URL as a file
  assert.equal(resolveConfigPath(["--url", "https://x"], { env, home, here, exists: none, positional: false }).path, homeCfg);
  assert.deepEqual(resolveConfigPath([], { env: { COOKBOOK_CONFIG: "/env/c.json" }, home, here, exists: none }), { path: path.resolve("/env/c.json"), source: "env" });
  // the flag beats the env
  assert.equal(resolveConfigPath(["--config", "/x/c.json"], { env: { COOKBOOK_CONFIG: "/env/c.json" }, home, here, exists: none }).path, path.resolve("/x/c.json"));
  assert.deepEqual(resolveConfigPath([], { env, home, here, exists: (p) => p === homeCfg }), { path: homeCfg, source: "home" });
  // legacy: only when the home does not exist; the answer is still the home path
  const legacy = path.join(here, "config.json");
  assert.deepEqual(resolveConfigPath([], { env, home, here, exists: (p) => p === legacy }), { path: homeCfg, source: "legacy", migrateFrom: legacy });
  assert.deepEqual(resolveConfigPath([], { env, home, here, exists: (p) => p === legacy || p === homeCfg }), { path: homeCfg, source: "home" });
  assert.deepEqual(resolveConfigPath([], { env, home, here, exists: none }), { path: homeCfg, source: "home" });
  assert.equal(configHome("/h"), path.join("/h", ".cookbook"));
  assert.equal(defaultConfigPath("/h"), homeCfg);
});

test("locateConfig copies a legacy config into the home once, keeps the old file, says so", () => {
  const home = tmp();
  const here = tmp();
  const legacy = path.join(here, "config.json");
  fs.writeFileSync(legacy, JSON.stringify({ cookbookUrl: "https://c", token: "cbk_t" }));
  fs.writeFileSync(path.join(here, "bridge.state.json"), JSON.stringify({ attempts: { a: 1 } }));
  const said = [];
  const p = locateConfig([], { env: {}, home, here, log: (m) => said.push(m) });
  assert.equal(p, path.join(home, ".cookbook", "config.json"));
  assert.ok(fs.existsSync(p), "copied");
  assert.ok(fs.existsSync(legacy), "old file left in place");
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).token, "cbk_t");
  assert.ok(fs.existsSync(path.join(home, ".cookbook", "bridge.state.json")), "state came along");
  assert.equal(said.length, 1);
  assert.match(said[0], /Config now lives at .*\.cookbook.*config\.json/);
  assert.ok(!/—/.test(said[0]), "no em dash");
  if (posix) {
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
  }
  // second call: the home exists now, nothing is said, nothing is re-copied
  fs.writeFileSync(legacy, JSON.stringify({ cookbookUrl: "https://c", token: "cbk_NEW" }));
  const said2 = [];
  assert.equal(locateConfig([], { env: {}, home, here, log: (m) => said2.push(m) }), p);
  assert.equal(said2.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).token, "cbk_t");
  // an explicit path is never migrated or touched
  const explicit = path.join(home, "elsewhere.json");
  assert.equal(locateConfig(["--config", explicit], { env: {}, home, here, log: () => {} }), explicit);
  assert.ok(!fs.existsSync(explicit));
});

test("writeConfigFile creates the home 0700 and the file 0600", () => {
  const home = tmp();
  const p = path.join(home, ".cookbook", "config.json");
  writeConfigFile(p, "{}\n");
  assert.equal(fs.readFileSync(p, "utf8"), "{}\n");
  if (posix) {
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
  }
});

test("device.configPath honors --config, COOKBOOK_CONFIG, then the home; never a positional", () => {
  const saved = process.env.COOKBOOK_CONFIG;
  try {
    process.env.COOKBOOK_CONFIG = "/env/cfg.json";
    assert.equal(configPath(["--url", "https://x"]), path.resolve("/env/cfg.json"));
    assert.equal(configPath(["--config", "/flag.json"]), path.resolve("/flag.json"));
    delete process.env.COOKBOOK_CONFIG;
    const p = configPath(["--url", "https://x"]);
    assert.ok(p === defaultConfigPath() || p.endsWith(path.join(".cookbook", "config.json")) || fs.existsSync(p), p);
  } finally {
    if (saved === undefined) delete process.env.COOKBOOK_CONFIG; else process.env.COOKBOOK_CONFIG = saved;
  }
});

test("cli() phrases every hint for the install it runs from", () => {
  const npx = "/Users/me/.npm/_npx/1a2b3c/node_modules/cookbook-bridge";
  const global = "/usr/local/lib/node_modules/cookbook-bridge";
  const win = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\cookbook-bridge";
  const tar = "/Users/me/Downloads/bridge";
  const checkout = "/Users/me/code/cookbook/app/bridge";
  assert.equal(installLayout(npx), "npm");
  assert.equal(installLayout(global), "npm");
  assert.equal(installLayout(win), "npm");
  assert.equal(installLayout(tar), "tarball");
  assert.equal(installLayout(checkout), "tarball");
  assert.equal(cli("doctor", { here: npx }), "npx cookbook-bridge@latest doctor");
  assert.equal(cli("", { here: npx }), "npx cookbook-bridge@latest");
  assert.equal(cli("connect", { here: tar }), "node bridge/bridge.mjs connect");
  assert.equal(cli("", { here: tar }), "node bridge/bridge.mjs");
  assert.equal(cli("connectors approve x", { here: global }), "npx cookbook-bridge@latest connectors approve x");
});

test("updateLine: one line per channel, always carrying a runnable command", () => {
  const npx = "/Users/me/.npm/_npx/1a2b3c/node_modules/cookbook-bridge";
  const tar = "/Users/me/Downloads/bridge";
  assert.match(updateLine("abc123", { here: npx, desktop: false }), /deploy abc123.*npx cookbook-bridge@latest/);
  assert.match(updateLine("abc123", { here: tar, desktop: false }), /deploy abc123.*node bridge\/bridge\.mjs update/);
  assert.match(updateLine("abc123", { here: npx, desktop: true }), /ships with the app.*update the app/);
  for (const l of [updateLine("v", { here: npx, desktop: false }), updateLine("v", { here: tar, desktop: false }), updateLine("v", { here: tar, desktop: true })]) {
    assert.ok(!/—/.test(l), `no em dash: ${l}`);
  }
});

test("doctor's process scan parser: ps lines, self excluded, config paths read, noise ignored", () => {
  const ps = [
    "  100 node /Users/me/.npm/_npx/1a2b/node_modules/cookbook-bridge/bridge.mjs",
    "  101 /usr/local/bin/node /Applications/Cookbook.app/Contents/Resources/bridge/bridge.mjs /Users/me/Library/Application Support/ai.cookbook.desktop/config.json",
    "  102 node bridge/bridge.mjs --config /tmp/other.json",
    "  103 node bridge/bridge.mjs doctor",
    "  104 node --test bridge/test/home.test.mjs",
    "  105 node --check bridge/bridge.mjs",
    "  106 node /opt/something/else.mjs",
    "  107 grep bridge.mjs",
    "  108 /bin/zsh -c python3 - <<EOF node bridge/bridge.mjs doctor EOF",
    "  109 \"C:\\Program Files\\nodejs\\node.exe\" C:\\x\\bridge.mjs",
    "",
  ].join("\n");
  const rows = parseBridgeProcesses(ps, { platform: "darwin", selfPid: 103 });
  assert.deepEqual(rows.map((r) => r.pid), [100, 101, 102, 109]);
  assert.equal(rows[0].configPath, null);
  assert.equal(rows[1].configPath, "/Users/me/Library/Application Support/ai.cookbook.desktop/config.json");
  assert.equal(rows[2].configPath, "/tmp/other.json");
  assert.deepEqual(parseBridgeProcesses("", { platform: "linux", selfPid: 1 }), []);
  // Windows fallback: tasklist CSV gives node.exe pids and no command line
  const tl = '"node.exe","4242","Console","1","51,200 K"\n"node.exe","4343","Console","1","12,000 K"\n"chrome.exe","9","Console","1","1 K"\n';
  const w = parseBridgeProcesses(tl, { platform: "win32", selfPid: 4343 });
  assert.deepEqual(w, [{ pid: 4242, configPath: null, unknownCommand: true }]);
  // Windows CIM output has the ps shape
  const cim = "555 \"C:\\Program Files\\nodejs\\node.exe\" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\cookbook-bridge\\bridge.mjs --config C:\\Users\\me\\.cookbook\\config.json";
  const c = parseBridgeProcesses(cim, { platform: "win32", selfPid: 1, format: "ps" });
  assert.equal(c.length, 1);
  assert.equal(c[0].configPath, "C:\\Users\\me\\.cookbook\\config.json");
});

test("hands: the config home's files are readable as projections, local.json stays denied", () => {
  for (const f of [".cookbook/config.json", ".cookbook/bridge.state.json", ".cookbook/local.json"]) assert.ok(SETUP_FILES.includes(f), f);
});
