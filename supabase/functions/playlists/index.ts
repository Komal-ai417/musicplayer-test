// ============================================================
// playlists — Edge Function
// GET                              -> your playlists + links
// POST {op:'create',   name}
// POST {op:'rename',   id, name}
// POST {op:'delete',   id}
// POST {op:'add',      playlist_id, song_id}
// POST {op:'remove',   playlist_id, song_id}
// Every operation re-checks ownership server-side.
// Includes a per-isolate rate limit (best effort).
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const user = await caller(req);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  // 60 playlist operations / minute / user.
  const wait = rateLimit('playlists', user.id, 60, 60_000);
  if (wait) return json({ error: 'Too many requests — try again in ' + wait + 's.' }, 429, { 'Retry-After': String(wait) });

  const db = admin();

  // ---- list ----
  if (req.method === 'GET') {
    const { data: playlists, error } = await db.from('playlists')
      .select('*').eq('user_id', user.id).order('created_at', { ascending: true });
    if (error) return json({ error: 'Database error: ' + error.message }, 500);
    const ids = (playlists ?? []).map(p => p.id);
    const { data: links } = ids.length
      ? await db.from('playlist_songs').select('playlist_id, song_id, position').in('playlist_id', ids)
      : { data: [] };
    return json({ playlists: playlists ?? [], links: links ?? [] });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const b = await req.json().catch(() => null);
  const op = b?.op;

  const ownPlaylist = async (id: string) => {
    const { data } = await db.from('playlists')
      .select('id, name, user_id, created_at').eq('id', id).eq('user_id', user.id).maybeSingle();
    return data ?? null;
  };

  if (op === 'create') {
    const name = String(b.name ?? '').trim().slice(0, 100);
    if (!name) return json({ error: 'Playlist needs a name.' }, 400);
    const { data, error } = await db.from('playlists')
      .insert({ user_id: user.id, name }).select().single();
    if (error) return json({ error: 'Could not create: ' + error.message }, 500);
    return json({ playlist: data });
  }

  if (op === 'rename') {
    const pl = await ownPlaylist(String(b.id ?? ''));
    if (!pl) return json({ error: 'Playlist not found (or not yours).' }, 404);
    const name = String(b.name ?? '').trim().slice(0, 100);
    if (!name) return json({ error: 'Playlist needs a name.' }, 400);
    const { error } = await db.from('playlists').update({ name }).eq('id', pl.id);
    if (error) return json({ error: 'Could not rename: ' + error.message }, 500);
    return json({ ok: true });
  }

  if (op === 'delete') {
    const pl = await ownPlaylist(String(b.id ?? ''));
    if (!pl) return json({ error: 'Playlist not found (or not yours).' }, 404);
    const { error } = await db.from('playlists').delete().eq('id', pl.id);
    if (error) return json({ error: 'Could not delete: ' + error.message }, 500);
    return json({ ok: true });
  }

  if (op === 'add') {
    const pl = await ownPlaylist(String(b.playlist_id ?? ''));
    if (!pl) return json({ error: 'Playlist not found (or not yours).' }, 404);
    const { data: song } = await db.from('songs')
      .select('id').eq('id', String(b.song_id ?? '')).eq('user_id', user.id).maybeSingle();
    if (!song) return json({ error: 'Song not found (or not yours).' }, 404);
    const { count } = await db.from('playlist_songs')
      .select('song_id', { count: 'exact', head: true }).eq('playlist_id', pl.id);
    const { error } = await db.from('playlist_songs')
      .insert({ playlist_id: pl.id, song_id: song.id, position: count ?? 0 });
    if (error) {
      if (error.code === '23505') return json({ error: 'Already in this playlist.', duplicate: true }, 409);
      return json({ error: 'Could not add: ' + error.message }, 500);
    }
    return json({ ok: true });
  }

  if (op === 'remove') {
    const pl = await ownPlaylist(String(b.playlist_id ?? ''));
    if (!pl) return json({ error: 'Playlist not found (or not yours).' }, 404);
    const { error } = await db.from('playlist_songs')
      .delete().eq('playlist_id', pl.id).eq('song_id', String(b.song_id ?? ''));
    if (error) return json({ error: 'Could not remove: ' + error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: 'Unknown op.' }, 400);
});
