/**
 * HANDS — the host half of a hardware grant (migration 0069).
 *
 * A visiting agent (running on someone else's machine, on their subscription)
 * queues a call; this file is what actually touches THIS machine. It is the policy
 * enforcement point, not the server: the server records intent and relays it, and
 * everything below re-derives the rules from the grant it was handed. A server that
 * is compromised, buggy, or lying still cannot make this run something the grant
 * doesn't allow.
 *
 * The rules, in the order they are applied to every call:
 *   1. VERB TABLE ONLY. There is no shell. `run` executes fixed argv templates with
 *      parameters substituted into named slots — never a string a visitor composed.
 *   2. THERE IS A LOCAL CEILING THE SERVER CANNOT RAISE. The scope arrives with the
 *      call, so it is server-attested and cannot be trusted on its own: a lying
 *      server would otherwise just send `auto:{write:true}, folders:["/"]`. Every
 *      call is therefore authorized against the INTERSECTION of what the server says
 *      the host granted and what THIS MACHINE will ever do (LOCAL_CEILING plus the
 *      folders in the host's own config). Risk is re-derived here too, and a class
 *      that needs a human runs only if the row already says `approved`.
 *   3. PATHS ARE CONTAINED. A path must resolve (after symlinks) into the grant's
 *      folders or the fixed setup-file allowlist, and must never match the
 *      never-read list — which wins over everything, including an explicit grant.
 *   4. NOTHING LEAVES UNREDACTED. Every byte of output passes through redact()
 *      before it is returned, and the server runs the same function again.
 *
 * Node built-ins only. No dependencies.
 */
import fs from "node:fs";
import os from "node:os";
import { kimiLoginState } from "./harden.mjs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// REDACTION
//
// This is a byte-identical port of src/lib/workspaces/redact.ts. The Bridge is
// dependency-free .mjs and cannot import TypeScript, so the implementation lives
// twice — and `npm run test:hands-redact` runs BOTH over the same corpus and fails
// if they ever disagree. Change one, change the other, in the same commit.
// ─────────────────────────────────────────────────────────────────────────────

export const MASK = "[redacted]";

const RULES = [
  // ── whole private-key blocks. The body is BOUNDED: an unbounded lazy [\s\S]*?
  // against repeated unterminated BEGIN markers is quadratic, and this function runs
  // on attacker-influenced input.
  { re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]{0,8192}?-----END[ A-Z]*PRIVATE KEY-----/g, to: `${MASK}-private-key` },
  { re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/g, to: `${MASK}-private-key` },

  // ── Cookbook's own credentials ────────────────────────────────────────────
  { re: /cbk_mcp_[A-Za-z0-9_-]+/g, to: `cbk_mcp_${MASK}` },
  { re: /cbk_at_[A-Za-z0-9_-]+/g, to: `cbk_at_${MASK}` },
  { re: /cbk_rt_[A-Za-z0-9_-]+/g, to: `cbk_rt_${MASK}` },

  // ── vendor credentials ────────────────────────────────────────────────────
  { re: /sk-ant-[A-Za-z0-9_-]+/g, to: `sk-ant-${MASK}` },
  { re: /sk-proj-[A-Za-z0-9_-]+/g, to: `sk-proj-${MASK}` },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, to: `sk-${MASK}` },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, to: `gh_${MASK}` },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, to: `github_pat_${MASK}` },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: `AKIA${MASK}` },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, to: `AIza${MASK}` },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, to: `xox-${MASK}` },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, to: `eyJ${MASK}` },

  // ── CONNECTION STRINGS: postgres://user:pw@host, redis://, mongodb+srv://,
  // amqp://, and any https://user:pass@… in a git remote. No keyword appears
  // anywhere near these, so nothing else here would catch them.
  { re: /\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s:@/]{1,128}):[^\s@/]{1,256}@/gi, to: `$1://$2:${MASK}@` },

  // ── transport headers, line-anchored (a quoted JSON key is handled below,
  // which preserves the quotes so the file stays parseable).
  { re: /(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, to: `$1 ${MASK}` },
  { re: /^([ \t]*(?:Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|Cookie|Set-Cookie))[ \t]*:[ \t]*.+$/gim, to: `$1: ${MASK}` },

  // ── .netrc shape: space-separated, no delimiter the generic rules look for.
  { re: /\b(password|passwd|login)[ \t]+\S{1,256}/gi, to: `$1 ${MASK}` },

  // ── generic key/value sweeps (JSON, TOML, YAML, dotenv, .npmrc).
  // The key class is BOUNDED ({0,64}) on both sides: unbounded [A-Za-z0-9_.-]* around
  // an alternation backtracks quadratically on a long line with no delimiter. It
  // admits ':' and '/' so an .npmrc line (//registry…/:_authToken=…) is caught, and
  // excludes quotes so a quoted JSON key falls to the rule above, which keeps them.
  {
    re: /("[^"\n]{0,64}(?:token|secret|password|passwd|key|credential|client[_-]?secret|refresh|authorization|bearer|cookie|session|pat)[^"\n]{0,64}"\s*:\s*)"[^"]{0,4096}"/gi,
    to: `$1"${MASK}"`,
  },
  {
    re: /^([ \t]*(?:export[ \t]+)?[^\s="']{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|CLIENT[_-]?SECRET|AUTHORIZATION|SESSION|PAT)[^\s="']{0,64}[ \t]*[:=][ \t]*)(?:"[^"\n]{0,4096}"|'[^'\n]{0,4096}'|[^\s#]{1,4096})/gim,
    to: `$1${MASK}`,
  },
];

function collapseHome(text, home) {
  const h = String(home ?? "").replace(/\/+$/, "");
  if (!h || h.length < 4) return text;
  const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(esc + "(?=/|$)", "g"), "~");
}

/** Redact secrets out of anything this machine produced. Pure. */
export function redact(input, opts = {}) {
  let text = typeof input === "string" ? input : String(input ?? "");
  for (const { re, to } of RULES) text = text.replace(re, to);
  return collapseHome(text, opts.home ?? null);
}

/** Redact every string inside a JSON-ish value, preserving structure. Pure. */
export function redactDeep(value, opts = {}) {
  if (typeof value === "string") return redact(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, opts);
    return out;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHAT MAY BE TOUCHED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The setup files a grant with `setup_files` may READ. Deliberately a list of exact
 * paths, not a directory: these live inside dotdirs that folder grants can never
 * reach, and each one is here because a visiting agent genuinely cannot diagnose a
 * broken setup without it. Adding an entry is a security decision — make it once,
 * here, with a reason.
 */
export const SETUP_FILES = Object.freeze([
  ".claude.json",                                  // Claude Code's MCP servers live here
  ".claude/settings.json",                         // permissions / allowlists
  ".claude/mcp-needs-auth-cache.json",             // the poisoned-401 cache that silently disables a server
  ".codex/config.toml",
  ".codex-bridge/config.toml",                     // the Bridge's own Codex home
  ".gemini/config/mcp_config.json",                // agy's MCP config (agy has no `mcp add`)
  ".gemini/antigravity-cli/settings.json",
  ".kimi-code/mcp.json",                           // kimi's MCP servers (kimi has no `mcp add`)
  ".openclaw/openclaw.json",
  ".cookbook/config.json",                          // Bridge config (projected: tokens stripped)
  ".cookbook/bridge.state.json",                    // attempt counters (projected)
  ".cookbook/local.json",                           // also on NEVER_READ (the loopback token); deny wins
  // The desktop app's own files (macOS). All projected: a Bridge config carries the
  // Bridge token and per-agent tokens, and a visitor only needs its SHAPE.
  "Library/Application Support/ai.cookbook.desktop/config.json",
  "Library/CookbookBridge/config.json",
  "Library/CookbookBridge/local.json",              // also on NEVER_READ (the loopback token); deny wins
  "Library/CookbookBridge/bridge.state.json",
]);

/**
 * NEVER readable, whatever any grant says. These are the live credentials the whole
 * design exists to keep out of a visiting agent's context. This list wins over the
 * setup allowlist, over folder grants, and over any future verb.
 *
 * MATCHED CASE-INSENSITIVELY, UNICODE-NORMALIZED, AND SEPARATOR-NORMALIZED
 * (a backslash counts as a separator), and that is not a nicety:
 * macOS APFS/HFS+ are case-INSENSITIVE, and `realpath()` does NOT canonicalize case
 * — it hands back whatever spelling the caller used. So a case-sensitive denylist
 * simply does not see `~/.claude/.Credentials.json`, which opens the exact file it
 * exists to protect. HFS+ also stores decomposed Unicode, so `.crede\u0301ntials`
 * is a second spelling of the same name. And on Windows every resolved path uses
 * `\`, which would slip straight past patterns written with `/`.
 *
 * Directory entries end in `(\/|$)` so the DIRECTORY ITSELF is denied too: listing
 * ~/.ssh tells a visitor which hosts you hold keys for, and ~/.aws which profiles
 * exist, without reading a byte.
 */
const NEVER_READ = Object.freeze([
  /(^|\/)\.claude\/\.credentials\.json$/i,
  /(^|\/)\.codex\/auth\.json$/i,
  /(^|\/)\.codex-bridge\/auth\.json$/i,
  /(^|\/)\.gemini\/oauth_creds\.json$/i,
  /(^|\/)\.kimi-code\/credentials(\/|$)/i,          // kimi OAuth credentials (dir + files)
  /(^|\/)\.kimi-code\/config\.toml$/i,             // kimi keeps provider API keys HERE, not in env
  /(^|\/)\.openclaw\/(auth|credentials)[^/]*$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.config\/gcloud(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.kube(\/|$)/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.git-credentials$/i,
  // Any dotenv-shaped file, however it is named or suffixed: `.env`, `.env.local`,
  // `prod.env`, `.env.local.bak`.
  /(^|\/)[^/]*\.env(\.[A-Za-z0-9_-]+)*$/i,
  /\.(pem|key|p12|pfx|keystore|jks|asc)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|\/)local\.json$/i,        // the Bridge Local loopback token
  /(^|\/)\.cookbook\/local\.json$/i, // the config home's copy, named explicitly like the Library one
  /(^|\/)\.git\/config$/i,      // can carry credentials in a remote URL
  // `credentials.json` AND its dotfile spelling `.credentials.json` — the anchor
  // used to accept only `/` before the word, so a dotfile in a granted project
  // folder walked through the wall (ultrareview #123, bug_003).
  /(^|[/.])credentials?(\.[A-Za-z0-9]+)?$/i,
]);

/** Every spelling of a path this filesystem might consider the same file. */
function pathVariants(p) {
  const raw = String(p ?? "");
  const lower = raw.toLowerCase();
  const out = new Set([raw, lower]);
  try {
    out.add(raw.normalize("NFC"));
    out.add(raw.normalize("NFD"));
    out.add(lower.normalize("NFC"));
    out.add(lower.normalize("NFD"));
  } catch { /* normalize is available everywhere we run, but never fail closed-open */ }
  // WINDOWS SPELLINGS. path.resolve() on win32 yields backslashes, and every
  // NEVER_READ pattern is written with "/" — so C:\Users\me\.ssh\id_rsa matched
  // NOTHING and the list that "wins over everything" silently protected nothing
  // on Windows. On POSIX a backslash is a legal filename char; treating it as a
  // separator here can only over-deny a bizarrely-named file, which errs safe.
  for (const v of [...out]) {
    if (v.includes("\\")) out.add(v.replace(/\\/g, "/"));
  }
  return [...out];
}

/** Is this path on the never-read list, under ANY spelling of it? */
function isDenied(p) {
  const variants = pathVariants(p);
  return NEVER_READ.some((re) => variants.some((v) => re.test(v)));
}

/**
 * PROJECTIONS — files a visitor needs the SHAPE of, never the contents of.
 *
 * `~/.claude.json` is the sharpest example and the reason this exists: it is the
 * file that says how Claude Code is wired to Cookbook, which is exactly what a setup
 * agent must see — and it ALSO carries per-project `history[]`, i.e. every prompt the
 * host has ever typed, plus every repo path on the machine and their account email.
 * None of that is a "credential", so no redactor would ever catch it. Handing the
 * whole file over would mean a visitor asked to "look at my setup" walks off with the
 * host's private work history.
 *
 * So: parse it here and return only the diagnostic facts. A projected file is marked
 * `projected: true` so the visiting agent knows it is looking at a summary and does
 * not go hunting for the rest.
 */
/** The PROJECTIONS key for a file: its path relative to the granted home, always with
 *  "/" — on Windows path.relative() answers with "\", and a key that misses means the
 *  file is returned in FULL instead of as a summary. (Kimi's 2026-08-28 review flagged
 *  the "/"-shaped guarantees; this one it didn't reach.) */
export function projectionKey(home, real, pathMod = path) {
  return pathMod.relative(home, real).replace(/\\/g, "/");
}

/**
 * Every credential-shaped value in a config, at any depth, replaced by a marker:
 * a key named `token` or ending in `_token` (any case) becomes "<present, not sent>"
 * when set and null when empty. Structure, agent names and URLs survive, so a setup
 * agent can still tell "Claude has a token" from "Claude has no token". Pure.
 */
export function stripTokens(value) {
  if (Array.isArray(value)) return value.map(stripTokens);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^token$|_token$/i.test(k)) out[k] = v === null || v === undefined || v === "" ? null : "<present, not sent>";
      else out[k] = stripTokens(v);
    }
    return out;
  }
  return value;
}

