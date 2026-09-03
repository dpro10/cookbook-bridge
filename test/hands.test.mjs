// Hermetic tests for round 4 of hands (bridge/hands.mjs): plans and pre-flight.
// No network, no real agents; the filesystem cases run in a throwaway home.
//   node --test bridge/test/hands.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  planHash, validatePlan, executePlan, executeCall, authorizeCall, serveCalls, describeCall,
  collectPreflight, runPreflight, grantsNeedingPreflight, PREFLIGHT_PARTS,
  capOutput, MAX_UPLOAD_BYTES, PLAN_MAX_STEPS, META_VERBS, VERB_NAMES, VERB_RISK, LOCAL_CEILING,
} from "../hands.mjs";

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "hands-r4-"));

/** A fix-preset shaped scope: reads auto, every change waits for a click. */
const fixScope = {
  verbs: ["doctor", "env", "read_file", "list_dir", "write_file", "restore_backup", "run", "open_url", "plan"],
  run_allow: ["node_version", "cli_versions", "clear_needs_auth_cache", "npm_install_global"],
  setup_files: true,
  folders: [],
  auto: { read: true, write: "ask", install: "ask", login: "ask" },
};

const plan = (steps, extra = {}) => ({
  id: "call-1", grant_id: "grant-1", verb: "plan", status: "approved", scope: fixScope,
  args: { why: "reconnect Claude to Cookbook", steps },
  plan_hash: planHash(steps),
  ...extra,
});

/** An executor that never touches the machine: `fail` is the set of step indexes that fail. */
function fakeExecutor({ fail = new Set(), seen = [] } = {}) {
  return async (call, ctx) => {
    seen.push({ verb: call.verb, args: call.args, status: call.status, approvedByPlan: ctx.approvedByPlan });
    const i = seen.length - 1;
    if (fail.has(i)) return { status: "failed", output: null, error: `step ${i} broke` };
    return { status: "done", output: { ran: call.verb }, error: null };
  };
}

test("plan hash: sha256 of the steps exactly as sent; anything else is a mismatch", () => {
  const steps = [{ verb: "env", args: {} }, { verb: "run", args: { template: "node_version" } }];
  assert.equal(planHash(steps), createHash("sha256").update(JSON.stringify(steps)).digest("hex"));
  assert.equal(validatePlan(plan(steps)).ok, true);
  // a step appended after the click
  const grown = plan([...steps, { verb: "run", args: { template: "clear_needs_auth_cache" } }], { plan_hash: planHash(steps) });
  assert.equal(validatePlan(grown).error, "plan hash mismatch");
  // a reordered list is a different plan
  assert.equal(validatePlan(plan(steps, { plan_hash: planHash([steps[1], steps[0]]) })).error, "plan hash mismatch");
  // no hash at all is a mismatch too
  assert.equal(validatePlan(plan(steps, { plan_hash: undefined })).error, "plan hash mismatch");
  // shape
  assert.equal(validatePlan(plan([])).ok, false);
  assert.equal(validatePlan(plan([{ args: {} }])).ok, false);
  assert.equal(validatePlan(plan([{ verb: "env", args: "nope" }])).ok, false);
  const many = Array.from({ length: PLAN_MAX_STEPS + 1 }, () => ({ verb: "env" }));
  assert.match(validatePlan(plan(many)).error, /at most/);
});

test("nested plan or preflight steps are refused, at validation and at the wall", () => {
  assert.deepEqual([...META_VERBS], ["plan", "preflight"]);
  for (const verb of META_VERBS) {
    const r = validatePlan(plan([{ verb: "env" }, { verb, args: {} }]));
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(`Step 2 is '${verb}'`));
  }
  // the wall alone: a plan row cannot be a step of a plan
  assert.equal(authorizeCall({ verb: "plan", status: "approved", args: {} }, fixScope, { approvedByPlan: true }).ok, false);
  // and a queued preflight from the server is never executed
  assert.equal(authorizeCall({ verb: "preflight", status: "queued", args: {} }, fixScope).ok, false);
  assert.equal(authorizeCall({ verb: "preflight", status: "approved", args: {} }, fixScope).ok, false);
});

