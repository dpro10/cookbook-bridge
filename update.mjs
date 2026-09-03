/**
 * Bridge self-updater — "when the app updates, so does the Bridge."
 *
 * The app deploy is the version source of truth: /api/bridge/manifest publishes a sha256
 * per runtime file (computed from what the deploy is actually serving) + a combined
 * version hash. This module hashes the LOCAL files, compares, and applies updates by
 * downloading the same tar every user installs from — verifying every extracted file
 * against the manifest before a single byte on disk changes. The user's config.json
 * (and its token) is NEVER touched.
 *
 * Trust posture (see /security): same-origin as the install itself, hash-verified,
 * old files kept in bridge.backup/, plain readable JS, and `"autoUpdate": false` pins
 * the version entirely. Auto-updates re-exec the running Bridge so fleets track deploys
 * within one check interval.
 *
 * Pure helpers (hashing, comparison, tar parsing) are exported for
 * scripts/test-bridge-update.ts; I/O lives in checkForUpdate/applyUpdate.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── The Bridge's home + how to phrase a command ─────────────────────────────
// These live HERE (node built-ins only, imported by every command including the
// broken-install `update` path) so that connecting, running and updating all
// agree on where the config is and on what command to print. Before 0.1.11 the
// config sat next to bridge.mjs, which meant an npx cache: every `@latest` moved
// the Bridge to a new folder and lost its config, and every hint said
// `node bridge/bridge.mjs` to people who had never unpacked a tarball.

/** `~/.cookbook`: config.json, bridge.state.json, local.json and bridge.log live here. */
export function configHome(home = os.homedir()) {
  return path.join(home, ".cookbook");
}

export function defaultConfigPath(home = os.homedir()) {
  return path.join(configHome(home), "config.json");
}

/**
 * Where the config is, as data (no writes). Order:
 *   1. `--config <path>`, or (when `positional` is on) the first bare argument
 *   2. COOKBOOK_CONFIG
 *   3. ~/.cookbook/config.json when it exists
 *   4. legacy <here>/config.json when it exists and 3 does not: the answer is still
 *      the home path, with `migrateFrom` set so locateConfig can copy it over
 *   5. ~/.cookbook/config.json (the place a first `connect` will write)
 * Pure so the order is testable: `exists`, `env`, `home` and `here` are injectable.
 */
export function resolveConfigPath(args = [], { env = process.env, home = os.homedir(), here = HERE, exists = fs.existsSync, positional = true } = {}) {
  const list = Array.isArray(args) ? args : [];
  const i = list.indexOf("--config");
  if (i >= 0 && list[i + 1]) return { path: path.resolve(list[i + 1]), source: "flag" };
  if (positional) {
    const bare = list.find((a) => a && !String(a).startsWith("-"));
    if (bare) return { path: path.resolve(bare), source: "arg" };
  }
  if (env && env.COOKBOOK_CONFIG) return { path: path.resolve(env.COOKBOOK_CONFIG), source: "env" };
  const homePath = defaultConfigPath(home);
  if (exists(homePath)) return { path: homePath, source: "home" };
  const legacy = here ? path.join(here, "config.json") : null;
  if (legacy && exists(legacy)) return { path: homePath, source: "legacy", migrateFrom: legacy };
  return { path: homePath, source: "home" };
}

/** Create the home dir owner-only (0700). Best effort on platforms without modes. */
export function ensureConfigHome(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* win32 */ }
  return dir;
}

/** Owner-only write of a config file (0600), creating its dir (0700) first. */
export function writeConfigFile(p, text) {
  ensureConfigHome(path.dirname(p));
  fs.writeFileSync(p, text, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* win32 */ }
}

/**
 * resolveConfigPath + the one side effect: a legacy <here>/config.json is COPIED to
 * the home (the old file stays where it was) and one line says where the config now
 * lives. Returns the path every command should use. Also carries bridge.state.json
 * over when it sits next to the legacy config, so attempt counters survive the move.
 */
