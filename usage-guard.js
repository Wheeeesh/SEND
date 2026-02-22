/**
 * UsageGuard — Cloudflare Durable Object
 *
 * Tracks monthly TURN bandwidth usage by querying the Cloudflare Calls
 * analytics API. Acts as a singleton (keyed by "global") that caches
 * the result for 1 hour so we don't hammer the analytics API.
 *
 * If usage >= TURN_MONTHLY_LIMIT_GB, the /ice endpoint falls back to
 * STUN-only so we never exceed the free-tier cap.
 */

const TURN_MONTHLY_LIMIT_GB = 900;
const CACHE_TTL_MS = 60 * 60 * 1000; // re-check usage every 1 hour

export class UsageGuard {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /check  { cfAccountId, cfApiKey, cfTurnKeyId }
    // Returns      { overLimit: bool, usageGB: number }
    if (url.pathname === '/check' && request.method === 'POST') {
      const { cfAccountId, cfGlobalApiKey, cfEmail, cfTurnKeyId } = await request.json();

      // Read cached result from SQLite storage
      const cached = await this.state.storage.get('usageCache');
      if (cached) {
        const { usageGB, fetchedAt } = cached;
        if (Date.now() - fetchedAt < CACHE_TTL_MS) {
          return Response.json({ overLimit: usageGB >= TURN_MONTHLY_LIMIT_GB, usageGB, cached: true });
        }
      }

      // Fetch real usage from Cloudflare Calls analytics
      try {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const monthEnd = now.toISOString();

        const apiUrl =
          `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}` +
          `/calls/turn_keys/${cfTurnKeyId}/analytics` +
          `?since=${encodeURIComponent(monthStart)}&until=${encodeURIComponent(monthEnd)}`;

        const res = await fetch(apiUrl, {
          headers: {
            'X-Auth-Email': cfEmail,
            'X-Auth-Key': cfGlobalApiKey,
          },
        });

        if (!res.ok) throw new Error(`Analytics API ${res.status}`);
        const data = await res.json();

        // Sum total bytes from all time buckets
        const totalBytes = (data.result?.data ?? []).reduce((sum, bucket) => {
          return sum + (bucket.bytes ?? 0);
        }, 0);
        const usageGB = totalBytes / (1024 ** 3);

        await this.state.storage.put('usageCache', { usageGB, fetchedAt: Date.now() });
        return Response.json({ overLimit: usageGB >= TURN_MONTHLY_LIMIT_GB, usageGB, cached: false });

      } catch (err) {
        // On error, fall back to cached value if available, else allow TURN
        const stale = await this.state.storage.get('usageCache');
        const usageGB = stale?.usageGB ?? 0;
        return Response.json({
          overLimit: usageGB >= TURN_MONTHLY_LIMIT_GB,
          usageGB,
          cached: true,
          error: err.message,
        });
      }
    }

    return new Response('Not found', { status: 404 });
  }
}
