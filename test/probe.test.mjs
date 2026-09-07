// Hermetic tests for the AI-visibility probe on the synthesis lane (0.1.14).
//   node --test bridge/test/probe.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  probeNeedsScratchCwd, argsForKind, kindOf, validateJob, describeJob, timeoutForKind, variantOf, runSynthesisJobs, resetSynthesisQueue,
  KINDS, PROBE_TIMEOUT_MS, PROBE_VARIANTS } from "../synthesis.mjs";

test("probe argv: the model variant has no tools, the search variant has WebSearch only (and it is allowed)", () => {
  const m = argsForKind("probe", { model: "sonnet", variant: "model" });
  assert.ok(m.includes("-p") && m.includes("--strict-mcp-config"));
  assert.equal(m[m.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.equal(m[m.indexOf("--tools") + 1], "");
  assert.ok(!m.includes("--allowedTools"), "nothing to allow when there are no tools");
  assert.equal(m[m.indexOf("--model") + 1], "sonnet");

  const s = argsForKind("probe", { model: "sonnet", variant: "search" });
  assert.equal(s[s.indexOf("--tools") + 1], "WebSearch");
  assert.equal(s[s.indexOf("--allowedTools") + 1], "WebSearch", "print mode denies a tool that is not allowed up front");
  assert.equal(s[s.indexOf("--model") + 1], "sonnet");
  assert.ok(s.includes("--strict-mcp-config"));
  assert.ok(!s.includes("Read") && !s.includes("Bash") && !s.includes("WebFetch"), "search means WebSearch and nothing else");

  const fallback = argsForKind("probe", { variant: "search" });
  assert.ok(!fallback.includes("--model") && fallback[fallback.indexOf("--tools") + 1] === "WebSearch", "the no-alias retry keeps the variant");
  assert.equal(argsForKind("probe", { variant: "bogus" })[argsForKind("probe", { variant: "bogus" }).indexOf("--tools") + 1], "", "an unknown variant never gets tools");
});

test("probe is a known kind with its own timeout and the two variants", () => {
  assert.ok(KINDS.includes("probe"));
  assert.equal(kindOf({ kind: "probe" }), "probe");
  assert.equal(timeoutForKind("probe"), PROBE_TIMEOUT_MS);
  assert.equal(PROBE_TIMEOUT_MS, 120_000);
  assert.deepEqual(PROBE_VARIANTS, ["model", "search"]);
  assert.equal(variantOf({ variant: "model" }), "model");
  assert.equal(variantOf({ variant: "search" }), "search");
  assert.equal(variantOf({ variant: "both" }), null);
  assert.equal(variantOf({}), null);
});

test("validateJob accepts a probe with a variant and refuses one without", () => {
  assert.equal(validateJob({ id: "a", prompt: "p", kind: "probe", model: "sonnet", variant: "model" }), null);
  assert.equal(validateJob({ id: "a", prompt: "p", kind: "probe", model: "sonnet", variant: "search" }), null);
  assert.match(validateJob({ id: "a", prompt: "p", kind: "probe" }), /no variant/);
  assert.match(validateJob({ id: "a", prompt: "p", kind: "probe", variant: "all" }), /no variant/);
  assert.match(validateJob({ id: "a", prompt: "", kind: "probe", variant: "model" }), /no prompt/);
});

test("probe log label names group, number and variant, never the prompt", () => {
  assert.equal(describeJob({ kind: "probe", group: "A", prompt_id: 3, variant: "search", prompt: "SECRET QUESTION" }), "probe: A #3 (search)");
  assert.equal(describeJob({ kind: "probe", variant: "model" }), "probe: ? #? (model)");
});

test("a probe run announces itself as probe, passes the variant through, and reports the text", async () => {
  resetSynthesisQueue();
  const lines = [];
  const reports = [];
  const seen = [];
  await runSynthesisJobs(
    { cookbookUrl: "https://x", token: "t" },
    [{ id: "p1", prompt: "Which tool?", kind: "probe", model: "sonnet", variant: "search", group: "B", prompt_id: 12 }],
    (l) => lines.push(l),
    {
      run: async (job) => { seen.push(job.variant); return { ok: true, text: "Cookbook, then Mem0." }; },
      report: async (_cfg, id, payload) => { reports.push({ id, payload }); return true; },
    },
  );
  assert.deepEqual(seen, ["search"]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].payload.result, "Cookbook, then Mem0.");
  assert.ok(lines.some((l) => l === "◇ probe: B #12 (search) on your subscription"), lines.join("\n"));
  assert.ok(lines.some((l) => /^◇ probe: B #12 \(search\) done in \d+s$/.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("Which tool?")), "the prompt never reaches the log");
});

test("a probe without a variant is refused before anything runs", async () => {
  resetSynthesisQueue();
  const reports = [];
  let ran = 0;
  await runSynthesisJobs(
    { cookbookUrl: "https://x", token: "t" },
    [{ id: "p2", prompt: "Which tool?", kind: "probe", model: "sonnet" }],
    null,
    { run: async () => { ran++; return { ok: true, text: "x" }; }, report: async (_c, id, payload) => { reports.push({ id, payload }); return true; } },
  );
  assert.equal(ran, 0);
  assert.match(reports[0].payload.error, /no variant/);
});

test("a probe runs in a scratch cwd unless one was given; other kinds keep the Bridge cwd", () => {
  assert.equal(probeNeedsScratchCwd("probe", undefined), true);
  assert.equal(probeNeedsScratchCwd("probe", "/tmp/given"), false);
  assert.equal(probeNeedsScratchCwd("summary", undefined), false);
});
