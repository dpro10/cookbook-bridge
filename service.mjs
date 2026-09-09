/**
 * THE BRIDGE AS A SERVICE (2026-09-09) — install once, runs from login, updates itself.
 *
 * Before this, the terminal path ended with "leave this window open": close the
 * window or reboot and the Bridge was gone, and an npx-run copy could never update
 * itself (npm owns those files). Texas Accelerate's first Bridge lived for ninety
 * seconds. This module makes `connect` end differently:
 *
 *   1. RUNTIME  the current Bridge is downloaded from the deploy into
 *               ~/.cookbook/bridge (hash-verified against /api/bridge/manifest by
 *               update.mjs). Nothing runs from the npx cache, so the running copy
 *               is on the "self" update channel and tracks every deploy on its own.
 *   2. SERVICE  a login service runs `node ~/.cookbook/bridge/bridge.mjs <config>`
 *               with COOKBOOK_SERVICE=1 and restarts it if it exits:
 *                 macOS    a LaunchAgent in ~/Library/LaunchAgents (KeepAlive)
 *                 Windows  a hidden launcher in the user's Startup folder that
 *                          loops node until a stop file appears (no admin, no schtasks)
 *                 Linux    a systemd --user unit (Restart=always)
 *   3. START    it is started right away; `connect` waits for the Bridge's
 *               local.json to say it is up before printing the pid.
 *
 * Under a service, a self-update just exits: the supervisor restarts the new code
 * (bridge.mjs selfUpdate checks COOKBOOK_SERVICE). The config and token are never
 * touched by any of this. Everything that builds a file or a command is pure and
 * exported for scripts/test-bridge-service.ts; the I/O sits in install/uninstall.
 *
 * Why ~/.cookbook and not the app folder or the Desktop: launchd agents pointed at
 * a TCC-protected folder (Desktop, Documents) die with EX_CONFIG before spawning
 * (25 silent crash-loops on 2026-08-24). The home dot-folder is always allowed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { configHome, defaultConfigPath, checkForUpdate, applyUpdate } from "./update.mjs";

export const SERVICE_LABEL = "team.cookbook.bridge";
export const WINDOWS_TASK_NAME = "Cookbook Bridge";

/** `~/.cookbook/bridge`: the runtime the service runs. */
export function runtimeDir(home = os.homedir()) {
  return path.join(configHome(home), "bridge");
}
/** `~/.cookbook/bridge.log`: everything the service's Bridge prints. */
export function serviceLogPath(home = os.homedir()) {
  return path.join(configHome(home), "bridge.log");
}
/** `~/.cookbook/service.stop`: Windows only, tells the launcher loop to end. */
export function stopFilePath(home = os.homedir()) {
  return path.join(configHome(home), "service.stop");
}

// ── macOS ─────────────────────────────────────────────────────────────────────