test("a plan runs its steps in order and stops at the first failure with stopped_at", async () => {
  const steps = [{ verb: "env" }, { verb: "run", args: { template: "clear_needs_auth_cache" } }, { verb: "doctor" }];
  const seen = [];
  const lines = [];
  const r = await executePlan(plan(steps), { home: tmpHome(), executeStep: fakeExecutor({ fail: new Set([1]), seen }), log: (l) => lines.push(l) });
  assert.equal(r.status, "failed");
  assert.equal(r.output.stopped_at, 1);
  assert.equal(r.output.steps.length, 2, "the third step never ran");
  assert.equal(seen.length, 2);
  assert.deepEqual(r.output.steps.map((s) => s.ok), [true, false]);
  assert.equal(r.output.steps[0].verb, "env");
  assert.deepEqual(r.output.steps[0].output, { ran: "env" });
  assert.equal(r.output.steps[1].template, "clear_needs_auth_cache");
  assert.equal(r.output.steps[1].error, "step 1 broke");
  assert.ok(r.output.steps.every((s) => typeof s.duration_ms === "number" && s.duration_ms >= 0));
  assert.match(r.error, /Stopped at step 2 of 3 \(clear_needs_auth_cache\)/);
  assert.match(lines[0], /^◇ plan step 1\/3: env \.\.\. ok \(\d+\.\ds\)$/);
  assert.match(lines[1], /^◇ plan step 2\/3: clear_needs_auth_cache \.\.\. failed: step 1 broke \(\d+\.\ds\)$/);

  // all green: no stopped_at at all
  const ok = await executePlan(plan(steps), { home: tmpHome(), executeStep: fakeExecutor() });
  assert.equal(ok.status, "done");
  assert.equal(ok.error, null);
  assert.equal("stopped_at" in ok.output, false);
  assert.equal(ok.output.steps.length, 3);
});

test("a hash mismatch refuses the whole plan before any step runs", async () => {
  const steps = [{ verb: "env" }];
  const seen = [];
  const r = await executePlan(plan(steps, { plan_hash: "0".repeat(64) }), { home: tmpHome(), executeStep: fakeExecutor({ seen }) });
  assert.equal(r.status, "denied");
  assert.equal(r.error, "plan hash mismatch");
  assert.equal(r.output, null);
  assert.equal(seen.length, 0);
});

test("approvedByPlan: the plan's click is the click for its steps, and only when the plan row is approved", async () => {
  const steps = [{ verb: "run", args: { template: "clear_needs_auth_cache" } }];
  // an unapproved plan never reaches its executor
  const seen = [];
  const queued = await executePlan(plan(steps, { status: "queued" }), { home: tmpHome(), executeStep: fakeExecutor({ seen }) });
  assert.equal(queued.status, "denied");
  assert.match(queued.error, /needs the host's approval/);
  assert.equal(seen.length, 0);
  // an approved plan hands each step approvedByPlan: true and a status that is NOT approved
  const seen2 = [];
  await executePlan(plan(steps), { home: tmpHome(), executeStep: fakeExecutor({ seen: seen2 }) });
  assert.equal(seen2[0].approvedByPlan, true);
  assert.equal(seen2[0].status, "queued");
  // the wall itself: a write-class step is refused without the plan's approval and allowed with it
  const write = { verb: "run", args: { template: "clear_needs_auth_cache" }, status: "queued" };
  assert.equal(authorizeCall(write, fixScope).ok, false);
  assert.equal(authorizeCall(write, fixScope, { approvedByPlan: false }).ok, false);
  assert.equal(authorizeCall(write, fixScope, { approvedByPlan: true }).ok, true);
  // a refused class stays refused, plan or not
  assert.equal(authorizeCall(write, { ...fixScope, auto: { ...fixScope.auto, write: false } }, { approvedByPlan: true }).ok, false);
});

test("through the real executor: a write step lands under the plan's click and is refused as a lone queued call", async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const target = path.join(home, ".claude", "settings.json"); // a setup file: writable through a setup grant
  fs.writeFileSync(target, '{"before":true}');
  const step = { verb: "write_file", args: { path: target, content: '{"after":true}' } };
  const ctx = { home, hostFolders: [], cfg: { cookbookUrl: "https://cookbook.team" } };

  const lone = await executeCall({ ...step, status: "queued", scope: fixScope }, ctx);
  assert.equal(lone.status, "denied");
  assert.equal(fs.readFileSync(target, "utf8"), '{"before":true}');

  const r = await executeCall(plan([{ verb: "env" }, step]), ctx); // executeCall routes a plan to executePlan
  assert.equal(r.status, "done", r.error);
  assert.equal(fs.readFileSync(target, "utf8"), '{"after":true}');
  assert.equal(r.output.steps.length, 2);
  assert.ok(r.output.steps[1].output.backup);
});

