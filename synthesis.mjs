/**
 * SYNTHESIS RUNNER (0092) — the workspace thinks on YOUR subscription.
 *
 * The server composes a prompt and queues it; this Bridge claimed it on a pull
 * and now runs it through the claude CLI (your plan, your machine) and posts
 * the text back. Five kinds share one lane:
 *
 *   summary  workspace summary        text in, text out, no tools
 *   caption  file captions            text in, text out, no tools
 *   answer   a question over context  text in, text out, no tools
 *   vision   describe one image       the image is downloaded to a private temp
 *                                     folder, claude runs with cwd = that folder
 *                                     and ONLY the Read tool, the folder is
 *                                     deleted afterwards (always, even on timeout)
 *   probe    one AI-visibility sample a buyer prompt; variant "model" runs with
 *                                     no tools, variant "search" with WebSearch
 *                                     only (allowed up front: print mode denies
 *                                     any tool that is not on --allowedTools)
 *
 * `--strict-mcp-config` with an empty set removes every MCP server; `--tools ""`
 * removes every built-in tool (Read, Bash, Write, WebFetch...) for the text
 * kinds, and `--tools Read` leaves exactly one for vision. The process env comes
 * from the caller (bridge.mjs passes agentEnv(cfg).env), so vendor API keys are
 * stripped the same way they are for task runs: synthesis bills the
 * subscription, never the API.
 *
 * Jobs are queued FIFO and drained one at a time. A pull that lands while a run
 * is in progress only enqueues; nothing is dropped. Zero dependencies.
 */
import { isSignedOutError } from "./plan.mjs";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SYNTHESIS_TIMEOUT_MS = 180_000;
export const VISION_TIMEOUT_MS = 240_000;
export const PROBE_TIMEOUT_MS = 120_000;
export const RESULT_MAX_CHARS = 8_000;
export const IMAGE_MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
export const KINDS = ["summary", "caption", "vision", "answer", "probe"];
export const PROBE_VARIANTS = ["model", "search"];
export const MODELS = ["haiku", "sonnet"];
export const DEFAULT_MODEL = "haiku";
export const IMAGE_PLACEHOLDER = "{{IMAGE_FILE}}";

/** Pick the claude binary from the configured agents (first claude-shaped,
 *  non-app-server command). Pure. */
export function claudeBinaryFrom(agents) {
  for (const a of agents ?? []) {
    if (!a?.command || a.runner === "app-server" || a.runner === "openclaw" || a.runner === "robot") continue;
    // Real configs carry the command as an ARRAY (["claude","-p","{prompt}",...]);
    // older ones as a string. Either way the binary is the first token.
    const first = Array.isArray(a.command) ? a.command[0] : String(a.command).trim().split(/\s+/)[0];
    const bin = String(first ?? "").trim();
    if (/claude/i.test(bin)) return bin;
  }
  return null;
}

/** Trim + cap a CLI result. Pure. */
export function trimResult(text) {
  return String(text ?? "").trim().slice(0, RESULT_MAX_CHARS);
}

/** A job's kind: absent means summary (older servers); anything outside KINDS is
 *  returned as-is so validateJob can refuse it. Pure. */
export function kindOf(job) {
  const k = job?.kind;
  return k == null || k === "" ? "summary" : String(k);
}

/** The model alias a job asks for, defaulting to haiku (fast + cheap on the plan). Pure. */
export function modelFor(job) {
  return MODELS.includes(job?.model) ? job.model : DEFAULT_MODEL;
}

/** Wall clock per kind: a picture takes longer to read, a probe is capped short. Pure. */
export function timeoutForKind(kind) {
  if (kind === "vision") return VISION_TIMEOUT_MS;
  if (kind === "probe") return PROBE_TIMEOUT_MS;
  return SYNTHESIS_TIMEOUT_MS;
}

/** A probe job's variant, or null when it is not one of the two lanes. Pure. */
export function variantOf(job) {
  return PROBE_VARIANTS.includes(job?.variant) ? job.variant : null;
}

/** File extension for an image MIME type; null for anything we will not write to disk. Pure. */
export function extFromMime(mime) {
  const m = String(mime ?? "").split(";")[0].trim().toLowerCase();
  switch (m) {
    case "image/png": return "png";
    case "image/jpeg": case "image/jpg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return null;
  }
}

/** Replace every {{IMAGE_FILE}} with the downloaded basename. Pure. */
export function substituteImageFile(prompt, basename) {
  return String(prompt ?? "").split(IMAGE_PLACEHOLDER).join(basename);
}

/** Strip anything URL-shaped from a message so a signed link never reaches a log
 *  or the server. Pure. */
export function scrubUrls(text) {
  return String(text ?? "").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]");
}

/** The argv a synthesis run gets: print mode, text out, no MCP, and either no
 *  built-in tools (text kinds), Read only (vision), or WebSearch only (a probe
 *  in its "search" variant; `--allowedTools` too, because print mode refuses a
 *  tool nobody granted). The prompt travels on stdin (never argv: no length
 *  limit, no shell quoting). Pure. */
