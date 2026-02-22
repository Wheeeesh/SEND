/**
 * SEND — Cloudflare Worker entry point
 *
 * Handles:
 *  - GET /ice  → returns TURN/STUN ICE server credentials (Cloudflare Calls TURN)
 *  - GET /ws   → upgrades to WebSocket, routes to SignalingRoom Durable Object
 *  - Everything else → served as static assets from public/ (via ASSETS binding)
 *
 * Single deployment: one Worker serves both the frontend and the signaling backend.
 * TURN via Cloudflare Calls — no third-party services needed.
 */

export { SignalingRoom } from './signaling-room.js';

// Fallback STUN-only config (used if CF_TURN_KEY_ID / CF_TURN_KEY_SECRET are not set)
const FALLBACK_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Cache generated TURN credentials — they're valid for 24h, refresh every 23h
let iceCache = null;
let iceCacheTime = 0;
const ICE_CACHE_TTL = 23 * 60 * 60 * 1000;

async function fetchCloudflareTurn(env) {
  const keyId = env.CF_TURN_KEY_ID;
  const keySecret = env.CF_TURN_KEY_SECRET;
  if (!keyId || !keySecret) return null;

  const now = Date.now();
  if (iceCache && (now - iceCacheTime) < ICE_CACHE_TTL) {
    return iceCache;
  }

  try {
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${keySecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!res.ok) throw new Error(`CF Calls TURN API ${res.status}`);
    const data = await res.json();
    // data.iceServers is the array
    iceCache = data.iceServers;
    iceCacheTime = now;
    return iceCache;
  } catch (err) {
    console.error('[ice] Cloudflare TURN fetch failed:', err.message);
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // ── GET /ice ─────────────────────────────────────────────────────────────
    if (url.pathname === '/ice' && request.method === 'GET') {
      const cfTurn = await fetchCloudflareTurn(env);
      const iceServers = cfTurn || FALLBACK_ICE;
      return Response.json(
        { iceServers },
        {
          headers: {
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // ── GET /ws?sessionId=... ─────────────────────────────────────────────────
    if (url.pathname === '/ws') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return new Response('Missing sessionId query param', { status: 400 });
      }

      // Route to the Durable Object for this session — ensures both peers
      // land on the same instance (same in-memory room).
      const doId = env.SIGNALING_ROOM.idFromName(sessionId);
      const room = env.SIGNALING_ROOM.get(doId);
      return room.fetch(request);
    }

    // ── Everything else → static assets (public/) ────────────────────────────
    return env.ASSETS.fetch(request);
  },
};
