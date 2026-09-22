/**
 * THE DOORBELL (0083) — the Bridge's push channel without a held server socket.
 *
 * Instead of holding an SSE stream open against a serverless function (which bills
 * per held connection and ticks a DB read every second), the Bridge subscribes to
 * one Supabase Realtime topic. The topic name is an unguessable capability derived
 * from this Bridge's token (sha256 chain — the server derives the same value from
 * the token's stored hash; see wakeTopicForTokenHash in src/lib/bridge/wake.ts,
 * parity pinned by scripts/test-bridge-doorbell.ts). The channel carries NOTHING:
 * a wake ping, after which the Bridge fetches its work over the same authenticated
 * HTTP it always used. Lose the socket and nothing breaks — the 60s failsafe pull
 * and the janitor sweep still run; dispatch just degrades from instant to ≤60s.
 *
 * Raw Phoenix-channels protocol over the built-in WebSocket (Node ≥22): join one
 * topic, heartbeat every 25s, surface broadcasts, reconnect with backoff. No
 * dependencies, by Bridge law.
 */
import { createHash } from "node:crypto";

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

/** MUST match wakeTopicForTokenHash(sha256(token)) on the server. */
export function deriveWakeTopic(token) {
  const tokenHash = sha256Hex(String(token));
  return `bwake:${sha256Hex(`cookbook-bridge-wake:${tokenHash}`)}`;
}

/** Node ≥22 ships a global WebSocket; older Nodes fall back to the SSE lane. */
export function wakeSocketSupported() {
  return typeof WebSocket === "function";
}

const HEARTBEAT_MS = 25_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Connect and keep connected. Calls onWake() for every ring, onState(true/false)
 * on join/loss. Returns { stop }. Never throws out of its loop.
 */