export function launchdPlistPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The LaunchAgent. PATH carries node's own folder first so a version-managed node resolves. */
export function launchdPlist({ node, script, config, home, logPath, pathEnv = process.env.PATH || "" }) {
  const pathParts = [path.dirname(node), ...String(pathEnv).split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter((p, i, arr) => p && arr.indexOf(p) === i);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Cookbook Bridge: runs your agents for your team, on your subscriptions.
       Installed by \`npx cookbook-bridge@latest connect\`; remove with
       \`npx cookbook-bridge@latest uninstall\`. It updates itself from cookbook.team. -->
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(script)}</string>
    <string>${xmlEscape(config)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(path.dirname(script))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathParts.join(":"))}</string>
    <key>HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>COOKBOOK_SERVICE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

// ── Linux ─────────────────────────────────────────────────────────────────────

export function systemdUnitPath(home = os.homedir()) {
  return path.join(home, ".config", "systemd", "user", "cookbook-bridge.service");
}

export function systemdUnit({ node, script, config, home, logPath, pathEnv = process.env.PATH || "" }) {
  const pathParts = [path.dirname(node), ...String(pathEnv).split(":"), "/usr/local/bin", "/usr/bin", "/bin"]
    .filter((p, i, arr) => p && arr.indexOf(p) === i);
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=Cookbook Bridge (runs your agents for your team, on your subscriptions)
After=network-online.target

[Service]
ExecStart=${q(node)} ${q(script)} ${q(config)}
WorkingDirectory=${path.dirname(script)}
Environment=COOKBOOK_SERVICE=1
Environment=HOME=${home}
Environment=PATH=${pathParts.join(":")}
Restart=always
RestartSec=15
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

// ── Windows ───────────────────────────────────────────────────────────────────

/** The Startup folder: anything here runs at logon for this user, no admin needed. */
export function windowsStartupDir(env = process.env) {
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}
export function windowsLauncherPaths(home = os.homedir(), env = process.env) {
  return {
    cmd: path.join(configHome(home), "bridge-service.cmd"),
    vbs: path.join(configHome(home), "bridge-service.vbs"),
    startup: path.join(windowsStartupDir(env), `${WINDOWS_TASK_NAME}.vbs`),
  };
}

/** The loop: run the Bridge, wait 15s, run again, until the stop file exists. */
export function windowsCmdScript({ node, script, config, logPath, stopFile }) {
  return `@echo off
rem Cookbook Bridge service loop. Installed by "npx cookbook-bridge@latest connect";
rem remove with "npx cookbook-bridge@latest uninstall". The Bridge updates itself.
set COOKBOOK_SERVICE=1
:loop
if exist "${stopFile}" exit /b 0
"${node}" "${script}" "${config}" >> "${logPath}" 2>&1
if exist "${stopFile}" exit /b 0
timeout /t 15 /nobreak >nul
goto loop
`;
}

/** Runs the .cmd with no window. */
export function windowsVbsScript({ cmdPath }) {
  return `Set sh = CreateObject("WScript.Shell")
sh.Run "cmd.exe /c """ & "${cmdPath.replace(/"/g, '""')}" & """", 0, False
`;
}

// ── what this machine has ─────────────────────────────────────────────────────

export function serviceKind(platform = process.platform) {
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "startup";
  if (platform === "linux") return "systemd";
  return null;
}

/** The files a service install would write, per platform. Pure. */
export function servicePaths({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const kind = serviceKind(platform);
  if (kind === "launchd") return { kind, definition: launchdPlistPath(home) };
  if (kind === "systemd") return { kind, definition: systemdUnitPath(home) };
  if (kind === "startup") return { kind, definition: windowsLauncherPaths(home, env).startup };
  return { kind: null, definition: null };
}

/** pid from the running Bridge's local.json next to the config, if that pid is alive. */
export function runningPid(config) {
  try {
    const local = JSON.parse(fs.readFileSync(path.join(path.dirname(config), "local.json"), "utf8"));
    const pid = Number(local.pid);
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Installed? Running? One object for `status`, `doctor` and `connect`. */
export function serviceState({ platform = process.platform, home = os.homedir(), env = process.env, config = defaultConfigPath(home) } = {}) {
  const sp = servicePaths({ platform, home, env });
  const installed = !!sp.definition && fs.existsSync(sp.definition);
  return { kind: sp.kind, definition: sp.definition, installed, pid: runningPid(config), runtime: runtimeDir(home), log: serviceLogPath(home) };
}

// ── I/O ───────────────────────────────────────────────────────────────────────

function run(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  if (r.error) { if (allowFail) return r; throw new Error(`${cmd} ${args.join(" ")}: ${r.error.message}`); }
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  return r;
}

/**
 * Download (or refresh) the runtime into ~/.cookbook/bridge from the deploy. Uses
 * the same manifest + tar + hash verification as a self-update, so a first install
 * is just "every file is outdated". Returns { dir, version, replaced }.
 */
export async function installRuntime({ cookbookUrl, home = os.homedir(), log = () => {} } = {}) {
  const dir = runtimeDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cfg = { cookbookUrl: String(cookbookUrl || "https://cookbook.team").replace(/\/$/, "") };
  const check = await checkForUpdate(cfg, dir);
  if (check.changed.length === 0) {
    log(`Runtime is current (deploy ${check.version}) at ${dir}`);
    return { dir, version: check.version, replaced: [] };
  }
  const replaced = await applyUpdate(cfg, dir, check);
  log(`Runtime installed (deploy ${check.version}, ${replaced.length} file${replaced.length === 1 ? "" : "s"}, hash-verified) at ${dir}`);
  return { dir, version: check.version, replaced };
}

/**
 * Write the service definition, register it, and start it now. Throws with a
 * one-line reason when the platform has no supported service; callers fall back
 * to a foreground run. Never touches the config.
 */
export function installService({ platform = process.platform, home = os.homedir(), env = process.env, node = process.execPath, config = defaultConfigPath(home), log = () => {} } = {}) {
  const kind = serviceKind(platform);
  if (!kind) throw new Error(`no login service for ${platform}; run the Bridge in a terminal instead`);
  const script = path.join(runtimeDir(home), "bridge.mjs");
  if (!fs.existsSync(script)) throw new Error(`runtime missing at ${script}; install it first`);
  const logPath = serviceLogPath(home);
  fs.mkdirSync(configHome(home), { recursive: true, mode: 0o700 });

  if (kind === "launchd") {
    const plistPath = launchdPlistPath(home);
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, launchdPlist({ node, script, config, home, logPath, pathEnv: env.PATH }), { mode: 0o644 });
    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`;
    run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`], { allowFail: true }); // replace a previous install
    run("launchctl", ["bootstrap", domain, plistPath]);
    run("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`], { allowFail: true });
    log(`LaunchAgent installed: ${plistPath}`);
    return { kind, definition: plistPath, log: logPath };
  }
  if (kind === "systemd") {
    const unitPath = systemdUnitPath(home);
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, systemdUnit({ node, script, config, home, logPath, pathEnv: env.PATH }), { mode: 0o644 });
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "cookbook-bridge.service"]);
    run("systemctl", ["--user", "restart", "cookbook-bridge.service"], { allowFail: true });
    log(`systemd user unit installed: ${unitPath} (run \`loginctl enable-linger $USER\` once if this machine has no desktop session)`);
    return { kind, definition: unitPath, log: logPath };
  }
  // Windows: a hidden launcher in the Startup folder. No admin, no Task Scheduler.
  const p = windowsLauncherPaths(home, env);
  try { fs.rmSync(stopFilePath(home), { force: true }); } catch { /* none */ }
  fs.writeFileSync(p.cmd, windowsCmdScript({ node, script, config, logPath, stopFile: stopFilePath(home) }));
  fs.writeFileSync(p.vbs, windowsVbsScript({ cmdPath: p.cmd }));
  fs.mkdirSync(path.dirname(p.startup), { recursive: true });
  fs.copyFileSync(p.vbs, p.startup);
  // Start it now, detached and windowless, the same way the Startup folder will.
  const child = spawn("wscript.exe", ["//B", p.vbs], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
  log(`Startup launcher installed: ${p.startup}`);
  return { kind, definition: p.startup, log: logPath };
}

/** Stop the service and remove its definition. Leaves the runtime, config and log. */
export function uninstallService({ platform = process.platform, home = os.homedir(), env = process.env, config = defaultConfigPath(home), log = () => {} } = {}) {
  const kind = serviceKind(platform);
  const removed = [];
  if (kind === "launchd") {
    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`;
    run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`], { allowFail: true });
    const plistPath = launchdPlistPath(home);
    if (fs.existsSync(plistPath)) { fs.rmSync(plistPath, { force: true }); removed.push(plistPath); }
  } else if (kind === "systemd") {
    run("systemctl", ["--user", "disable", "--now", "cookbook-bridge.service"], { allowFail: true });
    const unitPath = systemdUnitPath(home);
    if (fs.existsSync(unitPath)) { fs.rmSync(unitPath, { force: true }); removed.push(unitPath); }
    run("systemctl", ["--user", "daemon-reload"], { allowFail: true });
  } else if (kind === "startup") {
    const p = windowsLauncherPaths(home, env);
    fs.writeFileSync(stopFilePath(home), String(Date.now())); // the loop exits on its next turn
    for (const f of [p.startup, p.vbs, p.cmd]) if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(f); }
  }
  const pid = runningPid(config);
  if (pid) {
    try {
      if (platform === "win32") run("taskkill", ["/PID", String(pid), "/T", "/F"], { allowFail: true });
      else process.kill(pid, "SIGTERM");
      log(`Stopped the running Bridge (pid ${pid}).`);
    } catch { /* already gone */ }
  }
  return { kind, removed };
}

/** Restart the supervised Bridge (the supervisor brings it back on the new code/config). */
export function restartService({ platform = process.platform, home = os.homedir(), config = defaultConfigPath(home) } = {}) {
  const kind = serviceKind(platform);
  if (kind === "launchd") {
    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`;
    run("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`]);
    return true;
  }
  if (kind === "systemd") { run("systemctl", ["--user", "restart", "cookbook-bridge.service"]); return true; }
  const pid = runningPid(config);
  if (pid) { run("taskkill", ["/PID", String(pid), "/T", "/F"], { allowFail: true }); return true; }
  return false;
}

/** Wait for the service's Bridge to write local.json with a live pid. */
export async function waitForBridge(config, { timeoutMs = 25_000, everyMs = 500 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const pid = runningPid(config);
    if (pid) return pid;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}
