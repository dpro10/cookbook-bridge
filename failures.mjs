/**
 * HONEST FAILURES (Track B, 2026-09-15). Pure module: no imports from bridge.mjs.
 *
 * A run that did not finish used to hand the task back as "ran 2 attempt(s)
 * without completing", which told the person nothing and told the agent that
 * reads the receipt even less (Codex's product test of Cookbook, 2026-09-15:
 * "failure reporting leaves me stranded"). Every hand-back now carries a KIND,
 * one sentence of WHAT HAPPENED, one sentence of WHAT TO DO, and whether it is
 * terminal (retrying without the fix is pointless) or transient (retry once).
 *
 * The taxonomy is closed on purpose: eight kinds a person can act on, plus
 * "unknown" that still quotes the last line the CLI said.
 */

import { cli } from "./update.mjs";

export const FAILURE_KINDS = ["signed_out", "cli_too_old", "plan_window", "tool_blocked", "network", "timeout", "bridge_stopped", "cloud", "unknown"];

/** The sign-in command per vendor, as the member would type it on this machine. */
export function signInCommand(vendor) {
  switch (vendor) {
    case "claude": return "claude";
    case "codex": return "CODEX_HOME=~/.codex-bridge codex login";
    case "kimi": return "kimi login";
    case "gemini": return "agy login";
    case "openclaw": return "openclaw login";
    default: return null;
  }
}

const VENDOR_NAME = { claude: "Claude", codex: "Codex", kimi: "Kimi", gemini: "Gemini", openclaw: "OpenClaw" };

function lastLine(s, cap = 200) {
  const lines = String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, cap);
}

/** Parse a claude/gemini JSON envelope out of stdout (warnings may precede it). */
function envelope(out) {
  const raw = String(out ?? "");
  const brace = raw.indexOf("{");
  if (brace < 0) return null;
  try { return JSON.parse(raw.slice(brace)); } catch { return null; }
}

/**
 * Classify one failed run.
 *  - `result`: the runner's envelope { code, err, out, status } (may be null when
 *    the run threw before producing one).
 *  - `error`: the thrown Error, if the run threw (timeouts, liveness, launch).
 *  - `vendor`: "claude" | "codex" | "kimi" | "gemini" | "openclaw" | "other".
 *  - `agent`: the config entry (for `runner` and `name`).
 * Returns { kind, message, fix, terminal, command?, vendor }. Never throws.
 */
