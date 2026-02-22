/**
 * SEND — Cloudflare Worker entry point
 *
 * Handles:
 *  - GET /ice  → returns TURN/STUN ICE server credentials
 *  - GET /ws   → upgrades to WebSocket, routes to SignalingRoom Durable Object
 *  - Everything else → served as static assets from public/ (via ASSETS binding)
 *
 * Single deployment: one Worker serves both the frontend and the signaling backend.
 */

export { SignalingRoom } from './signaling-room.js';

// Fallback STUN servers when no TURN key is configured
const FALLBACK_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

// Cache TURN credentials in memory for 50 min (they expire after 1 hour)
let iceCache = null;
let iceCacheTime = 0;
const ICE_CACHE_TTL = 50 * 60 * 1000;

async function fetchMeteredIce(env) {
  const apiKey = env.METERED_API_KEY;
  const appName = env.METERED_APP_NAME;
  if (!apiKey || !appName) return null;

  const now = Date.now();
  if (iceCache && (now - iceCacheTime) < ICE_CACHE_TTL) {
    return iceCache;
  }

  try {
    const url = `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Metered API ${res.status}`);
    const servers = await res.json();
    iceCache = servers;
    iceCacheTime = now;
    return servers;
  } catch (err) {
    console.error('[ice] Metered fetch failed:', err.message);
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
      const metered = await fetchMeteredIce(env);
      const iceServers = metered || FALLBACK_ICE;
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
