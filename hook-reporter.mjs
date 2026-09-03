#!/usr/bin/env node
/**
 * THE HOOK REPORTER — the only thing Claude Code's hooks run (0085).
 *
 * Reads the hook payload from stdin, POSTs it to the local Bridge, exits 0.
 * ALWAYS exits 0, fast: the mirror must never block or break a terminal session.
 * Bridge not running → local.json missing/stale → silent no-op. Standalone by
 * design (no imports from the Bridge runtime) so the copy installed at
 * ~/.cookbook/hook-reporter.mjs keeps working across Bridge updates.
 *
 * argv[2] = path to the Bridge's local.json (written fresh each Bridge start:
 * { port, token, pid }).
 */
import fs from "node:fs";

const die = () => process.exit(0);
setTimeout(die, 900).unref(); // hard ceiling: never hold a hook open

try {
  const localJsonPath = process.argv[2];
  if (!localJsonPath) die();
  const j = JSON.parse(fs.readFileSync(localJsonPath, "utf8"));
  const port = j.port ?? j.localPort;
  const token = j.token ?? j.localToken;
  if (!port || !token) die();

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { buf += d; if (buf.length > 256 * 1024) die(); });
  process.stdin.on("end", () => {
    let payload;
    try { payload = JSON.parse(buf); } catch { die(); }
    fetch(`http://127.0.0.1:${port}/session-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": String(token) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(700),
    }).then(die, die);
  });
  process.stdin.on("error", die);
} catch {
  die();
}