export function locateConfig(args = [], opts = {}) {
  const { log = (m) => console.error(m) } = opts;
  const r = resolveConfigPath(args, opts);
  if (r.source === "legacy" && r.migrateFrom) {
    try {
      writeConfigFile(r.path, fs.readFileSync(r.migrateFrom));
      const oldState = path.join(path.dirname(r.migrateFrom), "bridge.state.json");
      const newState = path.join(path.dirname(r.path), "bridge.state.json");
      if (fs.existsSync(oldState) && !fs.existsSync(newState)) {
        try { fs.copyFileSync(oldState, newState); } catch { /* counters are advisory */ }
      }
      log(`Config now lives at ${r.path} (copied from ${r.migrateFrom}; the old file was left in place).`);
    } catch (e) {
      // Can't create the home: keep working from the legacy file rather than fail.
      log(`Could not move the config to ${r.path} (${e.message}); still using ${r.migrateFrom}.`);
      return r.migrateFrom;
    }
  }
  return r.path;
}

/**
 * How was this copy installed? Decides how every hint spells a command.
 *   "npm"     an npx cache (`_npx`) or an npm install (`node_modules/cookbook-bridge`)
 *   "tarball" bridge.mjs unpacked from the download (or a source checkout)
 */
export function installLayout(here = HERE) {
  const n = String(here).replace(/\\/g, "/") + "/";
  if (n.includes("/_npx/") || n.includes("/node_modules/cookbook-bridge/")) return "npm";
  return "tarball";
}

/** The ONE way to print a Bridge command: `cli("doctor")` reads `npx cookbook-bridge@latest doctor`
 *  on an npm install and `node bridge/bridge.mjs doctor` from a tarball. Bare `cli()` is the run command. */
export function cli(cmd = "", { here = HERE } = {}) {
  const base = installLayout(here) === "npm" ? "npx cookbook-bridge@latest" : "node bridge/bridge.mjs";
  return cmd ? `${base} ${cmd}` : base;
}

/** The exact line printed when the local files are behind the deploy. Shared by the
 *  running Bridge's startup check, `doctor` and `connect`, so they never disagree. */
export function updateLine(version, { here = HERE, desktop = process.env.COOKBOOK_DESKTOP === "1" } = {}) {
  if (desktop) return `A newer Bridge ships with the app (deploy ${version}). The Cookbook app manages this copy; update the app to pick it up.`;
  if (installLayout(here) === "npm") return `A newer Bridge is available (deploy ${version}). Update it with:  ${cli("", { here })}   (@latest fetches the new copy; your config stays in ~/.cookbook)`;
  return `A newer Bridge is available (deploy ${version}). Update it with:  ${cli("update", { here })}`;
}

/** Files the updater manages — must mirror the server's BRIDGE_RUNTIME_FILES. The list
 *  itself comes from the MANIFEST at update time (server-driven), so a future deploy can
 *  add files without this constant; this is only the local-hash candidate set. */
export const LOCAL_FILES_GLOB = /\.(mjs|md)$/i;

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Hash the local runtime files that exist (missing files = trivially outdated). */
export function localManifest(dir, names) {
  const files = {};
  for (const name of names) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) files[name] = sha256(fs.readFileSync(p));
  }
  return files;
}

/** Compare local hashes to the remote manifest → the files that need replacing. */
export function diffManifest(remoteFiles, localFiles) {
  return Object.keys(remoteFiles).filter((name) => localFiles[name] !== remoteFiles[name]);
}

/** Minimal ustar reader (mirror of the server's zero-dep writer): {name → Buffer}. */
export function untar(buf) {
  const out = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // terminator blocks
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8) || 0;
    const body = buf.subarray(off + 512, off + 512 + size);
    if (name) out[name] = Buffer.from(body);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/**
 * Check the deploy's manifest against local files. Returns
 * { version, changed: [names] } — changed.length === 0 means up to date.
 * Throws on network/shape errors (callers treat check failures as non-fatal).
 */