export function argsForKind(kind, { model, variant } = {}) {
  const args = ["-p", "--output-format", "text", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
  if (kind === "vision") args.push("--tools", "Read");
  else if (kind === "probe" && variant === "search") args.push("--tools", "WebSearch", "--allowedTools", "WebSearch");
  else args.push("--tools", "");
  if (model) args.push("--model", model);
  return args;
}

/** Kept for callers that predate kinds: the summary argv. Pure. */
export function synthesisArgs({ model } = {}) {
  return argsForKind("summary", { model });
}

/** Why a job cannot run, or null when it can. Checked BEFORE anything is spawned
 *  or downloaded. Pure. */
export function validateJob(job) {
  if (!job?.id) return "job has no id";
  if (typeof job.prompt !== "string" || !job.prompt) return "job has no prompt";
  const kind = kindOf(job);
  if (!KINDS.includes(kind)) return `unsupported synthesis kind: ${kind}`;
  if (kind === "probe") return variantOf(job) ? null : `probe job has no variant (model or search)`;
  if (kind !== "vision") return null;
  const img = job.image;
  if (!img || typeof img !== "object") return "vision job has no image";
  if (typeof img.url !== "string" || !img.url) return "vision job has no image url";
  let u;
  try { u = new URL(img.url); } catch { return "image url is not a valid URL"; }
  if (u.protocol !== "https:") return "image url must be https";
  if (!extFromMime(img.mime)) return `unsupported image type: ${String(img.mime ?? "").split(";")[0] || "(none)"}`;
  return null;
}

/** The effective byte ceiling for an image job. Pure. */
export function imageMaxBytes(image) {
  const n = Number(image?.max_bytes);
  return Number.isFinite(n) && n > 0 ? n : IMAGE_MAX_BYTES_DEFAULT;
}

/** One log line per job. Never includes the prompt or the image URL. Pure. */
export function describeJob(job) {
  const kind = kindOf(job);
  if (kind === "probe") {
    const group = String(job?.group ?? "?").slice(0, 8);
    const id = Number.isInteger(Number(job?.prompt_id)) ? Number(job.prompt_id) : "?";
    return `probe: ${group} #${id} (${variantOf(job) ?? "?"})`;
  }
  const n = Number(job?.files);
  const files = Number.isInteger(n) && n > 0 ? ` (${n} file${n === 1 ? "" : "s"})` : "";
  return `${kind}${files}`;
}

function runClaude(bin, prompt, { args, env, cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: env ?? process.env, cwd });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    child.stdin.on("error", () => { /* EPIPE when the CLI exits early: the close handler reports it */ });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs ?? SYNTHESIS_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = trimResult(out);
      if (timedOut) resolve({ ok: false, timedOut: true, error: `timed out after ${Math.round((timeoutMs ?? SYNTHESIS_TIMEOUT_MS) / 1000)}s` });
      else if (code === 0 && text) resolve({ ok: true, text });
      else if (isSignedOutError(err)) resolve({ ok: false, error: "Claude is signed out on this machine: open a terminal, run `claude`, and sign in" });
      else resolve({ ok: false, error: `exit ${code}: ${err.trim().slice(0, 300) || "(no stderr)"}` });
    });
    child.stdin.write(String(prompt));
    child.stdin.end();
  });
}

/** Run with the requested model alias; if the CLI rejects it (non-zero exit,
 *  e.g. an older CLI that does not know the alias) run once more without
 *  --model. A timeout is not a rejected alias, so it is not retried. */
