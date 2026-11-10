// ============================================================
// stream — Edge Function (the only door to song bytes)
// GET /functions/v1/stream?p=<file path>&e=<expiry>&s=<hmac>
//
// The <audio> element can't send login headers, so the songs
// function mints short-lived signed links for logged-in owners.
// This function verifies the signature, then proxies bytes from
// GitHub (with the server-side token) — forwarding Range
// requests so seeking works. Without a valid signature nothing
// is returned.
// Includes a generous per-IP rate limit (seeking and chunked
// playback make many small requests — the budget is high so
// normal listening is never throttled).
// ============================================================

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

async function hmacHex(text: string) {
  const secret = Deno.env.get('STREAM_SIGNING_SECRET') ?? '';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- per-isolate rate limiting (best effort) ---------- */
const rlStore: Map<string, number[]> = (globalThis as any).__om_rl ?? new Map();
(globalThis as any).__om_rl = rlStore;
function rateLimit(key: string, limit: number, windowMs: number): number {
  const k = 'stream:' + key;
  const now = Date.now();
  const arr = rlStore.get(k) ?? [];
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= limit) return Math.ceil((arr[0] + windowMs - now) / 1000);
  arr.push(now);
  rlStore.set(k, arr);
  return 0; // 0 = allowed, >0 = retry-after seconds
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);

  const url = new URL(req.url);
  const p = url.searchParams.get('p') ?? '';
  const e = parseInt(url.searchParams.get('e') ?? '0', 10);
  const s = url.searchParams.get('s') ?? '';

  // path must look like one of our song files — blocks proxying arbitrary repo files
  if (!/^songs\/[A-Za-z0-9._\-\/]+$/.test(p) || p.includes('..') || p.includes('//')) {
    return json({ error: 'Bad path.' }, 400);
  }
  if (!Number.isFinite(e) || e <= 0) return json({ error: 'Bad expiry.' }, 400);

  const now = Math.floor(Date.now() / 1000);
  if (now > e) return json({ error: 'This playback link expired. Refresh the page.' }, 403);

  const sig = await hmacHex(p + ':' + e);
  if (!sig || !safeEqual(sig, s)) return json({ error: 'Invalid signature.' }, 403);

  // 600 requests / 5 min / IP: a seek-heavy hour of listening stays
  // far below this; a script hammering the proxy does not.
  const ip = req.headers.get('cf-connecting-ip') ??
    (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  const wait = rateLimit(ip, 600, 300_000);
  if (wait) return json({ error: 'Too many requests — slow down.' }, 429, { 'Retry-After': String(wait) });

  const owner = Deno.env.get('GITHUB_OWNER') ?? '';
  const repo = Deno.env.get('GITHUB_REPO') ?? '';
  const branch = Deno.env.get('GITHUB_BRANCH') ?? 'main';
  const token = Deno.env.get('GITHUB_TOKEN') ?? '';
  if (!owner || !repo || !token) {
    return json({ error: 'GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN secrets are not set (setup guide, Step 5).' }, 500);
  }

  // Primary: raw.githubusercontent.com (fast, honours Range for
  // seeking). Fallback: the Contents API — a few tokens (some
  // fine-grained PATs) are refused by the raw host even though
  // the API accepts them, and the API works for every token that
  // can upload, so this makes playback bulletproof.
  const ghHeaders: Record<string, string> = {
    Authorization: 'Bearer ' + token,
    'User-Agent': 'our-music',
  };
  const range = req.headers.get('range');
  if (range) ghHeaders.Range = range; // keeps seeking / partial content working

  const encodedPath = p.split('/').map(encodeURIComponent).join('/');

  let up = await fetch(
    'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' +
      encodeURIComponent(branch) + '/' + encodedPath,
    { headers: ghHeaders },
  );

  if (up.status === 401 || up.status === 403 || up.status === 404) {
    const api = await fetch(
      'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' +
        encodedPath + '?ref=' + encodeURIComponent(branch),
      { headers: { ...ghHeaders, Accept: 'application/vnd.github.raw' } },
    );
    if (api.ok || api.status === 206) up = api; // else keep the raw error below
  }

  if (up.status === 404) {
    return json({ error: 'File missing on GitHub (deleted?). Also check the GITHUB_BRANCH / GITHUB_REPO secrets.' }, 404);
  }
  if (!up.ok && up.status !== 206) return json({ error: 'Upstream error ' + up.status + '.' }, 502);

  const h = new Headers(CORS);
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(name);
    if (v) h.set(name, v);
  }
  return new Response(up.body, { status: up.status, headers: h });
});
