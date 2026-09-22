/**
 * THE LAUNCHER: the Cookbook Bridge as one file, no Node.js required (2026-09-17).
 *
 * `bun build --compile` turns this module (and update.mjs, bundled at build time)
 * into `cookbook-bridge` for each platform: a binary that carries its own
 * JavaScript runtime. A brand-new Windows machine answered "npx.cmd is not
 * recognized" to the Connect page; this is the answer to that.
 *
 * It does deliberately little. The Bridge itself stays the plain .mjs files that
 * every install already runs and that the manifest updater already keeps
 * current (~/.cookbook/bridge, hash-verified against /api/bridge/manifest). The
 * launcher only:
 *   1. makes sure that runtime exists (first run downloads it from Cookbook), and
 *   2. runs it, exactly as `node bridge.mjs <args>` would.
 * So a self-update still swaps .mjs files and re-execs; the binary itself rarely
 * changes. It also stands in for `node`: `cookbook-bridge <path>/bridge.mjs
 * <config>` runs that script, which is how the login service (service.mjs) is
 * written and how the Bridge re-execs itself.
 *
 * Build:   scripts/build-launcher.sh      (five platforms, sha256 sums, launcher.lock.json)
 * Publish: scripts/publish-launcher.mjs   (a GitHub release on the public cookbook-bridge repo)
 * Install: public/install.sh, public/install.ps1 (served from cookbook.team)
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configHome, resolveConfigPath, checkForUpdate, applyUpdate } from "./update.mjs";

export const LAUNCHER_VERSION = "1.0.1";
/** bridge.mjs learned to trust argv under the launcher on 2026-09-17; older copies
 *  import as a library and exit in silence. This marker tells the two apart. */
const RUNTIME_MARKER = "__cookbookLauncher";

// A compiled bun binary sees argv as ["bun", "/$bunfs/root/<entry>", ...user args].
const args = process.argv.slice(2);

function say(line) { try { process.stderr.write(`${line}\n`); } catch { /* stderr gone */ } }

/** `cookbook-bridge /path/to/x.mjs …`: the first argument names a script to run. */
function namesScript(a) {
  return typeof a === "string" && /\.(mjs|cjs|js)$/i.test(a) && !a.startsWith("-");
}

/** Where to fetch the runtime from: COOKBOOK_URL, else the config these args name
 *  (a scratch config on a dev server, a self-hosted Cookbook), else production. */
function cookbookUrlFor(bridgeArgs) {
  if (process.env.COOKBOOK_URL) return String(process.env.COOKBOOK_URL).replace(/\/$/, "");
  // resolveConfigPath reads `--config <p>`, then a bare first argument (a subcommand
  // like `doctor` is not a file, so that candidate simply fails to read), then
  // COOKBOOK_CONFIG, then ~/.cookbook/config.json.
  for (const candidate of [bridgeArgs, []]) {
    try {
      const url = JSON.parse(fs.readFileSync(resolveConfigPath(candidate).path, "utf8")).cookbookUrl;
      if (url) return String(url).replace(/\/$/, "");
    } catch { /* not a config; next candidate */ }
  }
  return "https://cookbook.team";
}

/** The config these args name, parsed, or null. */
function configFor(bridgeArgs) {
  for (const candidate of [bridgeArgs, []]) {
    try { return JSON.parse(fs.readFileSync(resolveConfigPath(candidate).path, "utf8")); } catch { /* next */ }
  }
  return null;
}

/**
 * A typed command runs current code. `connect` on a machine whose runtime predates the
 * deploy used to install a service with last week's service.mjs (the Windows Startup
 * mkdir bug, 2026-09-18, needed three runs to clear). Bounded, fail-soft: a slow or
 * absent network just runs what is there. `"autoUpdate": false` in the config pins it.
 */