/** A Bridge/desktop config file: parsed, tokens stripped, marked projected. Pure. */
export function projectedConfig(text) {
  let j;
  try { j = JSON.parse(text); } catch (e) { return { parse_error: e.message.slice(0, 120) }; }
  return { ...(stripTokens(j) && typeof j === "object" && !Array.isArray(j) ? stripTokens(j) : { value: stripTokens(j) }), note: "Projected: token values are replaced by <present, not sent>." };
}

const PROJECTIONS = Object.freeze({
  ".cookbook/config.json": projectedConfig,
  ".cookbook/bridge.state.json": projectedConfig,
  ".cookbook/local.json": projectedConfig,
  "Library/Application Support/ai.cookbook.desktop/config.json": projectedConfig,
  "Library/CookbookBridge/config.json": projectedConfig,
  "Library/CookbookBridge/local.json": projectedConfig,
  "Library/CookbookBridge/bridge.state.json": projectedConfig,
  ".claude.json": (text) => {
    let j;
    try { j = JSON.parse(text); } catch (e) { return { parse_error: e.message.slice(0, 120) }; }
    const servers = j && typeof j.mcpServers === "object" && j.mcpServers ? j.mcpServers : {};
    const projects = j && typeof j.projects === "object" && j.projects ? j.projects : {};
    return {
      mcp_servers: Object.entries(servers).map(([name, v]) => ({
        name,
        transport: v?.type ?? (v?.url ? "http" : v?.command ? "stdio" : "unknown"),
        // Origin only — the path can carry a token in some configs.
        url: typeof v?.url === "string" ? (() => { try { return new URL(v.url).origin + new URL(v.url).pathname; } catch { return "(unparseable)"; } })() : null,
        command: typeof v?.command === "string" ? v.command : null,
        has_auth_header: !!(v?.headers && Object.keys(v.headers).some((h) => /^authorization$/i.test(h))),
      })),
      // Counts, never the paths: a project list is a map of everything you work on.
      project_count: Object.keys(projects).length,
      has_oauth_account: !!j?.oauthAccount,
      top_level_keys: Object.keys(j ?? {}).filter((k) => k !== "projects" && k !== "mcpServers"),
      note: "Projected: this file also holds your prompt history and project paths, which are never sent.",
    };
  },
});

/** Bytes of a single file a visitor may pull back. Enough for any config. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 40_000;
const MAX_DIR_ENTRIES = 400;
/** The most a single call result may weigh when it leaves this machine. The server
 *  applies the same cap (src/lib/workspaces/grants.ts MAX_OUTPUT_BYTES); doing it
 *  here too means a plan of twenty steps or a pre-flight cannot outgrow a receipt. */