export function classifyFailure({ result = null, error = null, vendor = "other", agent = null } = {}) {
  const name = VENDOR_NAME[vendor] ?? (agent && agent.name) ?? "the agent";
  const errText = String(result?.err ?? "").toLowerCase();
  const thrown = String(error?.message ?? "").toLowerCase();
  const env = envelope(result?.out);
  const display = typeof env?.result === "string" ? env.result : "";
  const denials = Array.isArray(env?.permission_denials) ? env.permission_denials : [];
  const all = `${errText}\n${thrown}`;
  // Lines about an MCP server (Cookbook's or any the member added) are NOT the
  // vendor's own login: a revoked Cookbook token 401s inside the CLI and must
  // never read as "Claude is signed out" (that would flag the heartbeat and feed
  // the sign-in reopen loop). Judge sign-out on the vendor's own lines only.
  const vendorLines = all.split("\n").filter((l) => !/mcp|cookbook|codex_apps|tool server/.test(l)).join("\n");
  const cmd = signInCommand(vendor);
  const base = { vendor, command: null };

  // A Bridge-side failure to reach Cookbook is not the vendor's fault.
  if (/network error reaching cookbook|cookbook rejected the token|cookbook mcp error/.test(all)) {
    return { ...base, kind: "network", terminal: false,
      message: `This Bridge could not reach Cookbook (${lastLine(error?.message ?? result?.err, 120)}).`,
      fix: `Check the connection and the Bridge's token (\`${cli("doctor")}\`), then retry.` };
  }
  // Signed out: judged on stderr and thrown text, never on the model's answer, and
  // only in the vendor's own phrasing. `unauthorized` is Codex's app-server wording
  // and is accepted for Codex only.
  const signedOutRe = vendor === "codex"
    ? /oauth session expired|could not be refreshed|log out and sign in|failed to authenticate|not logged in|token_expired|invalid refresh token|unauthorized/
    : /oauth session expired|could not be refreshed|failed to authenticate|not logged in|please log in|login required|not authenticated/;
  if (signedOutRe.test(vendorLines)) {
    return { ...base, kind: "signed_out", terminal: true, command: cmd,
      message: `${name} on this machine is signed out (its session expired and the refresh was refused).`,
      fix: cmd ? `Open a terminal, run \`${cmd}\`, sign in, then retry. The Bridge picks the sign-in up on its own.` : `Sign in to ${name} on this machine, then retry.` };
  }
  if (/requires a newer version|upgrade to the latest|please upgrade|unsupported cli version|is no longer supported/.test(all)) {
    return { ...base, kind: "cli_too_old", terminal: true,
      message: `The ${name} CLI this Bridge runs is too old for your account's model.`,
      fix: vendor === "codex" ? "Update it (`npm i -g @openai/codex`) or point the Codex agent's command at a current `codex`, then retry." : `Update the ${name} CLI on this machine, then retry.` };
  }
  if (denials.length > 0 || /allowedtools|permission denied by policy|tool use denied/.test(all)) {
    const names = [...new Set(denials.map((d) => d?.tool_name).filter(Boolean))].slice(0, 3).join(", ");
    // Terminal only when the run produced NO answer at all: a model that answered
    // around a denied tool usually just forgot to file; the second attempt resumes.
    const terminal = denials.length > 0 && !display.trim();
    return { ...base, kind: "tool_blocked", terminal,
      message: `A tool the run needed was blocked${names ? ` (${names})` : ""}${display.trim() ? ", and the run did not finish" : ""}.`,
      fix: "Check the agent's `allowedTools` matches its MCP server name (a CLI-added Cookbook server is `mcp__cookbook__*`), or give the run the folder access it needs, then retry." };
  }
  if (/rate.?limit|plan limit|usage limit|quota exceeded|too many requests|\b429\b/.test(all)) {
    return { ...base, kind: "plan_window", terminal: false,
      message: `${name}'s plan window is closed on this machine.`,
      fix: "Retry when the window resets, or pick another agent for this turn." };
  }
  if (/timed out after|silent for|hit the .* ceiling|liveness|no output for|stalled|^killed:/m.test(thrown)) {
    const m = /(\d+)\s*(min|s)\b/.exec(thrown);
    const span = m ? (m[2] === "min" ? `${m[1]}-minute` : `${m[1]}-second`) : null;
    const why = /silent for|no output for|stalled/.test(thrown) ? `went quiet${m ? ` for ${m[1]} ${m[2] === "min" ? "minutes" : "seconds"}` : ""}` : `ran past the${span ? ` ${span}` : ""} ceiling`;
    return { ...base, kind: "timeout", terminal: false,
      message: `${name} ${why} and the run was stopped.`,
      fix: "Retry; if it happens again, split the task or raise `taskTimeoutSeconds` in the Bridge config." };
  }
  if (/could not launch|failed to launch|enoent|spawn .* enoent|command not found|not found on path/.test(all)) {
    const cwd = agent && agent.cwd ? String(agent.cwd) : null;
    return { ...base, kind: "cli_too_old", terminal: true,
      message: cwd ? `The ${name} CLI could not be started in ${cwd} (the folder or the CLI is missing).` : `The ${name} CLI could not be started on this machine.`,
      fix: cwd ? `Check that ${cwd} still exists and that ${name}'s CLI is installed, then run \`npx cookbook-bridge@latest doctor\` and retry.` : `Install ${name}'s CLI (or fix its path in the Bridge config), then run \`npx cookbook-bridge@latest doctor\` and retry.` };
  }
  if (/connection error|econnreset|econnrefused|enotfound|etimedout|fetch failed|network|dns|failed to connect|provider\.connection_error|socket hang up/.test(all)) {
    return { ...base, kind: "network", terminal: false,
      message: `${name} could not reach its API from this machine (${lastLine(result?.err ?? error?.message, 120)}).`,
      fix: "Check the connection (a VPN or a filter can block the vendor's hosts), then retry." };
  }
  if (/app-server exited|app-server is dead|runner exited|runner is dead/.test(all)) {
    return { ...base, kind: "unknown", terminal: false,
      message: `${name}'s process exited mid-run (${lastLine(result?.err ?? error?.message, 120)}).`,
      fix: `Retry once; if it repeats, run \`${cli("doctor")}\` and check the Bridge log.` };
  }
  if (typeof result?.code === "number" && result.code !== 0) {
    const tail = lastLine(result?.err) || lastLine(display) || "";
    return { ...base, kind: "unknown", terminal: false,
      message: `${name} exited with code ${result.code}${tail ? `: ${tail}` : "."}`,
      fix: "Retry once; if it repeats, the Bridge log has the full output." };
  }
  // A thrown error is the Bridge's account of the stop, not the model's words.
  if (error && !display.trim()) {
    return { ...base, kind: "unknown", terminal: false,
      message: `The run stopped: ${lastLine(error.message, 160) || "no reason was recorded"}.`,
      fix: "Retry once; if it repeats, the Bridge log has the full output." };
  }
  const said = lastLine(display) || lastLine(result?.err);
  return { ...base, kind: "unknown", terminal: false,
    message: said ? `${name} ran but did not finish the task. It last said: ${said}` : `${name} ran but did not finish the task and gave no reason.`,
    fix: "Retry once; if it repeats, open the receipt's work log or the Bridge log." };
}

/** The structured object that rides abandon_task (`failure`). Bounded, plain values only. */
export function failurePayload(f, stages = null) {
  if (!f) return null;
  const out = {
    kind: FAILURE_KINDS.includes(f.kind) ? f.kind : "unknown",
    message: String(f.message ?? "").slice(0, 300),
    fix: String(f.fix ?? "").slice(0, 300),
    terminal: f.terminal === true,
    ...(f.vendor ? { vendor: String(f.vendor).slice(0, 20) } : {}),
    ...(f.command ? { command: String(f.command).slice(0, 120) } : {}),
  };
  // Stage stamps ride flat (stage_*_ms), the shape the server's sanitizeFailure reads.
  if (stages) Object.assign(out, stagesPayload(stages));
  return out;
}

/** Stage stamps as milliseconds after the claim: { booted, first_words, done|failed }. */
export function stagesPayload(stages) {
  if (!stages || !stages.claimed) return {};
  const out = {};
  for (const k of ["booted", "first_words", "done", "failed"]) {
    if (typeof stages[k] === "number" && stages[k] >= stages.claimed) out[`stage_${k}_ms`] = Math.round(stages[k] - stages.claimed);
  }
  return out;
}

/** One line for the log and the legacy "Gave up:" result text. */
export function failureLine(f) {
  if (!f) return "";
  return `${f.message} ${f.fix}`.trim();
}