async function runWithFallback(bin, prompt, { kind, model, variant, env, cwd }) {
  const timeoutMs = timeoutForKind(kind);
  // A probe measures what a STRANGER's Claude would say, so it must run in a
  // fresh empty directory: Claude Code loads its per-directory auto-memory and
  // any CLAUDE.md from the cwd, and the Bridge's own cwd is full of Cookbook.
  // (The 2026-09-03 baseline run leaked "your existing Cookbook setup" this way.)
  let scratch = null;
  if (kind === "probe" && !cwd) {
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "cookbook-probe-"));
    cwd = scratch;
  }
  try {
    let r = await runClaude(bin, prompt, { args: argsForKind(kind, { model, variant }), env, cwd, timeoutMs });
    if (!r.ok && !r.timedOut && model) r = await runClaude(bin, prompt, { args: argsForKind(kind, { variant }), env, cwd, timeoutMs });
    return r;
  } finally {
    if (scratch) await fsp.rm(scratch, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}

/** Where a probe runs: a fresh temp dir, never the Bridge's own cwd. Pure. */
export function probeNeedsScratchCwd(kind, cwd) {
  return kind === "probe" && !cwd;
}

/** Download the job's image into `dir` as image.<ext>. Refuses non-https, unknown
 *  MIME, and anything over max_bytes (by Content-Length up front and by counting
 *  bytes as they arrive). Error messages never carry the URL. */
export async function downloadImage(image, dir) {
  const ext = extFromMime(image?.mime);
  if (!ext) throw new Error("unsupported image type");
  const u = new URL(String(image?.url ?? ""));
  if (u.protocol !== "https:") throw new Error("image url must be https");
  const max = imageMaxBytes(image);
  let res;
  try {
    res = await fetch(u, { redirect: "follow" });
  } catch (e) {
    throw new Error(`image download failed: ${scrubUrls(e?.message ?? String(e))}`);
  }
  if (!res.ok) throw new Error(`image download failed (${res.status})`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error(`image exceeds ${max} bytes`);
  if (!res.body) throw new Error("image download failed (empty body)");
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => { /* already closed */ });
      throw new Error(`image exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  if (!size) throw new Error("image download failed (empty file)");
  const name = `image.${ext}`;
  await fsp.writeFile(path.join(dir, name), Buffer.concat(chunks), { mode: 0o600 });
  return name;
}

/** The default runner: text kinds go straight to claude; vision first stages the
 *  image in a fresh 0700 temp directory that is removed in `finally`, no matter
 *  how the run ends. */
async function defaultRun(job, { cfg, env }) {
  const bin = claudeBinaryFrom(cfg?.agents);
  if (!bin) return { ok: false, error: "no Claude CLI configured on this Bridge" };
  const kind = kindOf(job);
  const model = modelFor(job);
  const variant = variantOf(job);
  if (kind !== "vision") return runWithFallback(bin, job.prompt, { kind, model, variant, env });
  let dir = null;
  try {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cookbook-vision-"));
    await fsp.chmod(dir, 0o700);
    const file = await downloadImage(job.image, dir);
    const prompt = substituteImageFile(job.prompt, file);
    return await runWithFallback(bin, prompt, { kind, model, env, cwd: dir });
  } catch (e) {
    return { ok: false, error: scrubUrls(e?.message ?? String(e)) };
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}

async function defaultReport(cfg, jobId, payload) {
  try {
    const res = await fetch(`${cfg.cookbookUrl}/api/bridge/synthesis`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ job_id: jobId, ...payload }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── The queue: FIFO, one run at a time, nothing dropped ──
const queue = [];
const seen = new Set();
let draining = false;

/** Forget queued and seen jobs. Tests only. */
export function resetSynthesisQueue() {
  queue.length = 0;
  seen.clear();
  draining = false;
}

/** How many jobs are waiting (not counting the one running). */
export function synthesisQueueSize() {
  return queue.length;
}

async function runOne(entry) {
  const { job, cfg, log, opts } = entry;
  const run = opts.run ?? defaultRun;
  const report = opts.report ?? defaultReport;
  const label = describeJob(job);
  // A probe announces itself as "probe: A #3 (search)"; the rest as "synthesis: <kind>".
  const head = kindOf(job) === "probe" ? label : `synthesis: ${label}`;
  const invalid = validateJob(job);
  if (invalid) {
    await report(cfg, job.id, { error: invalid });
    log?.(`! ${head} refused: ${invalid}`);
    return;
  }
  log?.(`◇ ${head} on your subscription`);
  const t0 = Date.now();
  let r;
  try {
    r = await run(job, { cfg, env: opts.env, log });
  } catch (e) {
    r = { ok: false, error: scrubUrls(e?.message ?? String(e)) };
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (r?.ok) {
    const posted = await report(cfg, job.id, { result: trimResult(r.text) });
    log?.(`◇ ${head} done in ${secs}s${posted ? "" : " (post failed)"}`);
  } else {
    const error = scrubUrls(r?.error ?? "unknown error");
    await report(cfg, job.id, { error });
    log?.(`! ${head} failed after ${secs}s: ${error}`);
  }
}

/** Enqueue every unseen job and drain the queue one job at a time. A call that
 *  lands while a drain is in progress only enqueues; the running drain picks the
 *  new jobs up in order. Resolves when the queue is empty (or immediately, when
 *  another call is already draining).
 *
 *  Options: `env` (process env for claude), and for tests `run(job, ctx)` in
 *  place of the claude runner and `report(cfg, id, payload)` in place of the
 *  POST. */
export async function runSynthesisJobs(cfg, jobs, log, opts = {}) {
  for (const j of jobs ?? []) {
    if (!j?.id || typeof j.prompt !== "string" || !j.prompt || seen.has(j.id)) continue;
    seen.add(j.id);
    queue.push({ job: j, cfg, log, opts });
  }
  if (seen.size > 500) {
    seen.clear();
    for (const q of queue) seen.add(q.job.id); // still waiting: never enqueue twice
  }
  if (draining) return;
  draining = true;
  try {
    while (queue.length) await runOne(queue.shift());
  } finally {
    draining = false;
  }
}