export function connectWakeSocket({ url, anonKey, topic, onWake, onState, log = () => {} }) {
  let stopped = false;
  let ws = null;
  let heartbeat = null;
  let backoff = BACKOFF_MIN_MS;
  let ref = 0;
  const wsUrl = `${String(url).replace(/^http/, "ws").replace(/\/$/, "")}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;

  const cleanup = (sock) => {
    // Only tear down the CURRENT socket: a stale socket's late close event must
    // never kill its replacement (audit F5).
    if (sock && sock !== ws) return;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (ws) { try { ws.close(); } catch { /* closing */ } ws = null; }
  };

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      log(`· doorbell socket failed to open (${e.message}) — retrying`);
      return scheduleReconnect();
    }
    const send = (msg) => { try { ws?.send(JSON.stringify(msg)); } catch { /* reconnect covers */ } };
    ws.addEventListener("open", () => {
      backoff = BACKOFF_MIN_MS;
      send({
        topic: `realtime:${topic}`,
        event: "phx_join",
        payload: { config: { broadcast: { self: false, ack: false }, presence: { key: "" }, postgres_changes: [], private: false }, access_token: anonKey },
        ref: String(++ref),
      });
      heartbeat = setInterval(() => {
        send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++ref) });
      }, HEARTBEAT_MS);
    });
    const thisSock = ws;
    const down = () => {
      cleanup(thisSock);
      onState?.(false);
      scheduleReconnect();
    };
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.event === "phx_reply" && msg.topic === `realtime:${topic}`) {
        if (msg.payload?.status === "ok") onState?.(true);
        else {
          // A refused join must RECONNECT with backoff, not hold a deaf socket
          // open forever (audit F4).
          log(`· doorbell join refused (${JSON.stringify(msg.payload).slice(0, 120)}) — reconnecting`);
          down();
        }
        return;
      }
      // Channel-level errors/closes also mean deaf: full reconnect (audit F4).
      if (msg.event === "phx_error" || msg.event === "phx_close") { down(); return; }
      if (msg.event === "broadcast" && msg.payload?.event === "wake") onWake?.();
    });
    ws.addEventListener("close", down);
    ws.addEventListener("error", down);
  };

  let reconnectTimer = null;
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      cleanup();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LIVE LANE (2026-09-14): the agent's words, straight to the browser.
// ─────────────────────────────────────────────────────────────────────────────
//
// Progress used to reach the thread view through five hops (MCP POST to the
// server, jsonb rewrite, broadcast, debounce, full refetch): 2 to 3 s per update,
// whole messages only. The server now hands the Bridge a per-task topic
// (`live_topic`, an unguessable capability, see src/lib/workspaces/live-topic.ts)
// and the Bridge publishes the live tail on it directly, over the same kind of
// Phoenix socket the doorbell uses. The database path still runs, slower, as the
// record; this is the fast lane. Lose the socket and nothing breaks: publishes
// fall back to Realtime's REST endpoint, and the database path still paints.

const LIVE_EVENT = "live";
const LIVE_REST_TIMEOUT_MS = 4_000;

/**
 * One socket, many topics. `publish(topic, payload)` joins the topic on first
 * use and sends; `leave(topic)` releases it when the run ends. Never throws;
 * never blocks a run (every send is fire-and-forget).
 */
export function createLivePublisher({ url, anonKey, log = () => {} }) {
  const base = String(url).replace(/\/$/, "");
  const wsUrl = `${base.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
  let ws = null;
  let open = false;
  let ref = 0;
  let heartbeat = null;
  let stopped = false;
  let backoff = BACKOFF_MIN_MS;
  let reconnectTimer = null;
  const joined = new Map(); // topic -> "joining" | "ok"
  const queued = new Map(); // topic -> payload[] (until the join is acked)

  const send = (msg) => {
    if (!ws || !open) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  };
  const rest = (topic, payload) => {
    // Fallback when the socket is down: Realtime's REST broadcast (no Vercel hop
    // either). Best-effort, bounded, silent.
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), LIVE_REST_TIMEOUT_MS);
    fetch(`${base}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic, event: LIVE_EVENT, payload, private: false }] }),
      signal: ctl.signal,
    }).catch(() => {}).finally(() => clearTimeout(t));
  };
  const join = (topic) => {
    if (joined.has(topic)) return;
    joined.set(topic, "joining");
    send({
      topic: `realtime:${topic}`,
      event: "phx_join",
      payload: { config: { broadcast: { self: false, ack: false }, presence: { key: "" }, postgres_changes: [], private: false }, access_token: anonKey },
      ref: `j:${topic}:${++ref}`,
    });
  };
  const flush = (topic) => {
    const q = queued.get(topic);
    if (!q) return;
    queued.delete(topic);
    for (const payload of q) send({ topic: `realtime:${topic}`, event: "broadcast", payload: { type: "broadcast", event: LIVE_EVENT, payload }, ref: String(++ref) });
  };
  const cleanup = (sock) => {
    if (sock && sock !== ws) return;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (ws) { try { ws.close(); } catch { /* closing */ } ws = null; }
    open = false;
    joined.clear();
  };
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
  };
  const connect = () => {
    if (stopped || typeof WebSocket !== "function") return;
    try { ws = new WebSocket(wsUrl); } catch { return scheduleReconnect(); }
    const thisSock = ws;
    const down = () => { cleanup(thisSock); scheduleReconnect(); };
    ws.addEventListener("open", () => {
      open = true;
      backoff = BACKOFF_MIN_MS;
      heartbeat = setInterval(() => send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++ref) }), HEARTBEAT_MS);
      // Topics with queued words re-join on a fresh socket.
      for (const topic of queued.keys()) join(topic);
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.event === "phx_reply" && typeof msg.topic === "string" && msg.topic.startsWith("realtime:") && String(msg.ref ?? "").startsWith("j:")) {
        const topic = msg.topic.slice("realtime:".length);
        if (!joined.has(topic)) {
          // leave() ran while the join was in flight: release the late-acked topic.
          if (msg.payload?.status === "ok") send({ topic: `realtime:${topic}`, event: "phx_leave", payload: {}, ref: String(++ref) });
          return;
        }
        if (msg.payload?.status === "ok") { joined.set(topic, "ok"); flush(topic); }
        else { joined.delete(topic); const q = queued.get(topic) ?? []; queued.delete(topic); for (const p of q) rest(topic, p); }
        return;
      }
      if (msg.event === "phx_error" || msg.event === "phx_close") { if (msg.topic === "phoenix") down(); }
    });
    ws.addEventListener("close", down);
    ws.addEventListener("error", down);
  };
  connect();

  return {
    /** Fire-and-forget. Joined topic: sent now. Joining: queued. No socket: REST. */
    publish(topic, payload) {
      if (stopped || !topic) return;
      if (!open) { rest(topic, payload); return; }
      const state = joined.get(topic);
      if (state === "ok") {
        send({ topic: `realtime:${topic}`, event: "broadcast", payload: { type: "broadcast", event: LIVE_EVENT, payload }, ref: String(++ref) });
        return;
      }
      const q = queued.get(topic) ?? [];
      q.push(payload);
      if (q.length > 50) q.shift();
      queued.set(topic, q);
      if (!state) join(topic);
    },
    /** Release a topic when its run is over (keeps the socket's join table small). */
    leave(topic) {
      if (!topic) return;
      queued.delete(topic);
      if (joined.has(topic)) {
        joined.delete(topic);
        send({ topic: `realtime:${topic}`, event: "phx_leave", payload: {}, ref: String(++ref) });
      }
    },
    connected() { return open; },
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      cleanup();
    },
  };
}
