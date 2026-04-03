/**
 * Discord RPC Bridge
 *
 * Full auth flow:
 *   Handshake → AUTHORIZE → token exchange → AUTHENTICATE
 *   → subscribe SPEAKING_START/STOP → forward to browser via WebSocket
 *
 * Usage:
 *   DISCORD_CLIENT_ID=1489607111531958273 \
 *   DISCORD_CLIENT_SECRET=<your_secret>   \
 *   node discord-rpc-bridge.js
 *
 * Optional env vars:
 *   WS_PORT            – WebSocket port for the browser (default: 6969)
 *   DISCORD_REDIRECT_URI – must match one registered in your app's OAuth2
 *                          redirects (default: http://127.0.0.1)
 *
 * In your Discord application settings (discord.com/developers/applications):
 *   OAuth2 → Redirects → add "http://127.0.0.1"
 */

"use strict";

const net = require("net");
const https = require("https");
const path = require("path");
const { WebSocketServer } = require("ws");

// ── Config ─────────────────────────────────────────────────────────────────────

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || "http://127.0.0.1";
const WS_PORT = parseInt(process.env.WS_PORT || "6969", 10);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("[Bridge] Missing required env vars.");
  console.error("[Bridge] Usage:");
  console.error("[Bridge]   DISCORD_CLIENT_ID=<your_client_id> \\");
  console.error("[Bridge]   DISCORD_CLIENT_SECRET=<your_secret>   \\");
  console.error("[Bridge]   node discord-rpc-bridge.js");
  process.exit(1);
}

// ── Discord IPC path ───────────────────────────────────────────────────────────

function getIPCPath(n = 0) {
  if (process.platform === "win32") return `\\\\?\\pipe\\discord-ipc-${n}`;
  const base =
    process.env.XDG_RUNTIME_DIR ||
    process.env.TMPDIR ||
    process.env.TMP ||
    process.env.TEMP ||
    "/tmp";
  return path.join(base, `discord-ipc-${n}`);
}

// ── IPC frame codec ────────────────────────────────────────────────────────────
// Layout: [opcode: uint32LE][length: uint32LE][JSON payload: utf8]

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function encodeFrame(opcode, data) {
  const payload = JSON.stringify(data);
  const buf = Buffer.allocUnsafe(8 + Buffer.byteLength(payload));
  buf.writeUInt32LE(opcode, 0);
  buf.writeUInt32LE(Buffer.byteLength(payload), 4);
  buf.write(payload, 8);
  return buf;
}

class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames = [];
    while (this.buf.length >= 8) {
      const opcode = this.buf.readUInt32LE(0);
      const length = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + length) break;
      const raw = this.buf.slice(8, 8 + length).toString("utf8");
      this.buf = this.buf.slice(8 + length);
      try {
        frames.push({ opcode, data: JSON.parse(raw) });
      } catch {
        console.warn("[IPC] Unparseable frame:", raw);
      }
    }
    return frames;
  }
}

// ── WebSocket server (browser ↔ bridge) ────────────────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT });
const wsClients = new Set();

wss.on("listening", () => {
  console.log(`[Bridge] WebSocket listening on ws://localhost:${WS_PORT}`);
});

wss.on("connection", (ws, req) => {
  wsClients.add(ws);
  console.log(
    `[Bridge] Browser connected (${req.socket.remoteAddress}), total: ${wsClients.size}`,
  );
  ws.on("close", () => {
    wsClients.delete(ws);
    console.log(`[Bridge] Browser disconnected, total: ${wsClients.size}`);
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1 /* OPEN */) ws.send(data);
  }
}

// ── Nonce-based RPC call/subscribe system ──────────────────────────────────────

const pendingCalls = new Map(); // nonce → { resolve, reject }
let nonceSeq = 0;

function rpcCall(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    if (!ipcSocket) return reject(new Error("No IPC socket"));
    const nonce = String(++nonceSeq);
    pendingCalls.set(nonce, { resolve, reject });
    setTimeout(() => {
      if (pendingCalls.has(nonce)) {
        pendingCalls.delete(nonce);
        reject(new Error(`RPC ${cmd} timed out`));
      }
    }, 15_000);
    ipcSocket.write(encodeFrame(OP.FRAME, { cmd, args, nonce }));
  });
}

