/**
 * Minimal Cookbook MCP client for the Bridge.
 *
 * The Cookbook MCP endpoint (/api/mcp) is a STATELESS Streamable-HTTP JSON-RPC
 * server: every POST carries a bearer token and is authenticated independently,
 * so we can call tools/call directly — no initialize handshake or session to
 * maintain. The tool's result lands in `result.structuredContent`.
 *
 * Node built-ins only (global fetch, Node 18+). No dependencies.
 */
import { planParam, signedOutParam } from "./plan.mjs";

/** Call one Cookbook MCP tool. Returns the tool's body (structuredContent). */
export async function callTool(cfg, name, args = {}) {
  let res;
  try {
    res = await fetch(`${cfg.cookbookUrl}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
  } catch (e) {
    throw new Error(`network error reaching Cookbook: ${e.message}`);
  }
  if (res.status === 401) {
    throw new Error("Cookbook rejected the token (401). Check `token` in your config — generate one on your account's Tokens page.");
  }
  const j = await res.json().catch(() => null);
  if (!j) throw new Error(`unexpected response from Cookbook (HTTP ${res.status})`);
  if (j.error) throw new Error(`Cookbook MCP error: ${j.error.message}`);
  const body = j.result?.structuredContent ?? {};
  if (j.result?.isError) throw new Error(`tool ${name} failed: ${body.error ?? "unknown error"}`);
  return body;
}

/** All workspaces the token's member belongs to. */
export async function listTeamConnectors(cfg, workspaceId) {
  const body = await callTool(cfg, "list_connectors", { workspace_id: workspaceId });
  return Array.isArray(body?.connectors) ? body.connectors : [];
}

export async function listWorkspaces(cfg) {
  const body = await callTool(cfg, "list_workspaces", {});
  return body.workspaces ?? [];
}

/** ONE-CALL open-work discovery across all the member's workspaces (chat-feel
 *  dispatch). Returns [] when the server predates the tool — callers fall back
 *  to the per-workspace sweep. */
export async function listOpenWork(cfg) {
  try {
    const body = await callTool(cfg, "list_open_work", {});
    return { supported: true, work: body.work ?? [], warmHints: body.warm_hints ?? [] };
  } catch (e) {
    if (/unknown tool/i.test(e.message)) return { supported: false, work: [], warmHints: [] };
    throw e;
  }
}

/** Tasks in a workspace. filter: 'open' | 'all' | 'mine'. */
export async function listTasks(cfg, workspaceId, filter = "open") {
  const body = await callTool(cfg, "list_tasks", { workspace_id: workspaceId, filter });
  return body.tasks ?? [];
}

/** Fetch one task's current state (via the full list — there is no get_task). */
export async function getTask(cfg, workspaceId, taskId) {
  const tasks = await listTasks(cfg, workspaceId, "all");
  return tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * Composer-thread continuity (0064): find the freshest resume handle in a thread —
 * the latest run (root or follow-up) that reported a progress.session_ref. Resuming
 * mints a NEW session id each time, so "the thread's session" is always the newest
 * one, never the root's. Returns { sessionRef, root } (either may be null).
 */
export async function threadResumeContext(cfg, workspaceId, rootId, myProfileId = null) {
  const tasks = await listTasks(cfg, workspaceId, "all");
  const inThread = tasks.filter((t) => t.id === rootId || t.thread_root_id === rootId);
  const root = inThread.find((t) => t.id === rootId) ?? null;
  // A session only exists on the machine that created it. In a crew that spans
  // people, the previous turn may have run on a TEAMMATE's Bridge: resuming that id
  // here fails with "No conversation found" (Pierre's reviewer, 2026-08-30). Only
  // runs this member claimed are resumable; anything else gets the cold baton.
  const stamped = inThread
    .filter((t) => t.progress && typeof t.progress.session_ref === "string" && t.progress.session_ref)
    .filter((t) => !myProfileId || !t.claimed_by_profile || t.claimed_by_profile === myProfileId)
    .sort((a, b) => String(b.progress.updated_at ?? "").localeCompare(String(a.progress.updated_at ?? "")));
  return { sessionRef: stamped[0]?.progress.session_ref ?? null, root };
}

/**
 * Ask Cookbook's UI-managed delegation policy whether to run this task:
 *   "run"     — your policy allows it (or you assigned it yourself)
 *   "pending" — your policy is "ask"; it's parked for your approval — don't run
 *   "skip"    — blocked by your policy
 * Throws if the server doesn't support it yet (caller falls back).
 */
export async function resolveDelegation(cfg, taskId) {
  try {
    const body = await callTool(cfg, "resolve_task_delegation", { task_id: taskId });
    // Return the full shape { decision, mode, reason, cap, spent } so the caller can
    // surface a daily-cap hold distinctly. Back-compat: callers reading `.decision`
    // still work; a bare string is no longer returned.
    return { decision: body.decision ?? "run", reason: body.reason, cap: body.cap, spent: body.spent };
  } catch (e) {
    // A CONSENT gate must fail closed on transient errors — only a server that
    // genuinely doesn't have the tool (pre-delegation deploy) may fall back to run.
    if (/unknown tool/i.test(e.message)) return { decision: "run" };
    throw e;
  }
}

/**
 * Bridge-filed completion (chat lane): the agent's final streamed message IS the
 * result, so the Bridge files it in one cheap HTTP call instead of the agent
 * spending a whole model round-trip on the complete_task tool. Claimer-only
 * server-side (the Bridge acts as the claiming member, so the wall passes).
 */
export async function completeTaskApi(cfg, workspaceId, taskId, result) {
  return callTool(cfg, "complete_task", { workspace_id: workspaceId, task_id: taskId, result });
}

/**
 * Report what a completed run cost (tokens/cost/duration) so the assigner can see the
 * price of the delegation. `usage` is the report_task_usage argument object from
 * usage.mjs extractUsage. First report wins server-side; duplicates are no-ops.
 */
export async function reportTaskUsage(cfg, workspaceId, taskId, usage) {
  return callTool(cfg, "report_task_usage", { workspace_id: workspaceId, task_id: taskId, ...usage });
}

/**
 * Stream LIVE in-flight token counts while an agent is still running, so the board
 * ticks upward in real time (report_task_progress; latest-wins, claimed-only).
 */
export async function reportTaskProgress(cfg, workspaceId, taskId, progress) {
  return callTool(cfg, "report_task_progress", { workspace_id: workspaceId, task_id: taskId, ...progress });
}

/**
 * Credit the memory notes that rode into a run which then completed — the outcome
 * signal behind outcome-weighted recall. Best-effort: never throws (swallowed here).
 */
export async function creditRecall(cfg, workspaceId, noteIds) {
  if (!Array.isArray(noteIds) || noteIds.length === 0) return;
  try {
    await callTool(cfg, "credit_recall", { workspace_id: workspaceId, note_ids: noteIds });
  } catch {
    /* outcome crediting is best-effort — a miss just means the note isn't lifted yet */
  }
}

/**
 * Atomically claim an open GOAL task this Bridge decided to volunteer for — the claim is
 * the race: two Bridges volunteering resolve in the DB (loser gets a clean error).
 * claimed_via='volunteered' is recorded for the board + credibility history.
 */
export async function volunteerClaim(cfg, workspaceId, taskId) {
  return callTool(cfg, "claim_task", { workspace_id: workspaceId, task_id: taskId, volunteered: true });
}

/**
 * Atomically claim a DISPATCHED task before running it (Phase 0, audit #1): without
 * this, a `to:'any'` task — or one member's Bridge on two machines — ran N times.
 * The DB's status='open' CAS makes the first claimer the only runner; the loser
 * gets a clean error and skips. Returns the claimed task, or null if lost.
 */
export async function dispatchClaim(cfg, workspaceId, taskId) {
  try {
    const body = await callTool(cfg, "claim_task", { workspace_id: workspaceId, task_id: taskId });
    return body.task ?? null;
  } catch {
    return null; // someone else won (or the task just left `open`) — not ours to run
  }
}

/**
 * Hand a task back LOUDLY (Phase 0, audit #2/#8): after the final failed attempt,
 * mark it abandoned with the failure hint so the assigner sees "tried, gave up,
 * here's why" on the board instead of a task that silently rots. Best-effort —
 * an older server without abandon_task just leaves the legacy behavior.
 */
export async function abandonTask(cfg, workspaceId, taskId, reason) {
  try {
    await callTool(cfg, "abandon_task", { workspace_id: workspaceId, task_id: taskId, reason: String(reason ?? "").slice(0, 500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The owner's UI-managed volunteering settings (Account → Agent delegation →
 * Volunteering). Returns { profile_id, settings: [{agent_name, enabled,
 * capabilities}] } or null when the tool/server is unavailable (older deploy,
 * network) — null means "the server has no say", so the local config decides.
 */
export async function getVolunteerSettings(cfg) {
  try {
    const body = await callTool(cfg, "get_volunteer_settings", {});
    return { ok: true, value: body && Array.isArray(body.settings) ? body : null };
  } catch (e) {
    if (/unknown tool/i.test(e.message)) return { ok: true, value: null }; // older server: config decides
    return { ok: false, value: null }; // transient failure: caller reuses last-good, NOT config
  }
}

/**
 * Fetch the team memory to inject into a run prompt (recall-injection). Query-first
 * (task title); when nothing matches, fall back to the workspace's top notes (the
 * recall RPC orders goals/decisions/gotchas first) so a run never starts blind.
 * Best-effort: any failure returns [] — memory must never block a run.
 */
export async function recallMemories(cfg, workspaceId, query, limit = 8) {
  try {
    const q = await callTool(cfg, "recall", { workspace_id: workspaceId, query, limit });
    // `conventions` = the workspace's standing rules, carried on every recall
    // (older servers just don't send the field — degrade to []).
    if ((q.memories ?? []).length > 0) return { memories: q.memories, conventions: q.conventions ?? [] };
    const top = await callTool(cfg, "recall", { workspace_id: workspaceId, limit });
    return { memories: top.memories ?? [], conventions: top.conventions ?? q.conventions ?? [] };
  } catch {
    return { memories: [], conventions: [] };
  }
}

/**
 * Proactive cross-workspace recall — proven knowledge from the member's OTHER projects,
 * so a playbook written elsewhere surfaces here without being pointed at it. Best-effort;
 * [] on any failure (older server without the tool, network) so it never blocks a run.
 */
export async function recallAcrossWorkspaces(cfg, query, excludeWorkspaceId, limit = 3) {
  try {
    const r = await callTool(cfg, "recall_across_workspaces", { query, exclude_workspace_id: excludeWorkspaceId, limit });
    return r.memories ?? [];
  } catch {
    return [];
  }
}

// ── HARDWARE GRANTS (0069) — the host side ───────────────────────────────────
// These are plain REST, not MCP tools: they are the HOST's channel, and the host
// is not an agent here — it is a machine executing calls its owner invited in. A
// server that predates grants 404s, which every caller treats as "not hosting".

/** Pending calls (and the live grants they belong to) for THIS Bridge's token. */
/** `?agents=Claude,Gemini,Chef` — what this Bridge manages, so the server can say
 *  "your Bridge is running but doesn't run X" instead of "start a Bridge". */
export function agentsQuery(cfg, plan = planParam) {
  const names = (cfg?.agents ?? []).filter((a) => a && a.enabled !== false && a.name).map((a) => String(a.name));
  const parts = [];
  if (names.length) parts.push(`agents=${encodeURIComponent(names.join(","))}`);
  // `plan=…` — the member's latest per-vendor plan windows, as their own CLIs
  // reported them to this Bridge (bridge/plan.mjs). Rides the same heartbeat.
  const p = typeof plan === "function" ? plan() : "";
  if (p) parts.push(p);
  // `signed_out=…` — which of those agents' CLIs cannot run right now (0100).
  const so = signedOutParam();
  if (so) parts.push(so);
  return parts.length ? `?${parts.join("&")}` : "";
}

export async function fetchHands(cfg) {
  const res = await fetch(`${cfg.cookbookUrl}/api/bridge/hands${agentsQuery(cfg)}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (res.status === 404) return { supported: false, calls: [], grants: [] };
  if (!res.ok) throw new Error(`hands ${res.status}`);
  const j = await res.json().catch(() => ({}));
  return { supported: true, calls: j.calls ?? [], grants: j.grants ?? [], awaiting: j.awaiting ?? [] };
}

/** Claim one call before running it. The server CASes on status, so two Bridges on
 *  the same token (or a re-delivered push frame) can never double-execute. */
export async function claimHandsCall(cfg, callId) {
  const res = await fetch(`${cfg.cookbookUrl}/api/bridge/hands`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ call_id: callId }),
  });
  return res.ok;
}

/** Post the (already-redacted) outcome. The server redacts again before storing. */
export async function reportHandsResult(cfg, callId, result) {
  const res = await fetch(`${cfg.cookbookUrl}/api/bridge/hands/${encodeURIComponent(callId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: result.status, output: result.output, error: result.error }),
  });
  return res.ok;
}
