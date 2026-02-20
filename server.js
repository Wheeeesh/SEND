import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Optional: set METERED_API_KEY env var to serve real TURN credentials.
// Get a free key at https://dashboard.metered.ca/signup?tool=turnserver
// Free tier: 20 GB/month.
const METERED_API_KEY = process.env.METERED_API_KEY || null;
const METERED_APP_NAME = process.env.METERED_APP_NAME || null;

// Cached ICE servers — refresh every 50 minutes (credentials last 1 hour)
let iceCache = null;
let iceCacheTime = 0;
const ICE_CACHE_TTL = 50 * 60 * 1000;

// Fallback ICE config used when no METERED_API_KEY is set.
// These are STUN-only — P2P works when both peers have public IPs or are on the same network.
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
  if (iceCache && (now - iceCacheTime) < ICE_CACHE_TTL) {
    return iceCache;
  }

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

// /ice — frontend calls this to get ICE server config before creating RTCPeerConnection
app.get('/ice', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const metered = await fetchMeteredIce();
  if (metered) {
    res.json({ iceServers: metered });
  } else {
    res.json({ iceServers: FALLBACK_ICE });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

// sessionId → Set of WebSocket clients (max 2 per room)
const rooms = new Map();

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const { sessionId } = msg;
        if (!sessionId) return;

        if (!rooms.has(sessionId)) {
          rooms.set(sessionId, new Set());
        }
        const room = rooms.get(sessionId);

        if (room.size >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'room-full' }));
          return;
        }

        room.add(ws);
        currentRoom = sessionId;
        ws.sessionId = sessionId;

        if (room.size === 2) {
          room.forEach((peer) => {
            if (peer !== ws && peer.readyState === 1) {
              peer.send(JSON.stringify({ type: 'receiver-joined' }));
            }
          });
        }

        console.log(`[${sessionId}] peer joined (${room.size}/2)`);
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
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
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.delete(ws);

      room.forEach((peer) => {
        if (peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'peer-disconnected' }));
        }
      });

      if (room.size === 0) {
        rooms.delete(currentRoom);
        console.log(`[${currentRoom}] room closed`);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

server.listen(PORT, () => {
  const turnStatus = METERED_API_KEY ? `Metered TURN (${METERED_APP_NAME})` : 'STUN only (set METERED_API_KEY for TURN)';
  console.log(`SEND running at http://localhost:${PORT} — ICE: ${turnStatus}`);
});
