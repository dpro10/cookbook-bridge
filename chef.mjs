/**
 * LOCAL-FIRST CHEF (round two).
 *
 * Chef used to be exactly one agent on the founder's Mac: a "Chef" entry in dp's
 * config, running claude with the persona file appended. Every outage on that one
 * machine took Chef offline for everyone, every turn spent the founder's plan, and
 * Chef could never see the asker's real workspaces (the identity trap).
 *
 * Now, when the person asking has a live Bridge that runs Claude, the SERVER scopes
 * the support task to THEM (assigned_to "Chef", assigned_to_profile = the asker), and
 * their own Bridge synthesizes a Chef from their own Claude agent: same binary, same
 * login, same plan, plus the persona shipped next to this file. Nothing to configure.
 * The founder-Mac Chef remains the fallback for people with no Bridge yet.
 *
 * Pure where possible: nothing here touches the filesystem on import, and the one
 * existence check is injectable so the tests never need a real persona file.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The persona file shipped with the Bridge runtime, next to bridge.mjs. */
export const CHEF_PERSONA_FILE = "chef-persona.md";

/** The synthesized agent's name and the assignee it answers to. */
export const CHEF_NAME = "Chef";

/** The model a synthesized Chef runs on when the base command names none. */
export const CHEF_DEFAULT_MODEL = "sonnet";

const DEFAULT_ALLOWED_TOOLS = "mcp__cookbook__*";

/** Where the persona lives for THIS install: next to the module that asked. */
export function personaPathNextTo(moduleUrl = import.meta.url) {
  return path.join(path.dirname(fileURLToPath(moduleUrl)), CHEF_PERSONA_FILE);
}

/** Is this configured agent a plain claude CLI runner we can wear the persona on? */
export function isClaudeAgent(agent) {
  if (!agent || agent.enabled === false) return false;
  if (agent.runner && agent.runner !== "cli" && agent.runner !== "claude") return false;
  if (!Array.isArray(agent.command) || agent.command.length === 0) return false;
  const bin = path.basename(String(agent.command[0])).toLowerCase();
  return bin === "claude" || bin === "claude.exe";
}

/** Does a configured agent answer to this assignee? Mirrors bridge.mjs agentFor. */
export function matchesAssignee(agent, assignedTo) {
  if (!agent || agent.enabled === false) return false;
  const a = String(assignedTo ?? "").toLowerCase();
  if (!a) return false;
  return (agent.match ?? [agent.name]).some((m) => a.includes(String(m).toLowerCase()));
}

/**
 * Synthesize the local Chef from the first enabled claude agent, or null when the
 * Bridge manages no claude at all (nothing to wear the persona on).
 *
 * The command is the base command plus `--append-system-prompt-file <persona>`, and
 * `--model sonnet` unless the base already pins a model. The base's allowedTools
 * stands as-is (that prefix is the person's own MCP wiring, verified by doctor); a
 * base with none gets mcp__cookbook__* so Chef can reach the Cookbook tools at all.
 * Identity fields (token, cookbookUrl, approvalRelay) ride along so the run pins to
 * exactly the same Cookbook connection the base Claude uses.
 */
export function chefLocalAgent(cfg, agents, personaPath) {
  const pool = Array.isArray(agents) ? agents : (cfg?.agents ?? []);
  const base = pool.find(isClaudeAgent);
  if (!base) return null;
  const persona = personaPath || personaPathNextTo();
  const command = [...base.command];
  if (!command.includes("--allowedTools")) command.push("--allowedTools", DEFAULT_ALLOWED_TOOLS);
  if (!command.includes("--model")) command.push("--model", CHEF_DEFAULT_MODEL);
  if (!command.includes("--append-system-prompt-file")) command.push("--append-system-prompt-file", persona);
  return {
    name: CHEF_NAME,
    match: ["chef"],
    enabled: true,
    command,
    readOnly: false,
    local: false,
    volunteer: false,
    synthesized: true,
    base: base.name,
    capabilities: "Cookbook setup and troubleshooting on this machine: connecting agents, MCP, the Bridge, and reading this setup under a hands grant.",
    ...(base.token ? { token: base.token } : {}),
    ...(base.cookbookUrl ? { cookbookUrl: base.cookbookUrl } : {}),
    ...(base.approvalRelay ? { approvalRelay: base.approvalRelay } : {}),
  };
}

/**
 * Is this pulled work item a support conversation addressed to Chef?
 *
 * The server sets assigned_to "Chef" only on support-workspace tasks, so the name is
 * trustworthy on its own. When the item also carries workspace_kind (listOpenWork
 * may shape it in), it must say "support"; any other kind is someone's ordinary
 * task that happens to mention Chef, and the Bridge leaves it alone.
 */
export function wantsLocalChef(task) {
  if (!task) return false;
  const to = String(task.assigned_to ?? "").trim().toLowerCase();
  if (to !== CHEF_NAME.toLowerCase()) return false;
  const kind = task.workspace_kind ?? task.workspace?.kind;
  if (kind === undefined || kind === null) return true;
  return String(kind).toLowerCase() === "support";
}

// One synthesized agent per (persona path, base command): bridge.mjs keys plan
// holds and warm pools by agent.name, and a fresh object every poll would still be
// fine, but a stable one keeps the logs and any identity-keyed maps honest.
const synthesized = new Map();

/**
 * The agent that runs this task, for bridge.mjs dispatch: a configured agent that
 * matches the assignee wins; otherwise, when the task wants Chef and the persona is
 * shipped next to the Bridge, the synthesized local Chef; otherwise null (nothing
 * on this Bridge handles that assignee, exactly as before).
 *
 * `opts.personaPath` and `opts.exists` exist for tests; production callers pass
 * neither.
 */
export function resolveAgentForTask(agents, task, cfg, opts = {}) {
  const pool = Array.isArray(agents) ? agents : (cfg?.agents ?? []);
  const configured = pool.find((a) => matchesAssignee(a, task?.assigned_to)) ?? null;
  if (configured) return configured;
  if (!wantsLocalChef(task)) return null;
  const personaPath = opts.personaPath ?? personaPathNextTo();
  const exists = opts.exists ?? existsSync;
  if (!exists(personaPath)) return null;
  const base = pool.find(isClaudeAgent);
  if (!base) return null;
  const key = `${personaPath}::${JSON.stringify(base.command)}::${base.token ?? ""}`;
  let agent = synthesized.get(key);
  if (!agent) {
    agent = chefLocalAgent(cfg, pool, personaPath);
    if (agent) synthesized.set(key, agent);
  }
  return agent ?? null;
}