export async function checkForUpdate(cfg, dir) {
  const res = await fetch(`${cfg.cookbookUrl}/api/bridge/manifest`, { headers: { "Cache-Control": "no-store" } });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const manifest = await res.json();
  if (!manifest || typeof manifest.files !== "object") throw new Error("malformed manifest");
  const local = localManifest(dir, Object.keys(manifest.files));
  return { version: manifest.version, files: manifest.files, changed: diffManifest(manifest.files, local) };
}

/** A filesystem-safe backup subdir name for a manifest version (falls back to a
 *  monotonic-ish label when no version is given). Exported for the test. */
export function backupDirName(version) {
  const v = String(version || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return v || "prev";
}

/**
 * Apply an update: download the tar, VERIFY every runtime file against the manifest
 * hashes (any mismatch aborts before any write), back up current files to a
 * PER-VERSION bridge.backup/<version>/ dir, then replace ATOMICALLY (write each to a
 * .tmp and rename; roll back from the backup if any rename fails mid-way). Never writes
 * config.json. Returns the replaced names.
 *
 * Two audit-2026-07-03 fixes vs the old flat overwrite: (#14a) a bad-but-hash-valid
 * update N+1 can no longer clobber update N's last-good backup — each version keeps its
 * own; (#14b) a mid-loop write failure (disk full, EACCES) no longer leaves a mixed
 * old/new install that crashes lazy module loading on next start — it's rename-based and
 * rolls back.
 */
export async function applyUpdate(cfg, dir, manifest) {
  const res = await fetch(`${cfg.cookbookUrl}/api/bridge/download`);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const tar = untar(gunzipSync(Buffer.from(await res.arrayBuffer())));

  // Verify EVERYTHING the manifest names, before touching disk.
  const verified = {};
  for (const [name, wantHash] of Object.entries(manifest.files)) {
    const data = tar[`bridge/${name}`];
    if (!data) throw new Error(`update aborted: ${name} missing from archive`);
    const got = sha256(data);
    if (got !== wantHash) throw new Error(`update aborted: ${name} hash mismatch (archive ${got.slice(0, 12)}… ≠ manifest ${String(wantHash).slice(0, 12)}…)`);
    verified[name] = data;
  }

  // Per-version backup dir — never overwrites a prior version's last-good copies.
  const backupDir = path.join(dir, "bridge.backup", backupDirName(manifest.version));
  fs.mkdirSync(backupDir, { recursive: true });

  // 1. Write every new file to a sibling .tmp and back up the current one. No live
  //    file is replaced yet, so a failure here leaves the install fully intact.
  const staged = []; // { name, target, tmp, backup|null }
  try {
    for (const [name, data] of Object.entries(verified)) {
      const target = path.join(dir, name);
      const tmp = target + ".tmp";
      let backup = null;
      if (fs.existsSync(target)) {
        backup = path.join(backupDir, name);
        fs.copyFileSync(target, backup);
      }
      fs.writeFileSync(tmp, data, { mode: name.endsWith(".mjs") ? 0o755 : 0o644 });
      staged.push({ name, target, tmp, backup });
    }
  } catch (e) {
    for (const s of staged) { try { fs.rmSync(s.tmp, { force: true }); } catch { /* ignore */ } }
    throw new Error(`update aborted before any live file changed: ${e.message}`);
  }

  // 2. Rename each staged .tmp over its target. If one fails, roll the already-renamed
  //    ones back from their backups so we never leave a half-old/half-new install.
  const done = [];
  try {
    for (const s of staged) {
      fs.renameSync(s.tmp, s.target);
      done.push(s);
    }
  } catch (e) {
    for (const s of done) { if (s.backup) { try { fs.copyFileSync(s.backup, s.target); } catch { /* best-effort */ } } }
    for (const s of staged) { try { fs.rmSync(s.tmp, { force: true }); } catch { /* ignore */ } }
    throw new Error(`update rolled back (rename failed on ${e.message}) — still on the previous version`);
  }
  return done.map((s) => s.name);
}
