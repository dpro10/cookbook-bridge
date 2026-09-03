/**
 * Robot runner — the Bridge's embodied-agent socket (Coordination v2, sim-first).
 *
 * Unlike the LLM runners (which get a PROMPT and reason), a robot agent gets the
 * task STRUCTURED — env vars, not prose — because its "brain" is a skill program
 * (today a kinematic sim; later a LeRobot policy), not a language model. The
 * contract mirrors every other runner: the Bridge pre-claims, the agent process
 * does the work THROUGH Cookbook MCP tools (upload_file for the camera-proof
 * receipt, remember for the writeback, complete_task to finish), and the Bridge
 * verifies completion via getTask like any other run.
 *
 * Safety posture for embodied agents: this runner NEVER auto-approves anything;
 * the standard delegation policy applies upstream, and for REAL hardware the
 * owner's policy should be 'ask' — a physical action deserves a human yes.
 * (v0 is a simulation; the posture is set now so hardware inherits it.)
 *
 * Config example:
 *   { "name": "Robo", "match": ["robo", "robot", "arm"], "runner": "robot",
 *     "command": ["python3", "robots/sim-arm/agent.py"], "token": "cbk_mcp_..." }
 */
import { spawn } from "node:child_process";

export function runRobotTask(agent, ws, task, timeoutSeconds, token, cookbookUrl, baseEnv) {
  return new Promise((resolve) => {
    const [cmd, ...args] = agent.command;
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...(baseEnv ?? process.env),
        COOKBOOK_URL: cookbookUrl,
        COOKBOOK_TOKEN: token,
        WORKSPACE_ID: ws.id,
        TASK_ID: task.id,
        TASK_TITLE: task.title ?? "",
        TASK_INSTRUCTIONS: task.instructions ?? "",
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutSeconds * 1000);
    child.on("error", (e) => {
      clearTimeout(killTimer);
      resolve({ code: -1, out, err: `could not launch robot agent \`${cmd}\`: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ code, out, err });
    });
  });
}
