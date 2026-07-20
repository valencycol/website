// feeds.colaco.se — first-party feed proxy with edge caching
// Deploy: Cloudflare dashboard → Workers & Pages → Create Worker → paste → Deploy,
// then Settings → Domains & Routes → add custom domain feeds.colaco.se.
//
// Usage from the site:
//   fetch('https://feeds.colaco.se/?url=' + encodeURIComponent(feedUrl))
//
// Works for RSS/Atom XML and plain HTML pages alike — it returns the upstream
// body verbatim with CORS headers your pages are allowed to read.
//
// Fetches are server-side with a browser fingerprint (+ a consent cookie for
// Google News). If a future feed is bot-walled by its origin, point it at
// Google News instead — e.g.
//   https://news.google.com/rss/search?q=site:HOST&hl=en-US&gl=US&ceid=US:en
// which republishes the articles as plain RSS this worker can fetch directly.

const ALLOWED_ORIGINS = new Set([
  'https://colaco.se',
  'https://www.colaco.se',
]);

// Only these upstream hosts may be proxied. Keep this tight — it is what
// stops the worker from being an open proxy. Add one line per feed host.
const ALLOWED_HOSTS = new Set([
  'ground.news',              // News — homepage + /blindspot
  'feeds.feedburner.com',     // The Hacker News
  'www.bleepingcomputer.com',
  'news.google.com',          // Google News RSS — bypass source for bot-walled feeds
  'krebsonsecurity.com',
  'www.securityweek.com',
  'www.cisa.gov',             // advisories feed + KEV JSON
]);

const FRESH_SECONDS = 15 * 60;      // serve from edge cache for 15 min
const KEEP_SECONDS  = 24 * 60 * 60; // keep a stale copy for a day (error fallback)

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request.headers.get('Origin') || '');
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET')     return json({ error: 'GET only' }, 405, cors);

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return json({ error: 'missing ?url=' }, 400, cors);

    let upstream;
    try { upstream = new URL(target); } catch { return json({ error: 'bad url' }, 400, cors); }
    if (upstream.protocol !== 'https:')        return json({ error: 'https only' }, 400, cors);
    if (!ALLOWED_HOSTS.has(upstream.hostname)) return json({ error: 'host not on allowlist' }, 403, cors);

    // Optional ?max_age= lets the page request tighter freshness (e.g. a
    // manual Refresh). Clamped to [60s, 1 day] so it can't become a hammer.
    const requested = Number(new URL(request.url).searchParams.get('max_age'));
    const freshFor = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(requested, 60), 86400)
      : FRESH_SECONDS;

    const cache = caches.default;                       // requires custom domain, not workers.dev
    const cacheKey = new Request(upstream.toString());  // keyed on upstream URL only (max_age excluded)

    // 1. Fresh-enough edge copy? Serve it.
    const cached = await cache.match(cacheKey);
    if (cached && ageSeconds(cached) < freshFor) {
      return withCors(cached, cors, 'HIT');
    }

    // 2. Refresh from upstream; fall back to the stale copy if it fails.
    try {
      const body = await fetchUpstream(upstream.toString());
      const stored = new Response(body, {
        headers: {
          // Every client consumer reads .text() and parses explicitly, so a
          // fixed XML content-type is harmless even for the JSON/HTML feeds.
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=' + KEEP_SECONDS, // edge keeps it a day…
          'X-Fetched-At': String(Date.now()),                 // …freshness tracked ourselves
        },
      });
      ctx.waitUntil(cache.put(cacheKey, stored.clone()));
      return withCors(stored, cors, 'MISS');
    } catch (err) {
      if (cached) return withCors(cached, cors, 'STALE'); // last good copy beats an error
      return json({ error: String(err) }, 502, cors);
    }
  },
};

// A real browser fingerprint. Many origins block obvious bot user-agents;
// this alone gets past most of them.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/html;q=0.9, */*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Fetch an allowlisted upstream directly, with a browser fingerprint (and a
// consent cookie for Google News). Any non-2xx status throws, which the caller
// turns into a stale-cache hit or a 502. Only allowlisted hosts reach here.
async function fetchUpstream(url) {
  const headers = { ...BROWSER_HEADERS };
  // Google News serves EU visitors a cookie-consent interstitial (HTML) instead
  // of the feed when fetched from an EU datacenter IP. This cookie opts past it
  // so we get the actual RSS. Harmless for any other host.
  if (new URL(url).hostname.endsWith('news.google.com')) {
    headers['Cookie'] = 'CONSENT=YES+';
  }
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error('upstream returned ' + res.status);
  return await res.arrayBuffer();
}

function ageSeconds(res) {
  return (Date.now() - Number(res.headers.get('X-Fetched-At') || 0)) / 1000;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://colaco.se',
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(res, cors, cacheStatus) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  out.headers.set('X-Cache', cacheStatus);
  return out;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
