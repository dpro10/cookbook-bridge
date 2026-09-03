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