async function refreshRuntime(dir, bridgeArgs) {
  const cfg = configFor(bridgeArgs);
  if (cfg && cfg.autoUpdate === false) return;
  const cookbookUrl = cookbookUrlFor(bridgeArgs);
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000));
  try {
    const check = await Promise.race([checkForUpdate({ cookbookUrl }, dir), timeout]);
    if (check === "timeout" || !check || !check.changed || !check.changed.length) return;
    say(`Updating the Bridge to deploy ${check.version} (${check.changed.length} file${check.changed.length === 1 ? "" : "s"})…`);
    await applyUpdate({ cookbookUrl }, dir, check);
    writeVersion(dir, check.version);
  } catch (e) {
    say(`(could not check for a Bridge update: ${e && e.message ? e.message : e}; running the installed copy)`);
  }
}

function runtimeKnowsLauncher(main) {
  try { return fs.readFileSync(main, "utf8").includes(RUNTIME_MARKER); } catch { return false; }
}

/** The runtime dir (~/.cookbook/bridge), downloading the Bridge into it on first run
 *  and refreshing it when the copy there predates this launcher. */
async function ensureRuntime(bridgeArgs) {
  // Same home as the Bridge itself (os.homedir(): HOME on POSIX, USERPROFILE on Windows).
  const dir = path.join(configHome(), "bridge");
  const main = path.join(dir, "bridge.mjs");
  const fresh = !fs.existsSync(main);
  if (!fresh && runtimeKnowsLauncher(main)) return { dir, main, installed: false };
  const cookbookUrl = cookbookUrlFor(bridgeArgs);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  say(fresh ? `Downloading the Cookbook Bridge from ${cookbookUrl}…` : `The Bridge at ${dir} predates this launcher; updating it from ${cookbookUrl}…`);
  const cfg = { cookbookUrl };
  const check = await checkForUpdate(cfg, dir);
  if (check.changed.length) await applyUpdate(cfg, dir, check);
  writeVersion(dir, check.version);
  if (!runtimeKnowsLauncher(main)) {
    throw new Error(`${cookbookUrl} serves a Bridge older than this launcher (no ${RUNTIME_MARKER} in bridge.mjs). Point COOKBOOK_URL at a current Cookbook, or run the npm Bridge: npx cookbook-bridge@latest`);
  }
  say(`Bridge runtime ${check.version} ${fresh ? "installed at" : "updated in"} ${dir}`);
  return { dir, main, installed: true };
}

/** version.json beside the runtime, so a trace can name the deploy it ran on. */
function writeVersion(dir, version) {
  try { fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ version: String(version), launcher: LAUNCHER_VERSION }) + "\n"); } catch { /* cosmetic */ }
}

async function main() {
  if (args[0] === "--launcher-version") { process.stdout.write(`${LAUNCHER_VERSION}\n`); return; }
  if (args[0] === "--version" || args[0] === "-v") {
    // What `node --version` would have said; the hands probe and humans both ask.
    process.stdout.write(`cookbook-bridge ${LAUNCHER_VERSION} (bun ${process.versions.bun || "?"})\n`);
    return;
  }
  let script, rest;
  if (namesScript(args[0])) {
    // Stand in for node: the service runs `cookbook-bridge ~/.cookbook/bridge/bridge.mjs <config>`,
    // a re-exec runs the same, an MCP relay runs `cookbook-bridge approve-mcp.mjs`.
    script = path.resolve(args[0]);
    rest = args.slice(1);
    const rt = path.join(configHome(), "bridge");
    if (path.dirname(script) === rt && (!fs.existsSync(script) || (path.basename(script) === "bridge.mjs" && !runtimeKnowsLauncher(script)))) {
      // The service definition outlived its runtime dir (someone cleaned ~/.cookbook/bridge),
      // or the runtime there is older than this launcher: put a current one back.
      await ensureRuntime(rest);
    }
    if (!fs.existsSync(script)) throw new Error(`no such script: ${script}`);
  } else {
    const rt = await ensureRuntime(args);
    if (!rt.installed) await refreshRuntime(rt.dir, args);
    script = rt.main;
    rest = args;
  }
  // bridge.mjs reads process.argv the way node hands it over: [exec, script, ...args],
  // and its main-module check trusts argv when this flag is set (it is imported here,
  // so import.meta.main is false there).
  globalThis.__cookbookLauncher = true;
  process.argv = [process.execPath, script, ...rest];
  await import(pathToFileURL(script).href);
}

main().catch((e) => {
  say(`cookbook-bridge: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
