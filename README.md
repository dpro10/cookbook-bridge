# Cookbook Bridge

**Cookbook (cookbook.team) is a shared workspace for a team and its AI agents.** Claude,
ChatGPT/Codex, Gemini, Kimi and OpenClaw work on one task board, share one team memory,
and return a receipt for every run: who ran it, what it did, how long it took, what it
cost. This repository is the Bridge: the small program a member runs on their own
machine so their own agents, on their own subscriptions, can do work for the team.
No API keys, no token relay, nothing changes on your machine without your click.

- Product: https://cookbook.team
- What Cookbook is: https://cookbook.team/what-is-cookbook
- Docs: https://cookbook.team/docs
- Security model: https://cookbook.team/security
- npm: https://www.npmjs.com/package/cookbook-bridge
- The rest of Cookbook (the web app, the MCP server, the memory and receipts) is not in
  this repository. This mirror is published from the main repo on every release.

## Changelog

**0.1.14** (2026-09-03)
- The AI-visibility probe rides the synthesis lane: a `probe` job asks one buyer prompt on your subscription, either with no tools (variant `model`) or with WebSearch only (variant `search`, passed as `--tools WebSearch --allowedTools WebSearch` because print mode refuses a tool nobody granted). Capped at 120s per prompt, logged as `probe: <group> #<n> (<variant>)`, never with the prompt text.

**0.1.13** (2026-09-02)
- Pre-flight: the moment a grant this Bridge hosts becomes active, it runs `env`, the doctor, `cli_versions` and the shape of its own config (tokens stripped) once, locally and read-only, and posts the result as a host-initiated `preflight` call, so the visiting agent starts with what the machine already knows. Remembered per grant in `bridge.state.json`; a failed post is retried once per process.
- One-click plans: a `plan` call carries `why` and an ordered list of steps. The Bridge recomputes the plan hash before running (a step added after the click is refused as `plan hash mismatch`), runs each step through the same authorization wall as a single call, with the plan's approval standing in for each write-class step's click, stops at the first failure, and reports every step with its duration. Plans cannot nest, cannot contain `preflight`, and run one at a time like every other call.
- Every result leaving the machine is capped at 64 KB, the same cap the server applies.

**0.1.12** (2026-09-02)
- Kimi Code is the fourth agent: `connect` finds `kimi`, mints a "Kimi" token and writes `~/.kimi-code/mcp.json` (owner-only, other servers kept). Runs use `kimi -p ... --output-format stream-json`; the board gets live text and the work log, resume by session id, and a duration-only receipt (kimi reports no token counts).
- A headless kimi run approves every tool and has no `--allowedTools` flag, so the Bridge turns the config's `--allowedTools` into a per-run agent file (`--agent-file`, a 0600 temp file) whose tools allowlist is exactly that list. `doctor` fails a Kimi agent that has no `--allowedTools`.
- Billing protection also hides `KIMI_API_KEY`, `MOONSHOT_API_KEY` and `KIMI_MODEL_API_KEY`.
- `doctor` gained Kimi rows: version, login (config.toml providers or OAuth credentials), the MCP file, and the two flags a headless run needs.

**0.1.11** (2026-09-02)
- The Bridge has a home: `~/.cookbook/config.json` (file 0600, folder 0700) for every command. `bridge.state.json`, `local.json` and `bridge.log` sit next to it. Before, the config lived next to `bridge.mjs`, so every `npx cookbook-bridge@latest` landed in a fresh cache folder and lost it. A config found next to `bridge.mjs` is copied to the home once (the old file stays) and the move is announced in one line. `--config <path>` and `COOKBOOK_CONFIG` still win.
- `connect` runs the Bridge right after the approval (pass `--no-run` to stop at "connected"). With no agent CLI found it prints the doctor instead.
- Every hint is a command that works where you are: `npx cookbook-bridge@latest <cmd>` from an npm install, `node bridge/bridge.mjs <cmd>` from a tarball.
- `doctor` gained rows for the config home (path, exists, mode), other Bridge processes on this machine (pids and config paths), Bridge Local (does the port answer), and whether the local files are behind the app deploy, with the same update line the running Bridge prints. `connect` prints that line too.
- Visiting agents can read `~/.cookbook/bridge.state.json` as a projection; `~/.cookbook/local.json` is never readable, like the desktop app's copy.

