/**
 * SEND — Cloudflare Worker entry point
 *
 * Handles:
 *  - GET /ice  → returns TURN/STUN ICE server credentials (Cloudflare Calls TURN)
 *               Automatically falls back to STUN-only when monthly usage >= 900 GB
 *  - GET /ws   → upgrades to WebSocket, routes to SignalingRoom Durable Object
 *  - Everything else → served as static assets from public/ (via ASSETS binding)
 */

export { SignalingRoom } from './signaling-room.js';
export { UsageGuard }   from './usage-guard.js';

// STUN-only fallback — used when TURN keys aren't set, or monthly cap is hit
const FALLBACK_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Cache generated TURN credentials — valid 24h, refresh every 23h
let iceCache = null;
let iceCacheTime = 0;
const ICE_CACHE_TTL = 23 * 60 * 60 * 1000;

async function isOverUsageLimit(env) {
  try {
    const id = env.USAGE_GUARD.idFromName('global');
    const guard = env.USAGE_GUARD.get(id);
    const res = await guard.fetch('https://internal/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cfAccountId:    env.CF_ACCOUNT_ID,
        cfEmail:        env.CF_EMAIL,
        cfGlobalApiKey: env.CF_GLOBAL_API_KEY,
        cfTurnKeyId:    env.CF_TURN_KEY_ID,
      }),
    });
    const data = await res.json();
    console.log(`[usage] ${data.usageGB?.toFixed(2)} GB used this month (limit 900 GB, cached=${data.cached})`);
    return data.overLimit;
  } catch (err) {
    // If the check fails, allow TURN — better to slightly overshoot than break the app
    console.error('[usage] check failed:', err.message);
    return false;
  }
}

async function fetchCloudflareTurn(env) {
  const keyId     = env.CF_TURN_KEY_ID;
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
      // Check monthly cap before issuing TURN credentials
      const overLimit = await isOverUsageLimit(env);
      const cfTurn = overLimit ? null : await fetchCloudflareTurn(env);
      const iceServers = cfTurn || FALLBACK_ICE;

      if (overLimit) {
        console.warn('[ice] Monthly TURN cap reached — serving STUN only');
      }

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

      const doId = env.SIGNALING_ROOM.idFromName(sessionId);
      const room = env.SIGNALING_ROOM.get(doId);
      return room.fetch(request);
    }

    // ── Everything else → static assets (public/) ────────────────────────────
    return env.ASSETS.fetch(request);
  },
};
