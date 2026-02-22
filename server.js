import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Optional: set METERED_API_KEY env var to serve real TURN credentials.
const METERED_API_KEY = process.env.METERED_API_KEY || null;
const METERED_APP_NAME = process.env.METERED_APP_NAME || null;

// Cached ICE servers — refresh every 50 minutes (credentials last 1 hour)
let iceCache = null;
let iceCacheTime = 0;
const ICE_CACHE_TTL = 50 * 60 * 1000;

const FALLBACK_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

async function fetchMeteredIce() {
  if (!METERED_API_KEY || !METERED_APP_NAME) return null;
  const now = Date.now();
  if (iceCache && (now - iceCacheTime) < ICE_CACHE_TTL) return iceCache;
  try {
    const url = `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Metered API returned ${res.status}`);
    const servers = await res.json();
    iceCache = servers;
    iceCacheTime = now;
    console.log(`[ice] fetched ${servers.length} ICE servers from Metered`);
    return servers;
  } catch (err) {
    console.error('[ice] Metered fetch failed:', err.message);
    return null;
  }
}

const app = express();
app.use(express.static(join(__dirname, 'public')));

app.get('/ice', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const metered = await fetchMeteredIce();
  res.json({ iceServers: metered || FALLBACK_ICE });
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

// sessionId → Set of WebSocket clients (max 2 per room)
const rooms = new Map();

function joinRoom(ws, sessionId) {
  if (!sessionId) return null;
  if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
  const room = rooms.get(sessionId);
  if (room.size >= 2) {
    ws.send(JSON.stringify({ type: 'error', message: 'room-full' }));
    return null;
  }
  room.add(ws);
  ws.sessionId = sessionId;
  if (room.size === 2) {
    room.forEach((peer) => {
      if (peer !== ws && peer.readyState === 1) {
        peer.send(JSON.stringify({ type: 'receiver-joined' }));
      }
    });
  }
  console.log(`[${sessionId}] peer joined (${room.size}/2)`);
  return sessionId;
}

wss.on('connection', (ws, req) => {
  let currentRoom = null;

  // Support sessionId from URL query param (/ws?sessionId=xxx) — used by Cloudflare Worker path.
  // Also supported: 'join' message below — used for plain local dev.
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlSessionId = reqUrl.searchParams.get('sessionId');
  if (urlSessionId) {
    currentRoom = joinRoom(ws, urlSessionId);
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'join': {
        // Only process if we haven't already joined via URL param
        if (!currentRoom) {
          currentRoom = joinRoom(ws, msg.sessionId);
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        const roomId = currentRoom || ws.sessionId;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.forEach((peer) => {
          if (peer !== ws && peer.readyState === 1) {
            peer.send(JSON.stringify(msg));
          }
        });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const roomId = currentRoom || ws.sessionId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.delete(ws);
      room.forEach((peer) => {
        if (peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'peer-disconnected' }));
        }
      });
      if (room.size === 0) {
        rooms.delete(roomId);
        console.log(`[${roomId}] room closed`);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

server.listen(PORT, () => {
  const turnStatus = METERED_API_KEY
    ? `Metered TURN (${METERED_APP_NAME})`
    : 'STUN only (set METERED_API_KEY for TURN)';
  console.log(`SEND running at http://localhost:${PORT} — ICE: ${turnStatus}`);
});