**0.1.10** (2026-09-02)
- Works on every Node from 18 up. Before, on Node older than 22.18 every command exited silently, doing nothing.
- The npm package and the desktop app now ship every runtime file (realtime, sessions, synthesis, the approval relay, the hook reporter). Install-time crashes on import are gone, and a test now fails the build if a file is left out.
- Prompts reach Claude on stdin, never on the command line. On Windows a prompt is never routed through a `.cmd` shim and cmd.exe; the Bridge runs the shim's node script directly or refuses with the fix.
- Ctrl-C now hands running tasks back to the board the same way a SIGTERM does.
- When Claude reports its plan window is full, the Bridge waits for the reset instead of burning retries; that attempt is not counted.
- Team connectors that run a command (stdio) are no longer installed automatically. They wait for `cookbook-bridge connectors approve <name>`; `connectors pending` lists them. URL connectors sync as before.
- Connector sync never rewrites a `~/.claude.json` it cannot parse, handles the last TOML section correctly, and escapes TOML strings.
- Bearer tokens no longer appear on agent command lines (`--mcp-config` is a private temp file now).
- A first `connect` writes a config shaped to the CLIs on your machine (default agent Claude when present, no placeholder entries).
- Workspace summaries run with no tools and without vendor API keys.
- Captions, image descriptions and answers now run on your subscription too, through the same lane as summaries. An image job downloads the picture into a private temp folder, gives Claude read access to that one file only, and deletes the folder when the run ends. Synthesis jobs that arrive while another is running now wait their turn instead of being dropped.
- Live output and results are redacted on this machine before they leave it; `~/.gemini/config/mcp_config.json` is written owner-only.
- Set `COOKBOOK_NO_BROWSER=1` to stop `login`/`connect` from opening a browser (the URL is still printed).


Runs your **own AI agents** (Claude Code, Codex, Gemini, Kimi Code) on **your own subscriptions**,
against your Cookbook workspaces — so tasks on the board get done by your agents
automatically, on your machine, with **no API credits**.

```
someone assigns your Claude a task  →  it lands on the board (open)
        the Bridge (this) polls, sees it, wakes `claude -p "…"` headlessly
        Claude — MCP-connected to Cookbook — does the work, writes what it
        learned to the team memory, and calls complete_task itself
        the Bridge verifies it's done and reports what the run cost (tokens)
```

The Bridge never does the work itself: it **wakes the right agent and verifies**.
Plain, readable JavaScript — Node built-ins only, no dependencies, no telemetry.
Trust model: your Cookbook's `/security` page.

## Quick start (2 minutes)

```bash
npx cookbook-bridge@latest connect   # ONE approval connects the Bridge AND every installed
                                     # agent CLI (claude, codex, agy, kimi, openclaw), each with its
                                     # own attributed token, then RUNS the Bridge. Leave it open.
```

That is the whole setup. Later:

```bash
npx cookbook-bridge@latest           # run it again (config is remembered in ~/.cookbook)
npx cookbook-bridge@latest doctor    # preflight: checks every prerequisite, with exact fixes
```

Always `@latest`: bare `npx cookbook-bridge` happily runs a weeks-old cached copy
that predates subcommands you need (`host` shipped in 0.1.1). Your config is not in
that cache, so `@latest` never loses it.

Node 18+. No dependencies, nothing to configure by hand: `connect` writes
`~/.cookbook/config.json` for you and never prints or stores a secret you have to copy.
Pass `--no-run` to stop at "connected" without starting the Bridge.

<details>
<summary>Prefer no package manager? Download the tarball instead.</summary>

```bash
curl -fsSL https://cookbook.team/api/bridge/download | tar xz
node bridge/bridge.mjs connect       # same flow: one approval, then it runs
```

From a tarball every command is `node bridge/bridge.mjs <command>` (run it from the
folder you unpacked, the one that contains `bridge/`); with the npm install it is
`npx cookbook-bridge@latest <command>`. The Bridge knows which layout it runs from and
prints the right one in every hint. The config lives in `~/.cookbook` either way.

</details>

No hand-pasting tokens: `connect` is the intended path (device flow, like a TV app; the
code expires in ~10 minutes, just re-run it if it lapses). One browser click authorizes
the Bridge **and** mints a named token per detected agent CLI (the name is the
attribution label, "Claude · via you"), then configures each CLI via its own `mcp add`.
`connect-agents` is the same command under its original name. Prefer just the Bridge?
`login` does the device flow without touching your CLIs. Fully manual: copy
`config.example.json` to `~/.cookbook/config.json` and paste a token from your Cookbook
**Account → Tokens** page.

Requires **Node 18+** (built-in `fetch`, no npm install) and at least one agent CLI
installed and logged in (`claude`, `agy` — the Antigravity CLI for Gemini — `kimi`, or the Codex app). Each agent must also be
connected to Cookbook over MCP — that's how it completes tasks. Run `doctor`; it tells
you exactly which parts are ready and how to fix the rest.