export const MAX_UPLOAD_BYTES = 64 * 1024;
/** Trim an output to MAX_UPLOAD_BYTES the same way the server does. Pure. */
export function capOutput(output) {
  if (output === null || output === undefined) return output;
  const json = JSON.stringify(output);
  if (typeof json !== "string" || json.length <= MAX_UPLOAD_BYTES) return output;
  return { truncated: true, bytes: json.length, preview: json.slice(0, MAX_UPLOAD_BYTES) };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LOCAL CEILING — what this machine will EVER do, regardless of what it is told
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The grant scope travels with the call, which means it is server-attested: a
 * compromised or buggy server could simply claim the host granted everything. So the
 * host keeps its own ceiling and authorizes against the INTERSECTION. Nothing the
 * server says can widen this; the host can only ever narrow it further.
 *
 * Phase 1 is read-only by construction, and `folders: []` means a server can never
 * hand a visitor a directory — only the host's OWN config can (cfg.hosting.folders).
 */
export const LOCAL_CEILING = Object.freeze({
  // `plan` is a container, not a capability: its steps are each checked on their own
  // (executePlan), so listing it here widens nothing. `preflight` is deliberately
  // absent: the host runs it on its own initiative and never accepts it as a call.
  verbs: Object.freeze(["doctor", "env", "read_file", "list_dir", "run", "write_file", "restore_backup", "open_url", "plan"]),
  run_allow: Object.freeze([
    // read
    "node_version", "claude_mcp_list", "cli_versions", "tail_log",
    // repair
    "claude_mcp_remove_cookbook", "claude_mcp_add_cookbook", "clear_needs_auth_cache", "bridge_restart",
    "npm_install_global", "bridge_connect_agents",
  ]),
  setup_files: true,
  /**
   * THE ONE THAT MATTERS: `write`, `install` and `login` are capped at "ask", never
   * `true`. The ceiling is a MAXIMUM, so no grant and no server can raise them to
   * automatic. On this machine a change always waits for the host to click, and that
   * is a property of the machine rather than of a UI or of what the server sent.
   */
  auto: Object.freeze({ read: true, write: "ask", install: "ask", login: "ask" }),
  folders: Object.freeze([]),
});

/** Is `child` inside `parent` (or equal)? Both absolute + normalized. */
function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The scope this machine will actually honour: server scope ∩ local ceiling.
 * `hostFolders` are the directories the HOST put in their own config; a granted
 * folder is honoured only if it is one of those, or inside one.
 */
export function effectiveScope(serverScope, { hostFolders = [], home = os.homedir() } = {}) {
  const s = serverScope && typeof serverScope === "object" ? serverScope : {};
  const localFolders = (Array.isArray(hostFolders) ? hostFolders : [])
    .map((f) => path.resolve(expandHome(f, home)))
    .filter(Boolean);
  const askedFolders = (Array.isArray(s.folders) ? s.folders : [])
    .map((f) => path.resolve(expandHome(f, home)));
  const auto = {};
  for (const risk of ["read", "write", "install", "login"]) {
    const ceiling = LOCAL_CEILING.auto[risk];
    const asked = s.auto?.[risk];
    // The ceiling is a MAXIMUM. false refuses outright; "ask" CLAMPS a server's
    // `true` down to "ask" (this is what makes "a change always needs a click" true
    // on this machine); only true-over-true auto-runs.
    if (ceiling === false || asked === undefined || asked === false) auto[risk] = false;
    else if (ceiling === "ask") auto[risk] = "ask";
    else auto[risk] = asked === "ask" ? "ask" : asked === true ? true : false;
  }
  return {
    verbs: (Array.isArray(s.verbs) ? s.verbs : []).filter((v) => LOCAL_CEILING.verbs.includes(v)),
    run_allow: (Array.isArray(s.run_allow) ? s.run_allow : []).flatMap((t) =>
      t === "*" ? [...LOCAL_CEILING.run_allow] : LOCAL_CEILING.run_allow.includes(t) ? [t] : []),
    setup_files: LOCAL_CEILING.setup_files && s.setup_files !== false,
    auto,
    // A folder is honoured only if the HOST configured it locally.
    folders: askedFolders.filter((f) => localFolders.some((local) => within(local, f))),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RISK — the Bridge's own copy (see the header: two independent tables on purpose)
// ─────────────────────────────────────────────────────────────────────────────

export const VERB_RISK = Object.freeze({
  doctor: "read",
  env: "read",
  read_file: "read",
  list_dir: "read",
  run: "read",
  write_file: "write",
  restore_backup: "write",
  open_url: "login",
  // A plan always waits for the host's single click, whatever its steps: "write"
  // is the label that makes the generic wall say so. Pre-flight is read-only by
  // construction (env, doctor, CLI versions, the config's shape).
  plan: "write",
  preflight: "read",
});

export const RUN_TEMPLATE_RISK = Object.freeze({
  claude_mcp_list: "read",
  node_version: "read",
  tail_log: "read",
  cli_versions: "read",
  claude_mcp_add_cookbook: "write",
  claude_mcp_remove_cookbook: "write",
  claude_mcp_add_cookbook: "write",
  agy_configure: "write",
  codex_configure: "write",
  openclaw_configure: "write",
  clear_needs_auth_cache: "write",
  bridge_restart: "write",
  npm_install_global: "install",
  bridge_connect_agents: "login",
});

export function riskFor(verb, args = {}) {
  const base = VERB_RISK[verb];
  if (!base) return null;
  if (verb !== "run") return base;
  const template = typeof args.template === "string" ? args.template : "";
  return RUN_TEMPLATE_RISK[template] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH CONTAINMENT
// ─────────────────────────────────────────────────────────────────────────────

function expandHome(p, home) {
  const s = String(p ?? "").trim();
  if (s === "~") return home;
  if (s.startsWith("~/")) return path.join(home, s.slice(2));
  return s;
}

/** Is `child` inside `parent` (or equal to it)? Both must be absolute + normalized. */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a requested path and decide whether this grant may touch it.
 * Checks the lexical path AND (when it exists) the symlink-resolved real path, so a
 * symlink inside a granted folder cannot point out of it.
 * Returns { ok: true, path, real, exists } or { ok: false, error }.
 */
export function resolveGrantPath(input, { scope, home = os.homedir() } = {}) {
  const raw = expandHome(input, home);
  if (!raw) return { ok: false, error: "Give a path." };
  if (raw.includes("\0")) return { ok: false, error: "Invalid path." };
  const lexical = path.resolve(raw);

  if (isDenied(lexical)) {
    return { ok: false, error: "That file holds live credentials and is never readable through a grant — not even with the host's permission." };
  }

  let real = lexical;
  let exists = true;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    exists = false;
    // Resolve the deepest existing ancestor so a symlinked parent can't smuggle us out.
    let dir = path.dirname(lexical);
    for (let i = 0; i < 40 && dir !== path.dirname(dir); i++) {
      try { real = path.join(fs.realpathSync(dir), path.relative(dir, lexical)); break; } catch { dir = path.dirname(dir); }
    }
  }
  if (isDenied(real)) {
    return { ok: false, error: "That file holds live credentials and is never readable through a grant — not even with the host's permission." };
  }

  // CONTAINMENT. Both forms of every path are compared, because a real machine has
  // symlinks everywhere: macOS makes /tmp -> /private/tmp, and dotfile managers
  // symlink config files as a matter of course. The rule that survives all of it:
  // the path a visitor NAMED and the file it actually RESOLVES TO must BOTH land
  // inside what the host granted. Checking only the name lets a symlink walk out;
  // checking only the target breaks every legitimate symlinked config.
  const realOf = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const insideEither = (a, b, target) => isInside(a, target) || isInside(b, target);

  const folders = Array.isArray(scope?.folders) ? scope.folders : [];
  for (const f of folders) {
    const baseLex = path.resolve(expandHome(f, home));
    const baseReal = realOf(baseLex);
    const named = insideEither(baseLex, baseReal, lexical);
    const resolved = insideEither(baseLex, baseReal, real);
    if (named && resolved) return { ok: true, path: lexical, real, exists };
  }

  if (scope?.setup_files) {
    const homeReal = realOf(home);
    for (const rel of SETUP_FILES) {
      const absLex = path.join(home, rel);
      const absReal = path.join(homeReal, rel);
      if (lexical !== absLex && lexical !== absReal) continue;
      // A setup file may be a symlink — dotfile managers do this constantly — but it
      // must still resolve to somewhere inside the home directory. A ".claude.json"
      // pointing at someone else's file is not a setup file.
      if (!exists || insideEither(home, homeReal, real)) return { ok: true, path: lexical, real, exists };
      return { ok: false, error: "That setup file is a symlink pointing outside your home directory, so it can't be read through a grant." };
    }
  }

  return {
    ok: false,
    error: folders.length
      ? "That path is outside this grant. The host granted: " + folders.join(", ") + (scope?.setup_files ? " plus the standard setup files." : ".")
      : "This grant covers the standard setup files only. Ask the host to add a folder if you need one.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RUN TEMPLATES — fixed argv, parameters into named slots, never a shell string
// ─────────────────────────────────────────────────────────────────────────────

/** Where a pre-write copy goes. One shape, so restore_backup can recognise it. */
const BACKUP_RE = /\.bak-chef-\d{13,}$/;
function backupOf(file) {
  return `${file}.bak-chef-${Date.now()}`;
}

/**
 * Find an executable. POSIX: exact name, executable bit. Windows: try the exact
 * name plus every PATHEXT extension (.EXE/.CMD/.BAT…), preferring a REAL executable
 * over a shell shim, and plain existence over X_OK (NTFS ACLs don't map to it).
 * Options exist so tests can force a platform; defaults are the live machine.
 * Exported: the Bridge's other spawners (device.mjs) share it.
 */
export function which(bin, { platform = process.platform, pathEnv = process.env.PATH, pathext = process.env.PATHEXT, home = os.homedir() } = {}) {
  const dirs = String(pathEnv || "").split(platform === "win32" ? ";" : ":");
  if (home) dirs.push(path.join(home, ".claude/local"), path.join(home, ".bun/bin"), path.join(home, ".local/bin"));
  if (platform !== "win32") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  const exists = (p) => { try { fs.accessSync(p, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return true; } catch { return false; } };
  if (platform !== "win32") {
    for (const dir of dirs) {
      if (!dir) continue;
      const p = path.join(dir, bin);
      if (exists(p)) return p;
    }
    return null;
  }
  // PATHEXT is uppercase while shims are written lowercase (`claude.cmd`). Windows
  // doesn't care; a case-sensitive filesystem (CI's Linux runner) does — try both.
  const exts = [...new Set(String(pathext || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).flatMap((e) => [e, e.toLowerCase()]))];
  // Pass 1: the exact name or a real executable. Pass 2: any shim PATHEXT allows.
  for (const pass of [(e) => e === "" || /\.(exe|com)$/i.test(e), () => true]) {
    for (const dir of dirs) {
      if (!dir) continue;
      const names = [bin, ...exts.map((e) => (bin.toLowerCase().endsWith(e.toLowerCase()) ? bin : `${bin}${e}`))];
      for (const n of names) {
        if (!pass(path.extname(n))) continue;
        const p = path.join(dir, n);
        if (exists(p)) return p;
      }
    }
  }
  return null;
}

/**
 * WINDOWS EXECUTION. A `.cmd`/`.bat` shim cannot be spawned directly on modern Node
 * (EINVAL since the CVE-2024-27980 fix): it has to go through cmd.exe. Compose the
 * one command line here. Every argv a template produces is a constant or a resolved
 * binary path — never visitor-controlled — so this quoting is about paths with
 * spaces, not injection. (A `%` in a path would still expand under cmd.exe; noted,
 * accepted — no template value contains one, and usernames essentially never do.)
 * Identity everywhere else, so callers can wrap unconditionally.
 */
export function argvForSpawn(argv, platform = process.platform) {
  if (platform !== "win32") return argv;
  const exe = String(argv[0] ?? "");
  if (!/\.(cmd|bat)$/i.test(exe)) return argv;
  const quote = (s) => `"${String(s).replace(/"/g, '\\"').replace(/(\\+)$/, "$1$1")}"`;
  const line = [exe, ...argv.slice(1)].map(quote).join(" ");
  return [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", line];
}

/**
 * WINDOWS, UNTRUSTED ARGUMENT. argvForSpawn is safe for constant argv; it is NOT
 * safe for a task prompt, because cmd.exe does not honour `\"` inside a quoted
 * argument, so workspace text could break out of its quotes and run as a command.
 * The way out is to not go through cmd.exe at all: an npm shim is a two-line
 * batch file that runs `node <cli.js> %*`. Read it, find the script, and let the
 * caller spawn node on it directly. Returns the script path, or null when the shim
 * is not a recognisable node shim (the caller must then refuse, never fall back).
 * Pure given the injected readers; tested on the live platform's path module.
 */
export function resolveCmdShim(shimPath, { platform = process.platform, readFile = (p) => fs.readFileSync(p, "utf8"), exists = (p) => fs.existsSync(p) } = {}) {
  let text;
  try { text = readFile(shimPath); } catch { return null; }
  if (!/\bnode(?:\.exe)?\b/i.test(text)) return null;
  // npm's shim: "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*    (also %~dp0\...)
  const m = text.match(/%(?:~)?dp0%?\\([^"\r\n%]+?\.(?:m?js|cjs))"?/i);
  if (!m) return null;
  const P = platform === "win32" ? path.win32 : path;
  const script = P.resolve(P.dirname(shimPath), m[1]);
  return exists(script) ? script : null;
}

/**
 * Kill a child AND everything it spawned. On POSIX a signal to the CLI is enough
 * (it forwards to its own children). On Windows `child.kill()` ends only the shim
 * or node it started; the real CLI process kept running, invisibly, on the member's
 * quota. taskkill /T walks the tree. Never throws.
 */
export function killTree(child, signal = "SIGTERM", platform = process.platform) {
  if (!child || typeof child.pid !== "number") return;
  if (platform === "win32") {
    try { spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", timeout: 10_000 }); } catch { /* gone */ }
    return;
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/**
 * Each template returns { argv, timeoutMs }. Parameters are validated by the
 * template itself and only ever land in a dedicated argv slot. A template that
 * cannot validate its parameters returns { error }.
 */
export const RUN_TEMPLATES = Object.freeze({
  node_version: () => ({ argv: [process.execPath, "--version"], timeoutMs: 10_000 }),

  claude_mcp_list: () => {
    const bin = which("claude");
    if (!bin) return { error: "The claude CLI isn't installed on this machine (not on PATH)." };
    return { argv: [bin, "mcp", "list"], timeoutMs: 45_000 };
  },

  cli_versions: () => {
    // A single cheap probe of every vendor CLI, so the visitor doesn't burn four
    // calls asking "is X installed?".
    const found = ["claude", "codex", "agy", "openclaw", "npm", "node"].map((b) => ({ bin: b, path: which(b) }));
    return { local: () => ({
      clis: found.map(({ bin, path: p }) => {
        if (!p) return { cli: bin, installed: false };
        const argv = argvForSpawn([p, "--version"]);
        const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 12_000 });
        return { cli: bin, installed: true, version: String(r.stdout || r.stderr || r.error?.message || "").trim().split("\n")[0].slice(0, 80) };
      }),
    }) };
  },

  // ── REPAIR ────────────────────────────────────────────────────────────────
  // Each of these fixes a failure that has actually cost a real person an evening.
  // All are risk >= write, so the ceiling holds them at "ask": the host clicks.

  /** A broken/stale `cookbook` entry in Claude Code, cleared before reconnecting. */
  claude_mcp_remove_cookbook: () => {
    const bin = which("claude");
    if (!bin) return { error: "The claude CLI isn't installed on this machine." };
    return { argv: [bin, "mcp", "remove", "--scope", "user", "cookbook"], timeoutMs: 45_000 };
  },

  /** Re-add the Cookbook server to Claude Code with a FIXED argv: the transport,
   *  scope and name are constants and the URL is this Bridge's own cookbookUrl
   *  origin, so a visitor cannot point Claude anywhere else. No header: the CLI
   *  then goes through Cookbook's own OAuth in the host's browser. */
  claude_mcp_add_cookbook: (_params, ctx) => {
    const bin = which("claude");
    if (!bin) return { error: "The claude CLI isn't installed on this machine (not on PATH)." };
    const raw = ctx?.cfg?.cookbookUrl;
    if (!raw) return { error: "This Bridge has no cookbookUrl in its config, so there is nothing to point Claude at. Run `npx cookbook-bridge@latest connect` first." };
    let origin;
    try { origin = new URL(String(raw)).origin; } catch { return { error: `cookbookUrl in this Bridge's config is not a valid URL (${String(raw).slice(0, 80)}).` }; }
    return { argv: [bin, "mcp", "add", "--transport", "http", "--scope", "user", "cookbook", `${origin}/api/mcp`], timeoutMs: 45_000 };
  },

  /** THE poisoned-401 cache: one stale entry makes headless runs skip the server
   *  EVERYWHERE while `claude mcp get` still cheerfully says Connected. */
  clear_needs_auth_cache: (_params, ctx) => ({ local: () => {
    const f = path.join(ctx.home, ".claude", "mcp-needs-auth-cache.json");
    let before = null;
    try { before = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* absent or unreadable */ }
    if (before === null) return { changed: false, note: "no needs-auth cache on this machine — nothing to clear" };
    const backup = backupOf(f);
    try { fs.copyFileSync(f, backup); } catch { /* best effort */ }
    try { fs.writeFileSync(f, "{}\n", { mode: 0o600 }); } catch (e) { return { error: `couldn't clear it: ${e.code || e.message}` }; }
    return { changed: true, cleared_entries: Object.keys(before ?? {}).length, backup: path.basename(backup) };
  } }),

  /** Pick up a config change without the host hunting for the terminal. */
  bridge_restart: (_params, ctx) => ({ local: () => {
    if (!ctx.restart) return { error: "this Bridge can't restart itself from here" };
    setTimeout(() => { try { ctx.restart(); } catch { /* the Bridge is going away */ } }, 400);
    return { restarting: true, note: "The Bridge is restarting; give it a few seconds, then run doctor again." };
  } }),

  /** Only ever our own package. */
  npm_install_global: (params) => {
    const pkg = String(params?.pkg ?? "cookbook-bridge");
    if (pkg !== "cookbook-bridge") return { error: `Only 'cookbook-bridge' may be installed through a grant, not '${pkg}'.` };
    const bin = which("npm");
    if (!bin) return { error: "npm isn't on PATH." };
    return { argv: [bin, "install", "-g", "cookbook-bridge@latest"], timeoutMs: 180_000 };
  },

  /**
   * THE BIG ONE: the device flow. Fixes "no Cookbook MCP", the wrong allowedTools
   * prefix, an expired token, and a never-configured agy/codex/openclaw in one go —
   * and it is the repair Pierre actually needed. Returns the code IMMEDIATELY so the
   * visiting agent can read it out to the host instead of blocking on their browser.
   * The host's own login does the work; no credential is ever handled here.
   */
  bridge_connect_agents: (_params, ctx) => ({ local: async () => {
    if (!ctx.startConnect) return { error: "this Bridge can't run connect from here" };
    const started = await ctx.startConnect();
    // Finish in the background: when the host approves, the new token lands in
    // config.json and the running Bridge reloads it (that is also what keeps this
    // from revoking the very Bridge serving the grant).
    started.done
      .then((r) => {
        try { ctx.applyConfig?.(); } catch { /* logged by the caller */ }
        ctx.log?.(`  ↳ connect finished: ${(r.results ?? []).map((x) => `${x.agent} ${x.ok ? "ok" : "failed"}`).join(", ") || "no agents"}`);
      })
      .catch((e) => ctx.log?.(`  ↳ connect failed: ${e.message}`));
    return {
      approve_url: started.approveUrl,
      user_code: started.userCode,
      expires_at: started.expiresAt,
      agents: started.agents,
      note: "Read the code to the host and ask them to approve it in the browser. Then wait ~20s and run doctor again.",
    };
  } }),

  tail_log: (params, ctx) => {
    const n = Math.min(Math.max(parseInt(params?.lines ?? 120, 10) || 120, 10), 400);
    // Where this Bridge's log actually is: `bridge.log` beside the config (terminal),
    // the newest `*.log` beside it (a LaunchAgent), or the newest in `logs/` (the
    // desktop app). Chef's first look at a desktop-app machine got "no bridge.log
    // yet" for a Bridge that was logging fine (2026-08-25).
    const dir = path.dirname(ctx.cfgPath || "");
    const newest = (d) => {
      try {
        return fs.readdirSync(d).filter((f) => f.endsWith(".log")).map((f) => path.join(d, f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
      } catch { return null; }
    };
    const logPath = [path.join(dir, "bridge.log"), newest(path.join(dir, "logs")), newest(dir)]
      .find((p) => p && fs.existsSync(p)) ?? path.join(dir, "bridge.log");
    return { local: () => {
      let text = "";
      try {
        const buf = fs.readFileSync(logPath, "utf8");
        text = buf.split("\n").slice(-n).join("\n");
      } catch (e) {
        return { error: `no Bridge log yet (${e.code || e.message})` };
      }
      return { path: logPath, lines: n, text };
    } };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// VERBS
// ─────────────────────────────────────────────────────────────────────────────

function runArgv(argv, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      const wrapped = argvForSpawn(argv); // .cmd/.bat need cmd.exe on Windows
      child = spawn(wrapped[0], wrapped.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ exit_code: null, stdout: "", stderr: String(e.message) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on("data", (d) => { if (out.length < MAX_OUTPUT_CHARS * 2) out += d; });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUTPUT_CHARS) err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ exit_code: null, stdout: out, stderr: String(e.message) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exit_code: code, stdout: out, stderr: err }); });
  });
}

const VERBS = {
  /** The Bridge's own preflight, as data. The single most useful thing a visitor
   *  can call: every row carries its own fix. */
  async doctor(_args, ctx) {
    if (!ctx.doctor) return { error: "This Bridge can't run its doctor." };
    const report = await ctx.doctor();
    return { fails: report.fails, warns: report.warns, rows: report.rows };
  },

  /** The machine's shape — what is installed, what is logged in, what exists.
   *  Never file CONTENTS, and never an environment VALUE. */
  async env(_args, ctx) {
    const home = ctx.home;
    const clis = {};
    for (const bin of ["claude", "codex", "agy", "openclaw", "npm"]) {
      const p = which(bin);
      clis[bin] = p ? { installed: true, path: p } : { installed: false };
    }
    // Presence, not contents: "you have a login" is diagnostic; the login is not.
    const marker = (rel) => fs.existsSync(path.join(home, rel));
    return {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      bridge_pid: process.pid,
      shell: path.basename(String(process.env.SHELL || "")) || null,
      path_dirs: String(process.env.PATH || "").split(path.delimiter).filter(Boolean).length,
      cookbook_url: ctx.cfg?.cookbookUrl ?? null,
      agents_configured: (ctx.cfg?.agents ?? []).map((a) => a.name),
      clis,
      logins: {
        claude: marker(".claude/.credentials.json"),
        codex: marker(".codex/auth.json"),
        gemini: marker(".gemini/oauth_creds.json"),
        kimi: kimiLoginState({ home }).loggedIn,
        openclaw: marker(".openclaw"),
      },
      setup_files_present: SETUP_FILES.filter((rel) => marker(rel)),
    };
  },

  async read_file(args, ctx) {
    const r = resolveGrantPath(args.path, { scope: ctx.scope, home: ctx.home });
    if (!r.ok) return { error: r.error };
    if (!r.exists) return { path: args.path, exists: false };
    let st;
    try { st = fs.statSync(r.real); } catch (e) { return { error: `can't stat: ${e.code || e.message}` }; }
    if (st.isDirectory()) return { error: "That's a directory — use list_dir." };
    if (st.size > MAX_FILE_BYTES) return { error: `That file is ${Math.round(st.size / 1024)}KB; the limit through a grant is ${MAX_FILE_BYTES / 1024}KB.` };
    let text;
    try { text = fs.readFileSync(r.real, "utf8"); } catch (e) { return { error: `can't read: ${e.code || e.message}` }; }
    // Some setup files are needed for their SHAPE, not their contents (see PROJECTIONS).
    const rel = projectionKey(ctx.home, r.path);
    const project = PROJECTIONS[rel];
    if (project) return { path: args.path, exists: true, bytes: st.size, projected: true, summary: project(text) };
    return { path: args.path, exists: true, bytes: st.size, text: text.slice(0, MAX_OUTPUT_CHARS) };
  },

  async list_dir(args, ctx) {
    const r = resolveGrantPath(args.path, { scope: ctx.scope, home: ctx.home });
    if (!r.ok) return { error: r.error };
    if (!r.exists) return { path: args.path, exists: false };
    let entries;
    try { entries = fs.readdirSync(r.real, { withFileTypes: true }); } catch (e) { return { error: `can't list: ${e.code || e.message}` }; }
    const rows = entries.slice(0, MAX_DIR_ENTRIES).map((d) => {
      let size = null;
      try { if (d.isFile()) size = fs.statSync(path.join(r.real, d.name)).size; } catch { /* ignore */ }
      return { name: d.name, kind: d.isDirectory() ? "dir" : d.isSymbolicLink() ? "link" : "file", size };
    });
    return { path: args.path, exists: true, entries: rows, truncated: entries.length > MAX_DIR_ENTRIES };
  },

  /**
   * Change a setup file. Every write is BACKED UP first and structure-checked, so a
   * visiting agent cannot leave the host with a config that won't parse — which
   * would be worse than the problem it came to fix.
   */
  async write_file(args, ctx) {
    const r = resolveGrantPath(args.path, { scope: ctx.scope, home: ctx.home });
    if (!r.ok) return { error: r.error };
    const content = typeof args.content === "string" ? args.content : null;
    if (content === null) return { error: "Pass the full new file content as `content`." };
    if (content.length > MAX_FILE_BYTES) return { error: `That content is ${Math.round(content.length / 1024)}KB; the limit is ${MAX_FILE_BYTES / 1024}KB.` };

    // Don't hand back a broken machine: a config that doesn't parse is a worse
    // failure than the one being repaired, and the host may not notice for days.
    const ext = path.extname(r.path).toLowerCase();
    if (ext === ".json") {
      try { JSON.parse(content); } catch (e) { return { error: `That isn't valid JSON, so it wasn't written: ${e.message.slice(0, 120)}` }; }
    }
    // The setup allowlist carries two TOML files (Codex). The "won't parse ⇒ not
    // written" promise covered only JSON until ultrareview #123 (bug_008) — this is
    // a structural check, not a full parser: unbalanced quotes/brackets, lines that
    // are neither a table header nor `key = value`, unterminated multi-line strings.
    if (ext === ".toml" && !tomlLooksValid(content)) {
      return { error: "That doesn't look like valid TOML (unbalanced quotes/brackets or a malformed line), so it wasn't written." };
    }
    if (content.includes("\0")) return { error: "Content contains a null byte." };

    let backup = null;
    if (r.exists) {
      backup = backupOf(r.real);
      try { fs.copyFileSync(r.real, backup); } catch (e) { return { error: `couldn't back the file up first, so nothing was written: ${e.code || e.message}` }; }
    }
    try {
      fs.mkdirSync(path.dirname(r.path), { recursive: true });
      fs.writeFileSync(r.path, content, { mode: 0o600 });
    } catch (e) {
      return { error: `write failed: ${e.code || e.message}` };
    }
    return { path: args.path, bytes: content.length, created: !r.exists, backup: backup ? path.basename(backup) : null };
  },

  /** Undo one of this session's own writes. The host can also just delete the .bak. */
  async restore_backup(args, ctx) {
    const r = resolveGrantPath(args.path, { scope: ctx.scope, home: ctx.home });
    if (!r.ok) return { error: r.error };
    const name = String(args.backup ?? "");
    if (!BACKUP_RE.test(name)) return { error: "Pass the backup filename this session created (…​.bak-chef-<timestamp>)." };
    // write_file placed the backup next to the RESOLVED file (r.real), so a
    // symlinked setup file — dotfile managers do this constantly — keeps its backup
    // in the target directory. Look there first, then beside the symlink itself
    // (ultrareview #123, bug_009: restore used to look only beside the symlink and
    // report "isn't there any more" about a backup that existed).
    const candidates = [path.join(path.dirname(r.real), name), path.join(path.dirname(r.path), name)];
    if (candidates.some((c) => path.basename(c) !== name)) return { error: "Invalid backup name." };
    const backupPath = candidates.find((c) => fs.existsSync(c));
    if (!backupPath) return { error: "That backup isn't there any more." };
    try { fs.copyFileSync(backupPath, r.path); } catch (e) { return { error: `restore failed: ${e.code || e.message}` }; }
    return { path: args.path, restored_from: name };
  },

  /**
   * Open a page in the HOST's browser — how a login happens without any credential
   * ever passing through an agent. Allowlisted: a visitor cannot send the host to a
   * page of its choosing.
   */
  async open_url(args, ctx) {
    const raw = String(args.url ?? "");
    let u;
    try { u = new URL(raw); } catch { return { error: "That isn't a URL." }; }
    if (u.protocol !== "https:") return { error: "Only https links can be opened." };
    const cookbookHost = (() => { try { return new URL(String(ctx.cfg?.cookbookUrl ?? "")).host; } catch { return null; } })();
    const allowed = [cookbookHost, "claude.ai", "chatgpt.com", "chat.openai.com", "accounts.google.com", "github.com"].filter(Boolean);
    if (!allowed.some((h) => u.host === h || u.host.endsWith(`.${h}`))) {
      return { error: `Only sign-in pages can be opened (${allowed.join(", ")}), not ${u.host}.` };
    }
    try {
      const { openBrowser } = await import("./device.mjs");
      openBrowser(u.toString());
    } catch (e) {
      return { error: `couldn't open the browser: ${e.message}`, url: u.toString() };
    }
    return { opened: u.toString(), note: "The host's browser should be showing this now." };
  },

  async run(args, ctx) {
    const template = String(args.template ?? "");
    const make = RUN_TEMPLATES[template];
    if (!make) return { error: `Unknown template '${template}'.` };
    const spec = make(args.params ?? {}, ctx);
    if (spec.error) return { error: spec.error };
    if (spec.local) return await spec.local();
    const res = await runArgv(spec.argv, spec.timeoutMs ?? 60_000);
    return {
      template,
      command: `${path.basename(spec.argv[0])} ${spec.argv.slice(1).join(" ")}`.slice(0, 300),
      exit_code: res.exit_code,
      stdout: String(res.stdout).slice(0, MAX_OUTPUT_CHARS),
      stderr: String(res.stderr).slice(0, 4000),
    };
  },

  /**
   * PRE-FLIGHT: everything a visiting agent would otherwise spend its first four
   * calls asking. Read-only by construction. The host runs it on its own initiative
   * the moment a grant becomes active (runPreflight) and posts it as a
   * host-initiated call; a queued `preflight` from the server is refused by the wall.
   */
  async preflight(_args, ctx) {
    return collectPreflight(ctx);
  },

  /** A plan is executed by executePlan, never as a bare verb: executeCall routes
   *  it there before this is reached. Kept in the table so the wall knows the name. */
  async plan() {
    return { error: "A plan runs through executePlan, one step at a time." };
  },
};

export const VERB_NAMES = Object.freeze(Object.keys(VERBS));
/** Verbs that contain or replace other calls. Never allowed inside a plan. */
export const META_VERBS = Object.freeze(["plan", "preflight"]);

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check a call against the grant it claims to belong to. Pure — no I/O — so the
 * whole authorization decision is unit-testable without a machine to break.
 * Returns { ok: true, risk } or { ok: false, error }.
 */
export function authorizeCall(call, scope, opts = {}) {
  if (!call || typeof call.verb !== "string") return { ok: false, error: "Malformed call." };
  if (!scope || typeof scope !== "object") return { ok: false, error: "No grant scope." };
  const verb = call.verb;
  if (!VERBS[verb]) return { ok: false, error: `This Bridge has no verb '${verb}'.` };
  // The host runs its own pre-flight; it is never something a visitor queues.
  if (verb === "preflight") return { ok: false, error: "Pre-flight runs on the host's own initiative, never as a queued call." };
  // A PLAN is a container. Its permission is exactly the permission of its steps,
  // each of which is checked on its own inside executePlan, so the plan row itself
  // needs only the one thing a container can carry: the host's click.
  if (verb === "plan") {
    if (opts.approvedByPlan) return { ok: false, error: "A plan can't contain another plan." };
    if (call.status !== "approved") return { ok: false, error: "A plan needs the host's approval before it can run here." };
    return { ok: true, risk: VERB_RISK.plan };
  }
  if (!Array.isArray(scope.verbs) || !scope.verbs.includes(verb)) {
    return { ok: false, error: `The grant doesn't allow '${verb}'.` };
  }
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const risk = riskFor(verb, args);
  if (!risk) return { ok: false, error: `Unknown ${verb === "run" ? "template" : "verb"}.` };
  if (verb === "run") {
    const template = String(args.template ?? "");
    const allow = Array.isArray(scope.run_allow) ? scope.run_allow : [];
    if (!allow.includes("*") && !allow.includes(template)) {
      return { ok: false, error: `The grant doesn't allow running '${template}'.` };
    }
  }
  const policy = scope.auto?.[risk];
  if (policy === false || policy === undefined) {
    return { ok: false, error: `The grant refuses ${risk} actions.` };
  }
  // THE CONSENT WALL: when the grant says a class needs a human, this machine runs
  // it only if the host has already flipped the row to `approved`. A UI bug, or a
  // server that sends it as `queued`, is refused here. Inside a plan the host's one
  // click on the plan row is the click for every step (`approvedByPlan`), and
  // executePlan sets that flag only when the plan row itself said `approved`.
  if (policy === "ask" && call.status !== "approved" && opts.approvedByPlan !== true) {
    return { ok: false, error: `That needs the host's approval before it can run here.` };
  }
  return { ok: true, risk };
}

/**
 * Execute one authorized call and return the payload to upload.
 * ALWAYS resolves — a thrown verb becomes a failed call, never a crashed Bridge.
 */
export async function executeCall(call, ctx) {
  if (call?.verb === "plan") return executePlan(call, ctx);
  const home = ctx.home ?? os.homedir();
  // NEVER the server's scope as sent — always its intersection with what this
  // machine will do at all. This is the line that makes "a lying server cannot make
  // your laptop run something you didn't grant" a true statement instead of a hope.
  const scope = effectiveScope(call.scope ?? ctx.scope, { hostFolders: ctx.hostFolders ?? [], home });
  const auth = authorizeCall(call, scope, { approvedByPlan: ctx.approvedByPlan === true });
  if (!auth.ok) return { status: "denied", output: null, error: auth.error };

  const args = call.args && typeof call.args === "object" ? call.args : {};
  try {
    const raw = await VERBS[call.verb](args, { ...ctx, home, scope });
    const clean = redactDeep(raw, { home });
    if (clean && typeof clean === "object" && typeof clean.error === "string" && Object.keys(clean).length === 1) {
      // A verb that could only report a problem is a failed call, not a result —
      // the visitor should see it as such and try something else.
      return { status: "failed", output: null, error: clean.error };
    }
    return { status: "done", output: capOutput(clean), error: null };
  } catch (e) {
    return { status: "failed", output: null, error: redact(String(e?.message ?? e), { home }).slice(0, 500) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PLANS — one click, several steps, the same wall for each
// ─────────────────────────────────────────────────────────────────────────────

/** The most steps one click may cover. A fix needs three or four; twenty is a script. */
export const PLAN_MAX_STEPS = 20;

/** The hash the server stamps on a plan row: sha256 of the steps EXACTLY as sent.
 *  Recomputed here before a plan runs, so nothing can be appended after the click. Pure. */
export function planHash(steps) {
  return createHash("sha256").update(JSON.stringify(steps)).digest("hex");
}

/**
 * Is this plan the plan the host clicked? Structure, size, no nested containers, and
 * the hash. Returns { ok: true, steps, why } or { ok: false, error }. Pure.
 */
export function validatePlan(call) {
  const args = call?.args && typeof call.args === "object" ? call.args : {};
  const steps = args.steps;
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: "A plan needs at least one step." };
  if (steps.length > PLAN_MAX_STEPS) return { ok: false, error: `A plan may have at most ${PLAN_MAX_STEPS} steps; this one has ${steps.length}.` };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object" || typeof step.verb !== "string") return { ok: false, error: `Step ${i + 1} is malformed (needs a verb).` };
    if (META_VERBS.includes(step.verb)) return { ok: false, error: `Step ${i + 1} is '${step.verb}', which can't be inside a plan.` };
    if (step.args !== undefined && (step.args === null || typeof step.args !== "object" || Array.isArray(step.args))) {
      return { ok: false, error: `Step ${i + 1} has malformed args.` };
    }
  }
  // THE HASH: the server cannot append a step after the host clicked, because the
  // click was on this exact list. A missing hash is a mismatch too.
  if (typeof call.plan_hash !== "string" || planHash(steps) !== call.plan_hash) return { ok: false, error: "plan hash mismatch" };
  return { ok: true, steps, why: typeof args.why === "string" ? args.why : "" };
}

/** The word for a step in the log: the template for a run, the verb otherwise. */
function stepLabel(step) {
  if (step?.verb === "run") return String(step.args?.template ?? "run");
  return String(step?.verb ?? "?");
}

/**
 * Run an approved plan step by step, through the SAME authorizeCall + executeCall
 * path a single call takes. The one difference is `approvedByPlan`: the host's click
 * on the plan row is the click for every write-class step inside it, and it is set
 * only when the plan row itself is `approved`. Every step is still measured against
 * effectiveScope and LOCAL_CEILING on its own, so a step the ceiling forbids fails
 * the plan at that index. Stops at the first failure. ALWAYS resolves.
 * `ctx.executeStep` (tests) replaces executeCall for the steps.
 */
export async function executePlan(call, ctx) {
  const home = ctx.home ?? os.homedir();
  const scope = effectiveScope(call.scope ?? ctx.scope, { hostFolders: ctx.hostFolders ?? [], home });
  const auth = authorizeCall(call, scope, { approvedByPlan: ctx.approvedByPlan === true });
  if (!auth.ok) return { status: "denied", output: null, error: auth.error };
  const v = validatePlan(call);
  if (!v.ok) return { status: "denied", output: null, error: v.error };

  const runStep = typeof ctx.executeStep === "function" ? ctx.executeStep : executeCall;
  const total = v.steps.length;
  const steps = [];
  let stoppedAt;
  for (let i = 0; i < total; i++) {
    if (ctx.stopped?.()) { stoppedAt = i; steps.push({ verb: v.steps[i].verb, ok: false, error: "The Bridge is stopping.", duration_ms: 0 }); break; }
    const step = v.steps[i];
    // A step never inherits the row's status: the plan's click reaches it ONLY as
    // approvedByPlan, which is what the wall is written to look at.
    const stepCall = {
      id: `${call.id ?? "plan"}#${i + 1}`,
      grant_id: call.grant_id,
      workspace_id: call.workspace_id,
      visitor: call.visitor,
      verb: step.verb,
      args: step.args && typeof step.args === "object" ? step.args : {},
      status: "queued",
      scope: call.scope ?? ctx.scope,
    };
    const t0 = Date.now();
    let r;
    try {
      r = await runStep(stepCall, { ...ctx, approvedByPlan: call.status === "approved" });
    } catch (e) {
      r = { status: "failed", output: null, error: String(e?.message ?? e).slice(0, 500) };
    }
    const duration_ms = Date.now() - t0;
    const ok = r?.status === "done";
    const row = { verb: step.verb, ...(step.verb === "run" ? { template: stepLabel(step) } : {}), ok, duration_ms };
    if (ok) row.output = r.output ?? null;
    else row.error = String(r?.error ?? `step ${r?.status ?? "failed"}`);
    steps.push(row);
    ctx.log?.(`◇ plan step ${i + 1}/${total}: ${stepLabel(step)} ... ${ok ? "ok" : `failed: ${row.error}`} (${(duration_ms / 1000).toFixed(1)}s)`);
    if (!ok) { stoppedAt = i; break; }
  }
  const output = capOutput(redactDeep({ steps, ...(stoppedAt !== undefined ? { stopped_at: stoppedAt } : {}) }, { home }));
  if (stoppedAt !== undefined) {
    const failed = steps[stoppedAt];
    return { status: "failed", output, error: redact(`Stopped at step ${stoppedAt + 1} of ${total} (${stepLabel(v.steps[stoppedAt])}): ${failed?.error ?? "failed"}`, { home }).slice(0, 500) };
  }
  return { status: "done", output, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-FLIGHT — what the host tells a visitor before it asks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four read-only pieces of a pre-flight. Each is a function of the host ctx so a
 * test can swap one (cli_versions spawns every vendor CLI, which is slow and machine
 * dependent). Every piece fails on its own: a doctor that throws still leaves env.
 */
export const PREFLIGHT_PARTS = Object.freeze({
  env: (ctx) => VERBS.env({}, ctx),
  doctor: async (ctx) => {
    if (typeof ctx.doctor !== "function") return { error: "This Bridge can't run its doctor." };
    const report = await ctx.doctor();
    const rows = Array.isArray(report?.rows) ? report.rows : [];
    return {
      rows: rows.map((r) => ({ label: String(r?.label ?? ""), ok: r?.level === "ok", detail: typeof r?.fix === "string" ? r.fix : null })),
      fails: Number(report?.fails ?? rows.filter((r) => r?.level === "bad").length),
      warns: Number(report?.warns ?? rows.filter((r) => r?.level === "warn").length),
    };
  },
  cli_versions: async (ctx) => {
    const spec = RUN_TEMPLATES.cli_versions({}, ctx);
    return spec.local ? spec.local() : { error: spec.error ?? "cli_versions is unavailable" };
  },
  bridge_config: (ctx) => {
    if (!ctx.cfgPath) return { error: "This Bridge has no config path." };
    let text;
    try { text = fs.readFileSync(ctx.cfgPath, "utf8"); } catch (e) { return { error: `can't read the config: ${e.code || e.message}` }; }
    return projectedConfig(text);
  },
});

/**
 * Gather the pre-flight: env, doctor rows, CLI versions and this Bridge's own config
 * with every token stripped, then redacted and capped exactly like any other result.
 * Read-only. ALWAYS resolves.
 */
export async function collectPreflight(ctx, parts = PREFLIGHT_PARTS) {
  const home = ctx.home ?? os.homedir();
  const out = {};
  for (const key of ["env", "doctor", "cli_versions", "bridge_config"]) {
    try {
      out[key] = await parts[key]({ ...ctx, home });
    } catch (e) {
      out[key] = { error: String(e?.message ?? e).slice(0, 300) };
    }
  }
  out.at = new Date().toISOString();
  return capOutput(redactDeep(out, { home }));
}

/**
 * Which active grants still owe a pre-flight from this host. A grant counts once it
 * is `active`, has verbs (a conversation-only grant has no machine), and is neither
 * already pre-flighted (persisted) nor out of attempts for this process. Pure.
 */
export function grantsNeedingPreflight(grants, { preflighted, tried, maxAttempts = 2 } = {}) {
  const done = preflighted ?? new Set();
  const attempts = tried ?? new Map();
  const out = [];
  for (const g of Array.isArray(grants) ? grants : []) {
    const id = g?.id;
    if (typeof id !== "string" || !id) continue;
    if (g.status && g.status !== "active") continue;
    if (g.conversation_only === true) continue;
    if (Array.isArray(g.scope?.verbs) && g.scope.verbs.length === 0) continue;
    if (done.has(id)) continue;
    if ((attempts.get(id) ?? 0) >= maxAttempts) continue;
    out.push(id);
  }
  return out;
}

/**
 * Run the pre-flight for one grant and post it as a host-initiated call:
 * `ctx.create(grantId)` asks the server for a call row (POST /api/bridge/hands with
 * { grant_id, verb: "preflight", host_initiated: true }) and returns its id;
 * `ctx.report(callId, result)` posts the output through the same route every other
 * call uses. Throws when the server refuses, so the caller can count the attempt.
 */
export async function runPreflight(grantId, ctx) {
  const output = await collectPreflight(ctx, ctx.preflightParts ?? PREFLIGHT_PARTS);
  const callId = await ctx.create(grantId);
  if (typeof callId !== "string" || !callId) throw new Error("the server didn't open a pre-flight call");
  const posted = await ctx.report(callId, { status: "done", output, error: null });
  if (posted === false) throw new Error("the server refused the pre-flight result");
  return { callId, output };
}

/**
 * The host loop: claim each pending call (CAS server-side), run it, post the result.
 * Serialized per grant — one visiting agent, one pair of hands, one thing at a time,
 * which is also what makes the live call log readable to the human watching it.
 */
export async function serveCalls(calls, ctx) {
  const served = [];
  for (const call of calls) {
    if (ctx.stopped?.()) break;
    const claimed = await ctx.claim(call.id);
    if (!claimed) continue; // another Bridge (or a re-delivered frame) got it
    ctx.log?.(`⇢ ${ctx.visitorLabel(call)} → ${describeCall(call)}`);
    ctx.onCall?.("started", call);
    const result = await executeCall(call, ctx);
    await ctx.report(call.id, result);
    ctx.log?.(`  ↳ ${result.status}${result.error ? `: ${result.error}` : ""}`);
    ctx.onCall?.(result.status, call, result);
    served.push({ id: call.id, status: result.status });
  }
  return served;
}

/** One human-readable line for a call — what the host sees in the log and the tray. */
export function describeCall(call) {
  const a = call?.args ?? {};
  switch (call?.verb) {
    case "read_file": return `read ${a.path}`;
    case "list_dir": return `list ${a.path}`;
    case "run": return `run ${a.template}`;
    case "doctor": return "run the setup doctor";
    case "env": return "look at what's installed";
    case "preflight": return "pre-flight: what's installed, the doctor, CLI versions, the config's shape";
    case "plan": {
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const why = typeof a.why === "string" && a.why.trim() ? a.why.trim().slice(0, 120) : "a plan";
      return `plan: ${why} (${steps.length} step${steps.length === 1 ? "" : "s"}: ${steps.map(stepLabel).join(", ").slice(0, 200)})`;
    }
    // The three verbs a host must approve are the three that used to render as a
    // bare verb name (ultrareview #123, bug_007). Say WHAT, not just which.
    case "write_file": return `write ${a.path}${typeof a.content === "string" ? ` (${a.content.length} chars)` : ""}`;
    case "restore_backup": return `restore ${a.path} from ${a.backup ?? "its backup"}`;
    case "open_url": {
      try { const u = new URL(String(a.url ?? "")); return `open ${u.host}${u.pathname === "/" ? "" : u.pathname} in your browser`; }
      catch { return `open ${a.url ?? "a page"} in your browser`; }
    }
    default: return String(call?.verb ?? "?");
  }
}

/**
 * Structural TOML sanity check for write_file. Deliberately NOT a parser: it
 * rejects the ways a distracted agent breaks a config (unbalanced quotes or
 * brackets, an unterminated multi-line string, a line that is neither a table
 * header nor `key = value`) and accepts anything that has that shape.
 */
export function tomlLooksValid(text) {
  let multi = null; // the open multi-line string delimiter, if any
  let depth = 0;    // open [ / { across lines (multi-line arrays and inline tables)
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (multi) { if (line.includes(multi)) multi = null; continue; }
    if (!line || line.startsWith("#")) continue;
    if (depth > 0) {
      for (const ch of line) { if (ch === "[" || ch === "{") depth++; else if (ch === "]" || ch === "}") depth--; if (depth < 0) return false; }
      continue;
    }
    if (/^\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(line)) continue;
    const m = /^[A-Za-z0-9_\-."']+\s*=\s*(.+)$/.exec(line);
    if (!m) return false;
    const v = m[1].trim();
    if (v.startsWith('"""') || v.startsWith("'''")) {
      const q = v.slice(0, 3);
      if (!(v.length > 3 && v.endsWith(q))) multi = q;
      continue;
    }
    if (((v.match(/(?<!\\)"/g) || []).length) % 2 !== 0) return false;
    for (const ch of v) { if (ch === "[" || ch === "{") depth++; else if (ch === "]" || ch === "}") depth--; if (depth < 0) return false; }
  }
  return !multi && depth === 0;
}

/**
 * HOSTING MODE — may this Bridge serve a visiting agent's calls?
 *
 *   "always" — `hosting.enabled: true`  (`cookbook-bridge host`): serve any grant.
 *   "off"    — `hosting.enabled: false` (`cookbook-bridge host --off`): refuse all.
 *   "grants" — nothing configured: serve the grants this member approved themselves.
 *
 * The third is the default ON PURPOSE (2026-08-25). A grant only exists because the
 * host clicked Allow, in their own account, and it binds to this Bridge's own
 * credential — that click IS the consent. Making it also require a separate "hosting"
 * switch produced the failure Diego hit: Allow in a browser, a Bridge with the switch
 * off, and every call sat queued until the grant expired. The Bridge's LOCAL_CEILING
 * still holds every write at "ask", whatever the mode.
 */
export function hostingMode(cfg) {
  const v = cfg?.hosting?.enabled;
  if (v === true) return "always";
  if (v === false) return "off";
  return "grants";
}
