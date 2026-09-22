#!/usr/bin/env node
/**
 * CLOUD ENTRY — the Bridge, one shot, inside a Cookbook sandbox (0102).
 *
 * The same bridge.mjs a laptop runs, pointed at a seeded CODEX_HOME and told to
 * run what is claimable now and then exit. Everything a run needs arrives as
 * environment (the dispatcher sets it when it creates the box):
 *
 *   COOKBOOK_URL            https://cookbook.team
 *   COOKBOOK_BRIDGE_TOKEN   the box's Bridge token (device "Cookbook Cloud")
 *   COOKBOOK_CODEX_TOKEN    the box's "Codex" agent token (MCP bearer, attribution)
 *   COOKBOOK_ONLY_TASK      optional: run just this task id
 *   COOKBOOK_ATTEMPT_ID     the attempt this box is; sent back with the refreshed auth
 *   CODEX_HOME              where auth.json was seeded (default /vercel/sandbox/.codex)
 *   COOKBOOK_TIMEOUT_SECONDS  per-run ceiling (default 1800)
 *   CODEX_BIN               the codex binary (default "codex", on PATH in the image)
 *
 * Afterwards it posts the auth.json Codex refreshed in place back to Cookbook,
 * the "keep the refreshed auth.json for the next run" step in OpenAI's CI/CD
 * guide. The auth file never goes to stdout; the tokens never land on disk
 * beyond this box's config.json (mode 0600, gone with the box).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The agent name the receipt shows; matches assignees "Codex", "ChatGPT", "OpenAI". */
export const CLOUD_AGENT_NAME = "Codex · cloud";

/** Pure: the Codex config that points its MCP client at Cookbook, file-backed credentials. */
export function codexConfigToml(cookbookUrl) {
  return [
    'cli_auth_credentials_store = "file"',
    "",
    "[mcp_servers.cookbook]",
    `url = "${cookbookUrl.replace(/\/+$/, "")}/api/mcp"`,
    'bearer_token_env_var = "COOKBOOK_CODEX_TOKEN"',
    "",
  ].join("\n");
}

/** Pure: the Bridge config for one cloud run. No auto-update, no connector sync, one attempt. */
export function buildConfig(env) {
  const url = (env.COOKBOOK_URL || "").replace(/\/+$/, "");
  if (!url || !env.COOKBOOK_BRIDGE_TOKEN || !env.COOKBOOK_CODEX_TOKEN) throw new Error("COOKBOOK_URL, COOKBOOK_BRIDGE_TOKEN and COOKBOOK_CODEX_TOKEN are required");
  const timeout = Math.max(60, Math.min(6 * 3600, Number(env.COOKBOOK_TIMEOUT_SECONDS) || 1800));
  return {
    cookbookUrl: url,
    token: env.COOKBOOK_BRIDGE_TOKEN,
    pollSeconds: 15,
    maxAttempts: 1,
    maxConcurrentRuns: 1,
    taskTimeoutSeconds: timeout,
    autoUpdate: false,
    syncConnectors: false,
    persistentThreads: false,
    default: CLOUD_AGENT_NAME,
    agents: [
      {
        name: CLOUD_AGENT_NAME,
        match: ["codex", "chatgpt", "openai"],
        enabled: true,
        runner: "app-server",
        command: [env.CODEX_BIN || "codex"],
        codexHome: env.CODEX_HOME || "/vercel/sandbox/.codex",
        sandbox: "workspace-write",
        token: env.COOKBOOK_CODEX_TOKEN,
      },
    ],
  };
}

async function postAuthBack({ url, bridgeToken, codexHome, attemptId, log }) {
  const p = path.join(codexHome, "auth.json");
  if (!fs.existsSync(p)) { log("auth sync: no auth.json to send"); return false; }
  try {
    const res = await fetch(`${url}/api/bridge/cloud/auth`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridgeToken}`, "Content-Type": "application/json", ...(attemptId ? { "x-cookbook-attempt": attemptId } : {}) },
      body: fs.readFileSync(p, "utf8"),
    });
    // A missing route renders the site's not-found page (HTML, and a 200 on POST);
    // only the real route answers JSON. Anything else is "not stored".
    const isJson = /application\/json/i.test(res.headers.get("content-type") || "");
    if (res.status === 404 || (res.ok && !isJson)) { log("auth sync: the server has no cloud auth route yet (skipped)"); return false; }
    if (!res.ok) { log(`auth sync: server said ${res.status}`); return false; }
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true) { log(`auth sync: server did not confirm (${body?.error ?? "no body"})`); return false; }
    log("auth sync: refreshed sign-in stored");
    return true;
  } catch (e) {
    log(`auth sync failed: ${e.message}`);
    return false;
  }
}

export async function main(env = process.env) {
  const log = (m) => process.stdout.write(`[cloud-entry] ${m}\n`);
  const cfg = buildConfig(env);
  const codexHome = cfg.agents[0].codexHome;
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(codexHome, "auth.json"))) { log("no auth.json in CODEX_HOME; the member must connect ChatGPT first"); return 2; }
  fs.writeFileSync(path.join(codexHome, "config.toml"), codexConfigToml(cfg.cookbookUrl), { mode: 0o600 });
  const cfgPath = path.join(HERE, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });

  const childEnv = { ...env, COOKBOOK_ONCE: "1", COOKBOOK_CLOUD: "1", CODEX_HOME: codexHome };
  if (env.COOKBOOK_ONLY_TASK) childEnv.COOKBOOK_ONLY_TASK = env.COOKBOOK_ONLY_TASK;
  log(`starting the Bridge one-shot${env.COOKBOOK_ONLY_TASK ? ` for task ${env.COOKBOOK_ONLY_TASK.slice(0, 8)}` : ""}`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, "bridge.mjs"), cfgPath], { env: childEnv, stdio: "inherit" });
    child.on("error", (e) => { log(`could not start the Bridge: ${e.message}`); resolve(1); });
    child.on("exit", (c) => resolve(c ?? 1));
  });
  await postAuthBack({ url: cfg.cookbookUrl, bridgeToken: cfg.token, codexHome, attemptId: env.COOKBOOK_ATTEMPT_ID || null, log });
  try { fs.unlinkSync(cfgPath); } catch { /* already gone */ }
  log(`done (bridge exit ${code})`);
  return code;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((e) => { process.stderr.write(`[cloud-entry] ${e.message}\n`); process.exit(1); });
}