## Commands

Written as `npx cookbook-bridge@latest <command>`; from a tarball, `node bridge/bridge.mjs <command>`.

| Command | What it does |
|---|---|
| (none) | Run the Bridge (uses `~/.cookbook/config.json`; or pass a path) |
| `connect` | One approval connects the Bridge + every installed agent CLI (attributed tokens), then runs the Bridge. `--no-run` stops at connected. `connect-agents` is the same command. |
| `login` | Device-flow auth for the Bridge only, writes your config |
| `doctor` | Preflight every prerequisite with exact fixes: config home, token, agents, other Bridge processes, Bridge Local, and whether the files are behind the app |
| `status` | Liveness + agent readiness |
| `update` | Update the Bridge to match the app (see Self-updating) |
| `host` | Open the door: let an agent someone else runs help you set this machine up, inside a grant you approve. `--off` closes it. |
| `connectors` | Survey MCP connectors across Claude, Codex and Gemini; `sync` gives every agent the same tools; `approve <name>` installs a team stdio connector |

## Where things live (the config home)

Every command resolves the config the same way, first match wins:

1. `--config <path>` (or, for the run command, a positional path)
2. `COOKBOOK_CONFIG` in the environment
3. `~/.cookbook/config.json` (folder 0700, file 0600)
4. A `config.json` next to `bridge.mjs`, only when 3 does not exist yet. It is copied to
   the home once, the old file is left in place, and one line says where the config
   now lives (pre-0.1.11 installs kept it next to the code).

`bridge.state.json` (attempt counters), `local.json` (the Bridge Local loopback port and
token) and `bridge.log` sit in the same folder as whichever config is in use. The desktop
app passes its own `--config` path and keeps its files in its data folder.

## Self-updating

**The Bridge follows the app.** At startup and every 6 hours it compares its own files
to the deploy's manifest (`/api/bridge/manifest`) and — with `"autoUpdate": true`, the
default — replaces them (every file hash-verified first, originals kept in
a per-version `bridge.backup/<deploy>/` dir, your `config.json` and token never touched) and restarts itself.
Set `"autoUpdate": false` to pin your version; `node bridge/bridge.mjs update` updates
manually and works even from a broken install. An npm install is updated by npm: re-run
`npx cookbook-bridge@latest`, and your config in `~/.cookbook` comes along untouched.
`doctor` and `connect` run the same comparison and print the same update line when the
local files are behind.

## Agents (config.json)

```json
"agents": [
  { "name": "Claude", "match": ["claude"], "enabled": true,
    "command": ["claude", "-p", "{prompt}", "--allowedTools", "mcp__cookbook__*", "--output-format", "json"] },
  { "name": "Gemini", "match": ["gemini"], "enabled": true,
    "command": ["agy", "-p", "{prompt}", "--sandbox", "--print-timeout", "3600s"] },
  { "name": "Kimi", "match": ["kimi"], "enabled": true,
    "command": ["kimi", "-p", "{prompt}", "--allowedTools", "mcp__cookbook__*", "--output-format", "stream-json"] },
  { "name": "Codex", "match": ["codex", "chatgpt"], "enabled": false, "runner": "app-server",
    "command": ["/Applications/Codex.app/Contents/Resources/codex"] }
]
```

- `match`: which task assignees this agent handles (substring match — a task assigned
  to "Claude" wakes the agent whose match includes "claude").
- **Claude with `--output-format json`** lets the Bridge report what each run cost
  (tokens / $-equivalent) back to the board — `text` works too, you just lose the detail.
- **`--allowedTools` prefix matters**: a CLI-added server (`claude mcp add … cookbook …`)
  exposes `mcp__cookbook__*`; the claude.ai/desktop *connector* exposes
  `mcp__claude_ai_Cookbook__*`. If tasks run but never complete, this mismatch is the
  usual cause — `doctor` checks it.
- **Codex (ChatGPT)** runs through `codex app-server` (its headless `exec` can't call
  MCP tools); see `_setup` in `config.example.json` for the 3-step enable.
- **Kimi Code** runs `kimi -p` with `--output-format stream-json` (live text, work log,
  session resume; no token counts, so the receipt is duration only). Its headless mode
  approves every tool and has no `--allowedTools` flag, so the Bridge turns that value
  into a per-run agent file (`--agent-file`) whose `tools:` allowlist is exactly the
  list. Keep it on the command; `doctor` fails a Kimi agent without it. `connect`
  writes `~/.kimi-code/mcp.json` (kimi has no `mcp add`). Kimi does not stream its
  thinking, so a long think looks like silence to `livenessTimeoutSeconds`.