function rpcSubscribe(evt, args = {}) {
  return new Promise((resolve, reject) => {
    if (!ipcSocket) return reject(new Error("No IPC socket"));
    const nonce = String(++nonceSeq);
    pendingCalls.set(nonce, { resolve, reject });
    setTimeout(() => {
      if (pendingCalls.has(nonce)) {
        pendingCalls.delete(nonce);
        reject(new Error(`SUBSCRIBE ${evt} timed out`));
      }
    }, 15_000);
    ipcSocket.write(
      encodeFrame(OP.FRAME, { cmd: "SUBSCRIBE", evt, args, nonce }),
    );
  });
}

// ── OAuth2 token exchange ──────────────────────────────────────────────────────

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }).toString();

    const req = https.request(
      {
        hostname: "discord.com",
        path: "/api/oauth2/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Token parse error: ${raw}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Voice subscription state ───────────────────────────────────────────────────

let subscribedChannelId = null;

async function subscribeToChannel(channelId) {
  if (!channelId || channelId === subscribedChannelId) return;
  subscribedChannelId = channelId;
  console.log(`[RPC] Subscribing to voice channel ${channelId}`);
  await rpcSubscribe("SPEAKING_START", { channel_id: channelId });
  await rpcSubscribe("SPEAKING_STOP", { channel_id: channelId });
  await rpcSubscribe("VOICE_STATE_CREATE", { channel_id: channelId });
  await rpcSubscribe("VOICE_STATE_DELETE", { channel_id: channelId });
  console.log(
    "[RPC] Subscribed to SPEAKING_START / SPEAKING_STOP / VOICE_STATE_CREATE / VOICE_STATE_DELETE",
  );
}

async function syncVoiceChannel() {
  try {
    const res = await rpcCall("GET_SELECTED_VOICE_CHANNEL", {});
    const ch = res?.data;
    if (ch?.id) {
      const members = (ch.voice_states ?? [])
        .map((vs) => ({ ...vs.user, nick: vs.nick ?? null }))
        .filter(Boolean);
      console.log(
        `[RPC] Currently in voice channel: ${ch.name} (${ch.id}), members: ${members.length}`,
      );
      broadcast({ type: "VOICE_CHANNEL", id: ch.id, name: ch.name, members });
      await subscribeToChannel(ch.id);
    } else {
      console.log("[RPC] Not currently in a voice channel");
      broadcast({ type: "VOICE_CHANNEL", id: null });
    }
  } catch (err) {
    console.error("[RPC] GET_SELECTED_VOICE_CHANNEL error:", err.message);
  }
}

// ── Auth flow (runs after READY) ───────────────────────────────────────────────

async function doAuth() {
  try {
    // Step 1: Authorize — Discord shows an in-app modal for the user to approve
    console.log(
      "[Auth] Sending AUTHORIZE (Discord will show an approval modal)...",
    );
    const authRes = await rpcCall("AUTHORIZE", {
      client_id: CLIENT_ID,
      scopes: ["rpc", "rpc.voice.read", "identify"],
    });

    const code = authRes?.data?.code;
    if (!code) {
      console.error("[Auth] AUTHORIZE did not return a code:", authRes);
      return;
    }
    console.log("[Auth] Got auth code, exchanging for access token...");

    // Step 2: Exchange code for token
    const tokenData = await exchangeCode(code);
    if (!tokenData.access_token) {
      console.error("[Auth] Token exchange failed:", tokenData);
      return;
    }
    console.log(
      "[Auth] Access token obtained (expires in",
      tokenData.expires_in,
      "s)",
    );

    // Step 3: Authenticate with the token
    const authData = await rpcCall("AUTHENTICATE", {
      access_token: tokenData.access_token,
    });
    const user = authData?.data?.user;
    console.log("[Auth] Authenticated as:", user?.username, `(${user?.id})`);
    console.log("[Auth] Scopes:", authData?.data?.scopes);
    console.log("[Auth] Token expires:", authData?.data?.expires);
    broadcast({ type: "AUTHENTICATED", user, scopes: authData?.data?.scopes });

    // Step 4: Find + subscribe to current voice channel
    await syncVoiceChannel();

    // Step 5: Subscribe to channel-select so we follow the user when they switch
    await rpcSubscribe("VOICE_CHANNEL_SELECT", {});
    console.log("[RPC] Subscribed to VOICE_CHANNEL_SELECT");
  } catch (err) {
    console.error("[Auth] Auth flow error:", err.message);
    broadcast({ type: "AUTH_ERROR", message: err.message });
  }
}

// ── IPC connection ─────────────────────────────────────────────────────────────

let ipcSocket = null;
let rpcReady = false;

function connectToDiscord(attempt = 0) {
  const ipcPath = getIPCPath(attempt % 10);
  console.log(`[IPC] Trying ${ipcPath} ...`);

  const socket = net.createConnection(ipcPath);
  const parser = new FrameParser();
  ipcSocket = socket;

  socket.on("connect", () => {
    console.log(`[IPC] Connected — sending handshake`);
    socket.write(encodeFrame(OP.HANDSHAKE, { v: 1, client_id: CLIENT_ID }));
  });

  socket.on("data", (chunk) => {
    for (const frame of parser.push(chunk)) handleFrame(frame);
  });

  socket.on("error", (err) => {
    console.error(`[IPC] ${ipcPath}: ${err.message}`);
    socket.destroy();
    if (!rpcReady && attempt < 9) {
      connectToDiscord(attempt + 1);
    } else {
      scheduleReconnect();
    }
  });

  socket.on("close", () => {
    rpcReady = false;
    ipcSocket = null;
    subscribedChannelId = null;
    // Reject any pending calls so they don't hang
    for (const [nonce, { reject }] of pendingCalls) {
      reject(new Error("IPC disconnected"));
    }
    pendingCalls.clear();
    console.log("[IPC] Disconnected.");
    broadcast({ type: "CONNECTION", status: "disconnected" });
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  console.log("[IPC] Retrying in 5s...");
  setTimeout(() => connectToDiscord(0), 5000);
}

// ── RPC frame dispatcher ───────────────────────────────────────────────────────

function handleFrame({ opcode, data }) {
  if (opcode === OP.PING) {
    ipcSocket?.write(encodeFrame(OP.PONG, data));
    return;
  }
  if (opcode !== OP.FRAME || !data) return;

  const { cmd, evt, data: d, nonce } = data;

  // Route command responses to their pending promise
  if (nonce && pendingCalls.has(nonce)) {
    const { resolve, reject } = pendingCalls.get(nonce);
    pendingCalls.delete(nonce);
    if (evt === "ERROR") {
      reject(new Error(`RPC error ${d?.code}: ${d?.message}`));
    } else {
      resolve(data);
    }
    return;
  }

  // ── Push events ──

  if (evt === "READY") {
    rpcReady = true;
    console.log("[RPC] READY  v:", d?.v);
    console.log("[RPC]   config:", JSON.stringify(d?.config));
    broadcast({
      type: "CONNECTION",
      status: "connected",
      v: d?.v,
      config: d?.config,
      user: d?.user,
    });
    doAuth(); // kick off auth flow
    return;
  }

  if (evt === "SPEAKING_START") {
    console.log("[RPC] SPEAKING_START  user_id:", d?.user_id);
    broadcast({
      type: "SPEAKING_START",
      user_id: d?.user_id,
      channel_id: d?.channel_id,
    });
    return;
  }

  if (evt === "SPEAKING_STOP") {
    console.log("[RPC] SPEAKING_STOP   user_id:", d?.user_id);
    broadcast({
      type: "SPEAKING_STOP",
      user_id: d?.user_id,
      channel_id: d?.channel_id,
    });
    return;
  }

  if (evt === "VOICE_STATE_CREATE") {
    const user = d?.user ? { ...d.user, nick: d.nick ?? null } : null;
    console.log("[RPC] VOICE_STATE_CREATE  user_id:", user?.id, user?.username);
    broadcast({ type: "VOICE_STATE_CREATE", user });
    return;
  }

  if (evt === "VOICE_STATE_DELETE") {
    const userId = d?.user?.id;
    console.log("[RPC] VOICE_STATE_DELETE  user_id:", userId);
    broadcast({ type: "VOICE_STATE_DELETE", user_id: userId });
    return;
  }

  if (evt === "VOICE_CHANNEL_SELECT") {
    const channelId = d?.channel_id;
    console.log(
      "[RPC] VOICE_CHANNEL_SELECT  channel_id:",
      channelId ?? "(none)",
    );
    subscribedChannelId = null; // reset so subscribeToChannel re-subscribes
    if (channelId) {
      syncVoiceChannel().catch(console.error); // fetches members + subscribes
    } else {
      broadcast({ type: "VOICE_CHANNEL", id: null });
    }
    return;
  }

  if (evt === "ERROR") {
    console.error("[RPC] ERROR", d?.code, d?.message);
    broadcast({ type: "ERROR", code: d?.code, message: d?.message });
    return;
  }

  // Anything else
  console.log(`[RPC] cmd=${cmd ?? "—"} evt=${evt ?? "—"}`, JSON.stringify(d));
  broadcast({ type: "RPC_FRAME", cmd, evt, data: d });
}

// ── Boot ───────────────────────────────────────────────────────────────────────

connectToDiscord(0);
