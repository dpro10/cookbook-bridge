/**
 * Run-cost extraction — "what did this task cost the runner's quota?"
 *
 * Side-effect-free on purpose (bridge.mjs dispatches on import; testable helpers live
 * in modules like this — see scripts/test-bridge-usage.ts). After a verified-done run,
 * the Bridge normalizes whatever the CLI reported and posts it to Cookbook via
 * report_task_usage, so the ASSIGNER sees the cost of the delegation and the RUNNER
 * sees what their quota paid for. Everything here is best-effort: a CLI that reports
 * nothing simply yields duration-only usage — never an error.
 *
 * Known shapes handled:
 *  - Claude Code `claude -p --output-format json` (verified against a real run):
 *      { result, usage: { input_tokens, output_tokens, cache_read_input_tokens,
 *        cache_creation_input_tokens, ... }, total_cost_usd, duration_ms, num_turns,
 *        modelUsage: { "<model>": {...} } }
 *  - Codex app-server token events (captured by codex-runner.mjs):
 *      { input_tokens | inputTokens, cached_input_tokens | cachedInputTokens,
 *        output_tokens | outputTokens, ... } — camel/snake both seen in the wild.
 *  - Gemini CLI JSON output (best-effort): { stats: { models: { "<model>":
 *      { tokens: { prompt, candidates, cached, total } } } } } or a flat usage object.
 *  - OpenClaw `openclaw agent --json` envelope:
 *      { ok, status, final, usage: {...}, model, sessionId } — the usage object is
 *      provider-shaped, so it is read with the same tolerant key set as Codex.
 */

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);

/** Drop undefined fields; return null when nothing of substance remains. */
function compact(u) {
  const out = {};
  for (const [k, v] of Object.entries(u)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  const hasSubstance =
    out.input_tokens !== undefined || out.output_tokens !== undefined ||
    out.cost_usd !== undefined || out.duration_ms !== undefined;
  return hasSubstance ? out : null;
}

/** Claude Code / generic flat shape: { usage: {...}, total_cost_usd, duration_ms, ... } */
function fromClaudeJson(j) {
  const u = j.usage;
  if (!u || typeof u !== "object") return null;
  return compact({
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    cost_usd: num(j.total_cost_usd),
    duration_ms: num(j.duration_ms),
    num_turns: num(j.num_turns),
    model: j.modelUsage && typeof j.modelUsage === "object" ? Object.keys(j.modelUsage)[0] : undefined,
  });
}

/** Gemini CLI stats shape: { stats: { models: { "<model>": { tokens: {...} } } } } */
function fromGeminiStats(j) {
  const models = j?.stats?.models;
  if (!models || typeof models !== "object") return null;
  let input = 0, output = 0, cached = 0, any = false;
  for (const m of Object.values(models)) {
    const t = m?.tokens;
    if (!t) continue;
    any = true;
    input += Number(t.prompt) || 0;
    output += Number(t.candidates) || 0;
    cached += Number(t.cached) || 0;
  }
  if (!any) return null;
  return compact({
    input_tokens: input || undefined,
    output_tokens: output || undefined,
    cache_read_input_tokens: cached || undefined,
    model: Object.keys(models)[0],
  });
}

/** OpenClaw envelope: usage is provider-shaped, model is a sibling of it. */
function fromOpenclawEnvelope(j) {
  if (!j || typeof j !== "object" || typeof j.final !== "string") return null;
  const u = j.usage && typeof j.usage === "object" ? j.usage : null;
  const t = u ? (u.total_token_usage ?? u.totalTokenUsage ?? u) : {};
  return compact({
    input_tokens: num(t.input_tokens ?? t.inputTokens ?? t.prompt_tokens ?? t.promptTokens),
    output_tokens: num(t.output_tokens ?? t.outputTokens ?? t.completion_tokens ?? t.completionTokens),
    cache_read_input_tokens: num(t.cache_read_input_tokens ?? t.cached_input_tokens ?? t.cachedInputTokens),
    cost_usd: num(u?.cost_usd ?? u?.total_cost_usd),
    model: typeof j.model === "string" ? j.model : undefined,
  });
}

/** Codex app-server token_usage (camel or snake): captured by codex-runner. */
export function fromCodexUsage(u) {
  if (!u || typeof u !== "object") return null;
  // Some payloads nest { total_token_usage: {...} } / { last_token_usage: {...} }.
  const t = u.total_token_usage ?? u.totalTokenUsage ?? u;
  return compact({
    input_tokens: num(t.input_tokens ?? t.inputTokens),
    output_tokens: num(t.output_tokens ?? t.outputTokens),
    cache_read_input_tokens: num(t.cached_input_tokens ?? t.cachedInputTokens),
  });
}

/**
 * Extract normalized usage from a finished run.
 *  - result: { out, err?, code? } for one-shot CLIs, or { out, usage? } from codex-runner.
 *  - wallMs: the Bridge's own wall-clock measurement — the duration fallback, so every
 *    report has at least duration even when the CLI says nothing.
 * Returns the report_task_usage argument object, or null if there's nothing to say.
 */
export function extractUsage(result, agentName, wallMs) {
  let usage = null;

  // Persistent-runner path: codex-runner captured token events directly.
  if (result && result.usage) usage = fromCodexUsage(result.usage);

  // One-shot path: stdout may be a JSON document (claude/gemini json output modes).
  if (!usage && result && typeof result.out === "string") {
    const text = result.out.trim();
    // Parse from the first "{"/"[" — CLIs print warnings BEFORE the envelope (the
    // same prefix noise that broke displayText, audit 2026-07-03 #8: fixing one
    // sibling and not the other silently dropped token receipts).
    const start = Math.min(...["{", "["].map((c) => {
      const i = text.indexOf(c);
      return i < 0 ? Infinity : i;
    }));
    if (start !== Infinity) {
      try {
        const j = JSON.parse(text.slice(start));
        usage = fromClaudeJson(j) ?? fromGeminiStats(j) ?? fromOpenclawEnvelope(j);
      } catch {
        /* not JSON — no usage in text mode */
      }
    }
  }

  const merged = compact({
    ...(usage ?? {}),
    duration_ms: usage?.duration_ms ?? num(wallMs),
    runner: agentName,
  });
  return merged;
}

/**
 * The agent's human-readable answer, for logs/hints: with `--output-format json` the
 * text lives in `.result` (claude) / `.response` (gemini); in text mode it IS stdout.
 */
export function displayText(out) {
  const text = String(out ?? "").trim();
  // CLIs can print warnings BEFORE the JSON envelope (e.g. claude's workspace-trust
  // notice), so parse from the first "{" rather than requiring the text to start
  // with it. Verified live 2026-07-03: the prefix noise made a volunteer decision
  // read as PASS.
  const brace = text.indexOf("{");
  if (brace >= 0) {
    try {
      const j = JSON.parse(text.slice(brace));
      if (typeof j.result === "string") return j.result;
      if (typeof j.response === "string") return j.response;
      if (typeof j.final === "string") return j.final; // openclaw envelope
    } catch {
      /* fall through */
    }
  }
  return text;
}
