/**
 * PLAN WINDOWS — "how much of my subscription have I used?" (Diego, 2026-08-29).
 *
 * The vendors' own CLIs already tell the Bridge, on every run, where the member's
 * plan stands — nobody was catching it:
 *   - claude `-p --output-format stream-json --verbose` emits a `rate_limit_event`
 *     with `unifiedWindows.five_hour / seven_day { utilization, resetsAt }`.
 *   - codex app-server answers `account/rateLimits/read` (and pushes
 *     `account/rateLimits/updated`) with `primary / secondary { usedPercent,
 *     windowDurationMins, resetsAt }` + `planType`.
 *   - gemini-cli / agy report nothing about quota (verified 2026-08-29): honest
 *     absence, never a guess.
 *
 * This module is the one place that knows those shapes. It keeps the LATEST
 * observation per vendor in memory and hands the Bridge a query fragment to ride
 * on its heartbeat (`?plan=…`, next to `?agents=`). No credential leaves the
 * machine — a window is two numbers the member's own CLI printed.
 *
 * Wire shape (compact, re-validated server-side in src/lib/bridge/plan.ts):
 *   { claude: { five_hour: { u: 0.66, r: 1788044400 }, seven_day: { u: 0.49, r: … }, at: <epoch s>, plan: "max" | null } }
 *   u = fraction used (0..1+), r = epoch SECONDS the window resets.
 *
 * Pure parsers + a tiny store, no network, no fs — testable from the outside.
 */

const VENDORS = new Set(["claude", "codex", "gemini", "openclaw"]);
const latest = new Map(); // vendor -> { five_hour?, seven_day?, at, plan }

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** A window from (fraction-or-percent, reset). Accepts 0..1 fractions or 0..100 percents. */
function window(used, resetsAt, { percent = false } = {}) {
  let u = num(used);
  const r = num(resetsAt);
  if (u === null) return null;
  if (percent) u = u / 100;
  if (u < 0) u = 0;
  return { u: Math.round(u * 1000) / 1000, ...(r !== null && r > 0 ? { r: Math.round(r > 1e11 ? r / 1000 : r) } : {}) };
}

/**
 * claude stream-json → observation, or null for every other line.
 *   {"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.66,"resetsAt":1788044400},"seven_day":{…}}}}
 */
export function planFromStreamLine(line) {
  let j;
  try { j = typeof line === "string" ? JSON.parse(line) : line; } catch { return null; }
  if (!j || typeof j !== "object" || j.type !== "rate_limit_event") return null;
  const info = j.rate_limit_info;
  const w = info && typeof info === "object" ? info.unifiedWindows : null;
  if (!w || typeof w !== "object") return null;
  const five = w.five_hour && typeof w.five_hour === "object" ? window(w.five_hour.utilization, w.five_hour.resetsAt) : null;
  const seven = w.seven_day && typeof w.seven_day === "object" ? window(w.seven_day.utilization, w.seven_day.resetsAt) : null;
  if (!five && !seven) return null;
  return { vendor: "claude", ...(five ? { five_hour: five } : {}), ...(seven ? { seven_day: seven } : {}), plan: null };
}

/**
 * codex app-server `account/rateLimits/read` result (or the `updated` notification's
 * params) → observation. Windows are named by their length, not by position:
 * primary is the short one only because that is how OpenAI orders them today.
 */
export function planFromCodexRateLimits(result) {
  const rl = result && typeof result === "object" ? (result.rateLimits && typeof result.rateLimits === "object" ? result.rateLimits : result) : null;
  if (!rl || typeof rl !== "object") return null;
  const out = { vendor: "codex", plan: typeof rl.planType === "string" ? rl.planType : null };
  let any = false;
  for (const key of ["primary", "secondary"]) {
    const w = rl[key];
    if (!w || typeof w !== "object") continue;
    const mins = num(w.windowDurationMins ?? w.window_minutes);
    const win = window(w.usedPercent ?? w.used_percent, w.resetsAt ?? w.resets_at, { percent: true });
    if (!win) continue;
    const slot = mins !== null && mins > 600 ? "seven_day" : "five_hour";
    if (!out[slot]) { out[slot] = win; any = true; }
  }
  return any ? out : null;
}

/** Record the newest observation for its vendor. Returns true when something changed. */
export function notePlan(obs, now = Date.now()) {
  if (!obs || typeof obs !== "object" || !VENDORS.has(obs.vendor)) return false;
  const entry = {
    ...(obs.five_hour ? { five_hour: obs.five_hour } : {}),
    ...(obs.seven_day ? { seven_day: obs.seven_day } : {}),
    at: Math.round(now / 1000),
    plan: typeof obs.plan === "string" && obs.plan ? obs.plan.slice(0, 32) : null,
  };
  const prev = latest.get(obs.vendor);
  latest.set(obs.vendor, entry);
  const same = prev && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...entry, at: 0 });
  return !same;
}

/** Everything observed this process lifetime, keyed by vendor. */
export function latestPlans() {
  const out = {};
  for (const [v, e] of latest) out[v] = e;
  return out;
}

/** For tests. */
export function resetPlans() {
  latest.clear();
}

/** `plan=<json>` (no leading `?`/`&`), or "" when nothing has been observed. */
export function planParam() {
  if (!latest.size) return "";
  return `plan=${encodeURIComponent(JSON.stringify(latestPlans()))}`;
}

/** One human line for the Bridge log: `claude 66% of 5h · 49% of week`. */
export function planLine(vendor, entry) {
  const pct = (w) => (w && typeof w.u === "number" ? `${Math.round(w.u * 100)}%` : null);
  const parts = [];
  const f = pct(entry?.five_hour);
  const s = pct(entry?.seven_day);
  if (f) parts.push(`${f} of 5h`);
  if (s) parts.push(`${s} of week`);
  return `${vendor}${entry?.plan ? ` (${entry.plan})` : ""}: ${parts.join(" · ") || "no windows"}`;
}