test("every step is measured against the ceiling on its own: a forbidden install fails the plan at that index", async () => {
  const home = tmpHome();
  const steps = [{ verb: "env" }, { verb: "run", args: { template: "npm_install_global", params: { pkg: "left-pad" } } }, { verb: "env" }];
  const r = await executeCall(plan(steps), { home, hostFolders: [] });
  assert.equal(r.status, "failed");
  assert.equal(r.output.stopped_at, 1);
  assert.equal(r.output.steps[0].ok, true);
  assert.match(r.output.steps[1].error, /Only 'cookbook-bridge' may be installed/);
  // and a template the ceiling has never heard of
  const r2 = await executeCall(plan([{ verb: "run", args: { template: "format_disk" } }]), { home, hostFolders: [] });
  assert.equal(r2.status, "failed");
  assert.equal(r2.output.stopped_at, 0);
  // and a verb outside the grant
  const r3 = await executeCall(plan([{ verb: "open_url", args: { url: "https://claude.ai" } }], { scope: { ...fixScope, verbs: ["env", "plan"] } }), { home, hostFolders: [] });
  assert.equal(r3.status, "failed");
  assert.match(r3.output.steps[0].error, /doesn't allow 'open_url'/);
});

test("serveCalls carries a plan like any other call: claim, run, report", async () => {
  const reported = [];
  const lines = [];
  const call = plan([{ verb: "env" }, { verb: "doctor" }]);
  const served = await serveCalls([call], {
    home: tmpHome(),
    claim: async () => true,
    report: async (id, r) => reported.push({ id, r }),
    executeStep: fakeExecutor(),
    log: (l) => lines.push(l),
    visitorLabel: () => "Chef",
  });
  assert.deepEqual(served, [{ id: "call-1", status: "done" }]);
  assert.equal(reported[0].id, "call-1");
  assert.equal(reported[0].r.output.steps.length, 2);
  assert.match(lines[0], /Chef → plan: reconnect Claude to Cookbook \(2 steps: env, doctor\)/);
  assert.equal(describeCall({ verb: "preflight" }).startsWith("pre-flight"), true);
});

test("pre-flight: the four parts, the doctor rows as {label, ok, detail}, and no token survives", async () => {
  const home = tmpHome();
  const cfgPath = path.join(home, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    cookbookUrl: "https://cookbook.team",
    token: "cbk_mcp_HOSTSECRET0001",
    agents: [{ name: "Claude", command: "claude", token: "cbk_mcp_AGENTSECRET0002", enabled: true }],
    hosting: { folders: [path.join(home, "projects")] },
  }));
  const parts = {
    ...PREFLIGHT_PARTS,
    cli_versions: async () => ({ clis: [{ cli: "claude", installed: true, version: "2.0.1" }, { cli: "codex", installed: false }] }),
  };
  const doctor = async () => ({
    rows: [
      { level: "ok", label: "Node v22" },
      { level: "bad", label: "Claude: no Cookbook MCP", fix: "run claude mcp add with Bearer cbk_mcp_FIXSECRET0003" },
      { level: "warn", label: "Config home is mode 755", fix: `chmod 700 ${home}` },
    ],
    fails: 1, warns: 1,
  });
  const out = await collectPreflight({ home, cfgPath, doctor, cfg: { cookbookUrl: "https://cookbook.team", agents: [{ name: "Claude" }] } }, parts);

  assert.deepEqual(Object.keys(out).sort(), ["at", "bridge_config", "cli_versions", "doctor", "env"]);
  assert.equal(out.env.platform, process.platform);
  assert.equal(typeof out.env.logins.claude, "boolean");
  assert.deepEqual(out.env.agents_configured, ["Claude"]);
  assert.deepEqual(out.cli_versions.clis[0], { cli: "claude", installed: true, version: "2.0.1" });
  assert.deepEqual(out.doctor.rows.map((r) => [r.label, r.ok]), [["Node v22", true], ["Claude: no Cookbook MCP", false], ["Config home is mode 755", false]]);
  assert.equal(out.doctor.rows[0].detail, null);
  assert.equal(out.doctor.fails, 1);
  assert.equal(out.doctor.warns, 1);
  // the config's SHAPE survives; its tokens do not
  assert.equal(out.bridge_config.cookbookUrl, "https://cookbook.team");
  assert.equal(out.bridge_config.token, "<present, not sent>");
  assert.equal(out.bridge_config.agents[0].token, "<present, not sent>");
  assert.equal(out.bridge_config.agents[0].name, "Claude");
  assert.match(out.bridge_config.note, /Projected/);
  // and the whole payload is redacted (the doctor's fix text carried a bearer) and home-collapsed
  const json = JSON.stringify(out);
  for (const secret of ["HOSTSECRET0001", "AGENTSECRET0002", "FIXSECRET0003"]) assert.equal(json.includes(secret), false, secret);
  assert.equal(out.doctor.rows[2].detail, "chmod 700 ~");
  assert.equal(json.includes(home), false);
});

