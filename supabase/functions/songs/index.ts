// ============================================================
// songs — Edge Function
// GET                        -> your songs + app limits
// POST {op:'delete', id}     -> delete song (GitHub + database)
// POST {op:'stream-url', id} -> short-lived signed playback link
// POST {op:'get-lyrics', id} -> the song's lyrics text
// POST {op:'save-lyrics', id, lyrics} -> save lyrics text
// The GitHub token NEVER leaves this server.
// Includes a per-isolate rate limit (seatbelt against floods;
// Supabase may run several isolates, so it is best-effort).
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
  });

const admin = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

async function caller(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await admin().auth.getUser(token);
  return data.user ?? null;
}

/* ---------- per-isolate rate limiting (best effort) ---------- */
const rlStore: Map<string, number[]> = (globalThis as any).__om_rl ?? new Map();
(globalThis as any).__om_rl = rlStore;
function rateLimit(bucket: string, key: string, limit: number, windowMs: number): number {
  const k = bucket + ':' + key;
  const now = Date.now();
  const arr = rlStore.get(k) ?? [];
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= limit) return Math.ceil((arr[0] + windowMs - now) / 1000);
  arr.push(now);
  rlStore.set(k, arr);
  return 0; // 0 = allowed, >0 = retry-after seconds
}

function ghEnv() {
  return {
    owner: Deno.env.get('GITHUB_OWNER') ?? '',
    repo: Deno.env.get('GITHUB_REPO') ?? '',
    branch: Deno.env.get('GITHUB_BRANCH') ?? 'main',
    token: Deno.env.get('GITHUB_TOKEN') ?? '',
  };
}

async function ghApi(path: string, method = 'GET', body?: unknown) {
  const gh = ghEnv();
  if (!gh.token || !gh.owner || !gh.repo) {
    return { status: 500, ok: false, data: { message: 'GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO secrets are not all set (see setup guide, Step 5).' } };
  }
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + gh.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'our-music',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

function ghErr(status: number, data: any) {
  const m = data?.message ?? '';
  if (status === 401) return 'GitHub rejected the token (401). Generate a fresh one and update the GITHUB_TOKEN secret.';
  if (status === 403) return 'GitHub refused (403). The token needs "Contents: Read and write" access to the songs repo. ' + m;
  if (status === 404) return 'GitHub says not found (404). Check the GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH secrets.';
  return 'GitHub error (' + status + '). ' + m;
}

async function hmacHex(text: string) {
  const secret = Deno.env.get('STREAM_SIGNING_SECRET') ?? '';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const user = await caller(req);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  // 120 requests / minute / user: every playback link is one call,
  // so this leaves plenty of room for normal listening.
  const wait = rateLimit('songs', user.id, 120, 60_000);
  if (wait) return json({ error: 'Too many requests — try again in ' + wait + 's.' }, 429, { 'Retry-After': String(wait) });

  const db = admin();

  // ---- list ----
  if (req.method === 'GET') {
    const [{ data: songs, error }, { data: cfg }] = await Promise.all([
      // explicit columns: lyrics is fetched lazily per song (get-lyrics)
      // so the library list stays small even with long lyrics.
      db.from('songs')
        .select('id, user_id, title, artist, album, duration_sec, file_path, file_size, cover_data, created_at')
        .eq('user_id', user.id).order('created_at', { ascending: false }),
      db.from('app_config').select('max_songs_per_user, max_upload_mb').eq('id', 1).maybeSingle(),
    ]);
    if (error) return json({ error: 'Database error: ' + error.message }, 500);
    return json({
      songs: songs ?? [],
      cfg: cfg ?? { max_songs_per_user: 200, max_upload_mb: 20 },
    });
  }

  // ---- ops ----
  if (req.method === 'POST') {
    const body = await req.json().catch(() => null);
    const op = body?.op;

    if (op === 'delete') {
      const id = String(body.id ?? '');
      const { data: song } = await db.from('songs')
        .select('id, title, file_path').eq('id', id).eq('user_id', user.id).maybeSingle();
      if (!song) return json({ error: 'Song not found (or not yours).' }, 404);

      const gh = ghEnv();
      const meta = await ghApi(
        `/repos/${gh.owner}/${gh.repo}/contents/${song.file_path}?ref=${encodeURIComponent(gh.branch)}`,
      );
      if (meta.ok && meta.data?.sha) {
        const del = await ghApi(
          `/repos/${gh.owner}/${gh.repo}/contents/${song.file_path}`,
          'DELETE',
          { message: 'Delete song: ' + song.title, sha: meta.data.sha, branch: gh.branch },
        );
        if (!del.ok) return json({ error: ghErr(del.status, del.data) }, 502);
      } // 404 on meta = file already gone on GitHub; still remove the row below.

      const { error: delErr } = await db.from('songs').delete().eq('id', song.id);
      if (delErr) return json({ error: 'Removed from GitHub, but the database entry stayed: ' + delErr.message }, 500);
      return json({ ok: true });
    }

    if (op === 'stream-url') {
      if (!Deno.env.get('STREAM_SIGNING_SECRET')) {
        return json({ error: 'STREAM_SIGNING_SECRET is not set (setup guide, Step 5).' }, 500);
      }
      const id = String(body.id ?? '');
      const { data: song } = await db.from('songs')
        .select('id, file_path').eq('id', id).eq('user_id', user.id).maybeSingle();
      if (!song) return json({ error: 'Song not found (or not yours).' }, 404);
      const exp = Math.floor(Date.now() / 1000) + 6 * 3600; // 6 hours
      const sig = await hmacHex(song.file_path + ':' + exp);
      const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/stream` +
        `?p=${encodeURIComponent(song.file_path)}&e=${exp}&s=${sig}`;
      return json({ url, expires_at: exp });
    }

    if (op === 'get-lyrics') {
      const id = String(body.id ?? '');
      const { data: song, error } = await db.from('songs')
        .select('id, lyrics').eq('id', id).eq('user_id', user.id).maybeSingle();
      if (error) return json({ error: 'Database error: ' + error.message }, 500);
      if (!song) return json({ error: 'Song not found (or not yours).' }, 404);
      return json({ id: song.id, lyrics: song.lyrics ?? '' });
    }

    if (op === 'save-lyrics') {
      const id = String(body.id ?? '');
      const raw = body.lyrics;
      const lyrics = raw == null ? '' : String(raw).slice(0, 100_000); // cap; plain text or LRC
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(lyrics)) {
        return json({ error: 'Lyrics contain invalid characters.' }, 400);
      }
      const { data: song } = await db.from('songs')
        .select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
      if (!song) return json({ error: 'Song not found (or not yours).' }, 404);
      const { error } = await db.from('songs')
        .update({ lyrics: lyrics === '' ? null : lyrics }).eq('id', song.id);
      if (error) return json({ error: 'Could not save lyrics: ' + error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: 'Unknown op.' }, 400);
  }

  return json({ error: 'Method not allowed.' }, 405);
});