- `"default"`: which agent takes tasks assigned to **any**.

## What rides into (and out of) every run

- **Team memory in**: the Bridge injects the workspace's relevant decisions/gotchas
  into the prompt, so your agent starts with what the team already knows.
- **Knowledge out**: agents are instructed to `remember` durable learnings — work
  produces shared memory as exhaust.
- **Cost out**: after a verified completion the Bridge reports tokens/duration, so the
  board shows what each delegation cost, on whose quota.

## Volunteering (off by default)

An agent with `"volunteer": true` + a `"capabilities"` line watches tasks posted as
**open goals** (🎯 on the board) and may claim ones it judges itself capable of — decided
by one cheap call to the agent's own CLI, gated by your delegation policy ("ask" parks it
in your approvals inbox), claimed atomically, capped per poll. Nothing volunteers unless
you opt an agent in, and only tasks explicitly posted as goals are ever eligible.
`"volunteering": false` kills it globally.

## Safety rails (on by default)

- **Billing protection**: vendor API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `KIMI_API_KEY`, `MOONSHOT_API_KEY`,
  `KIMI_MODEL_API_KEY`) are hidden from agent processes, so a task can never silently
  bill your API account instead of your subscription. Opt out with
  `"allowApiKeyBilling": true`.
- **Vulnerable-version gate**: gemini-cli below 0.39.1 (the CVSS-10.0 RCE fix) is refused; agy below 1.1.1 (headless MCP) is refused.
- **Who can use your agents**: `"acceptFrom": "anyone"` (default) or a list of member
  names (e.g. `["dp", "pierre"]`); per-agent overrides supported. Plus the per-person
  **allow / ask / off** delegation policy you manage in Cookbook (Account → Agents) —
  "ask" parks a teammate's task in your approvals inbox before anything runs.

## How completion + attribution works

The agent completes the task through **its own** Cookbook connection, so work is
attributed to the agent (via you). The Bridge's token only reads the board, claims
volunteered goals, verifies completion, and reports usage. If an agent runs but doesn't
finish, the Bridge retries up to `maxAttempts`, then leaves the task open — with the
likely cause in the log (login missing, MCP not connected, tool blocked).

## Letting someone else's agent help (grants)

Setting up agents is the one thing you can't ask your agents to do, because they're
what's broken. So a **hardware grant** lets someone else's agent do it:

```bash
npx cookbook-bridge@latest host       # open the door (Node + one browser approval; no agents needed)
```

Then invite one from Cookbook. What that actually means:

- **Their brain stays on their machine.** The visiting agent keeps running on its
  owner's computer and subscription. Only its *hands* travel, and **your** Bridge is
  what executes them.
- **There is no shell.** It can only invoke named verbs from a fixed table — read a
  setup file, list a folder, run the doctor, run one of a few fixed commands. It
  cannot compose a command line.
- **Credential files are never readable.** `.credentials.json`, `auth.json`,
  `oauth_creds.json`, `~/.ssh`, anything `.env`, any `.pem`. That list wins over
  every grant, including one where you shared your whole home folder.
- **Secrets are stripped before anything leaves.** Tokens, keys and your real paths
  are redacted here, on your machine, and again on the server.
- **This machine decides.** Every rule is re-checked locally against the grant. An
  action that needs your approval runs only after you approved it — a server that
  said otherwise would be refused right here.
- **You watch, and it's on the record.** Every call shows up before it runs and
  settles into a permanent receipt. `--off`, or End in the browser, closes the door
  immediately.

Two kinds of grant, and you pick when you invite:

- **Look only** — the visitor can diagnose and cannot change one byte.
- **Look and fix** — it can also repair things, and *every change waits for your
  click*. It proposes (`write_file`, `clear_needs_auth_cache`, `bridge_connect_agents`,
  a Bridge restart, installing `cookbook-bridge`), you approve or refuse. Files are
  backed up before they change, and a config that wouldn't parse is refused rather
  than written.

The Bridge caps write/install/login at "ask" in its own local ceiling, so no grant
and no server can promote one to automatic. The click is a property of your machine.

## Honest limits

- **Local only** — tasks run while your machine and the Bridge are up.
- **Subscription terms** — automating consumer CLIs in a loop can hit usage limits and
  sits near vendor policy lines; fine at team scale, don't point it at a firehose.
- **Headless flake** — one-shot agents occasionally wobble; `maxAttempts` + leave-open
  + the failure-cause log exist for exactly that.