test("pre-flight: a part that throws leaves the others intact, and the output is capped", async () => {
  const home = tmpHome();
  const parts = {
    env: async () => { throw new Error("env exploded"); },
    doctor: async () => ({ rows: [] }),
    cli_versions: async () => ({ clis: [] }),
    bridge_config: async () => ({ blob: "x".repeat(MAX_UPLOAD_BYTES + 10) }),
  };
  const out = await collectPreflight({ home }, parts);
  assert.equal(out.truncated, true);
  assert.ok(out.bytes > MAX_UPLOAD_BYTES);
  assert.equal(out.preview.length, MAX_UPLOAD_BYTES);
  const small = await collectPreflight({ home }, { ...parts, bridge_config: async () => ({ ok: true }) });
  assert.deepEqual(small.env, { error: "env exploded" });
  assert.deepEqual(small.doctor, { rows: [] });
  assert.equal(capOutput(null), null);
  assert.deepEqual(capOutput({ a: 1 }), { a: 1 });
});

test("runPreflight opens a host-initiated call and posts the result through it", async () => {
  const home = tmpHome();
  const created = [];
  const reported = [];
  const parts = { env: async () => ({ platform: "test" }), doctor: async () => ({ rows: [] }), cli_versions: async () => ({ clis: [] }), bridge_config: async () => ({}) };
  const r = await runPreflight("grant-9", {
    home, preflightParts: parts,
    create: async (grantId) => { created.push(grantId); return "call-77"; },
    report: async (id, result) => { reported.push({ id, result }); return true; },
  });
  assert.deepEqual(created, ["grant-9"]);
  assert.equal(r.callId, "call-77");
  assert.equal(reported[0].id, "call-77");
  assert.equal(reported[0].result.status, "done");
  assert.equal(reported[0].result.error, null);
  assert.equal(reported[0].result.output.env.platform, "test");
  // a server that opens no row is a failure the caller can count
  await assert.rejects(runPreflight("grant-9", { home, preflightParts: parts, create: async () => null, report: async () => true }), /didn't open/);
  await assert.rejects(runPreflight("grant-9", { home, preflightParts: parts, create: async () => "c", report: async () => false }), /refused/);
});

test("once per grant: persisted grants are skipped, two tries per process, only live grants with a machine", () => {
  const grants = [
    { id: "g-new", status: "active", scope: { verbs: ["env"] } },
    { id: "g-done", status: "active", scope: { verbs: ["env"] } },
    { id: "g-tried", status: "active", scope: { verbs: ["env"] } },
    { id: "g-once", status: "active", scope: { verbs: ["env"] } },
    { id: "g-expired", status: "expired", scope: { verbs: ["env"] } },
    { id: "g-talk", status: "active", conversation_only: true, scope: { verbs: [] } },
    { id: "g-noverbs", status: "active", scope: { verbs: [] } },
    { status: "active" },
  ];
  const preflighted = new Set(["g-done"]);
  const tried = new Map([["g-tried", 2], ["g-once", 1]]);
  assert.deepEqual(grantsNeedingPreflight(grants, { preflighted, tried }), ["g-new", "g-once"]);
  assert.deepEqual(grantsNeedingPreflight(grants, { preflighted, tried, maxAttempts: 1 }), ["g-new"]);
  assert.deepEqual(grantsNeedingPreflight(undefined, { preflighted, tried }), []);
  // the persisted set wins over everything: the same grant seen again on every poll is never re-flown
  preflighted.add("g-new");
  assert.deepEqual(grantsNeedingPreflight(grants, { preflighted, tried }), ["g-once"]);
});

test("the tables know both verbs; only plan is inside the ceiling", () => {
  assert.ok(VERB_NAMES.includes("plan") && VERB_NAMES.includes("preflight"));
  assert.equal(VERB_RISK.plan, "write");
  assert.equal(VERB_RISK.preflight, "read");
  assert.ok(LOCAL_CEILING.verbs.includes("plan"));
  assert.ok(!LOCAL_CEILING.verbs.includes("preflight"));
});
