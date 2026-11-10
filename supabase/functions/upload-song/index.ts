// ============================================================
// upload-song — Edge Function
// POST { staging_path, file_name, file_size, duration_sec,
//        title, artist, album, cover_data, lyrics }
//
// The browser first puts the raw file into the private
// "song-staging" Supabase Storage bucket (RLS: own uid folder
// only). This function then moves it to GitHub using the
// server-side token and writes the songs row.
// Includes a per-isolate rate limit (uploads are expensive —
// a tight budget stops floods of 20 MB requests).
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
  });

const STAGING_BUCKET = 'song-staging';

/* Only real audio extensions may enter the library. The browser filter
   can be bypassed (curl / DevTools), so the server enforces this too —
   and it also stops disguised executables (song.mp3.exe). */
const AUDIO_EXT = new Set(['mp3', 'm4a', 'flac', 'wav', 'ogg', 'oga', 'aac', 'opus', 'webm']);
function fileExt(name: string): string | null {
  const m = name.toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return m ? m[1] : null;
}

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

async function ghApi(path: string, method = 'GET', body?: unknown) {
  const owner = Deno.env.get('GITHUB_OWNER') ?? '';
  const repo = Deno.env.get('GITHUB_REPO') ?? '';
  const token = Deno.env.get('GITHUB_TOKEN') ?? '';
  if (!token || !owner || !repo) {
    return { status: 500, ok: false, data: { message: 'GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO secrets are not all set (see setup guide, Step 5).' } };
  }
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
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
  if (status === 409) return 'GitHub reported a name conflict (409). Try renaming the file.';
  return 'GitHub error (' + status + '). ' + m;
}

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
  return base || 'song';
}

async function removeStaging(path: string) {
  try { await admin().storage.from(STAGING_BUCKET).remove([path]); } catch { /* best effort */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const user = await caller(req);
  if (!user) return json({ error: 'Not signed in.' }, 401);
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  // 8 uploads / minute / user — generous for humans, tight for scripts.
  const wait = rateLimit('upload', user.id, 8, 60_000);
  if (wait) return json({ error: 'Too many uploads — try again in ' + wait + 's.' }, 429, { 'Retry-After': String(wait) });

  const b = await req.json().catch(() => null);
  const stagingPath = String(b?.staging_path ?? '');
  const fileName = String(b?.file_name ?? 'song');
  const fileSize = Number(b?.file_size ?? 0);

  /* MIME/type validation: the extension must be a known audio format.
    (Size and ownership are checked further below.) */
  const ext = fileExt(fileName);
  if (!ext || !AUDIO_EXT.has(ext)) {
    return json({ error: 'That file type isn\u2019t allowed \u2014 upload mp3, m4a, flac, wav, ogg, aac or opus audio.' }, 415);
  }

  if (!stagingPath.startsWith(user.id + '/') || stagingPath.includes('..') ||
      !/^[A-Za-z0-9._\-\/]+$/.test(stagingPath)) {
    return json({ error: 'Invalid staging path.' }, 400);
  }

  const db = admin();
  const { data: cfg } = await db.from('app_config')
    .select('max_songs_per_user, max_upload_mb').eq('id', 1).maybeSingle();
  const maxMb = cfg?.max_upload_mb ?? 20;
  const cap = cfg?.max_songs_per_user ?? 200;

  if (fileSize > maxMb * 1024 * 1024) {
    return json({ error: 'File is over the ' + maxMb + ' MB per-song limit.' }, 413);
  }
  const { count } = await db.from('songs')
    .select('id', { count: 'exact', head: true }).eq('user_id', user.id);
  if ((count ?? 0) >= cap) {
    return json({ error: 'You\u2019ve reached the limit of ' + cap + ' songs. Delete a few first.' }, 422);
  }

  // 1) pull the bytes out of private staging (service role bypasses RLS)
  const { data: blob, error: dlErr } = await db.storage.from(STAGING_BUCKET).download(stagingPath);
  if (dlErr || !blob) {
    await removeStaging(stagingPath);
    return json({ error: 'Could not read the uploaded file from staging: ' + (dlErr?.message ?? 'missing') }, 500);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxMb * 1024 * 1024) {
    await removeStaging(stagingPath);
    return json({ error: 'File is empty or over the ' + maxMb + ' MB limit.' }, 413);
  }

  // 2) base64-encode (chunked)
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const b64 = btoa(bin);

  // 3) upload to GitHub — path is decided HERE, never trusted from the client
  const gh = {
    owner: Deno.env.get('GITHUB_OWNER') ?? '',
    repo: Deno.env.get('GITHUB_REPO') ?? '',
    branch: Deno.env.get('GITHUB_BRANCH') ?? 'main',
  };
  const title = String(b?.title || fileName).slice(0, 300);
  let target = `songs/${user.id}/${Date.now()}-${slugify(fileName)}.${ext}`;

  let put = await ghApi(`/repos/${gh.owner}/${gh.repo}/contents/${target}`, 'PUT', {
    message: 'Add song: ' + title, content: b64, branch: gh.branch,
  });
  if (put.status === 409) { // rare name collision — retry with a suffix
    target = `songs/${user.id}/${Date.now()}-${slugify(fileName)}-${Math.floor(Math.random() * 1e4)}.${ext}`;
    put = await ghApi(`/repos/${gh.owner}/${gh.repo}/contents/${target}`, 'PUT', {
      message: 'Add song: ' + title, content: b64, branch: gh.branch,
    });
  }
  if (!put.ok) {
    await removeStaging(stagingPath);
    return json({ error: ghErr(put.status, put.data) }, 502);
  }

  // 4) database row
  const lyricsRaw = b?.lyrics;
  const lyrics = lyricsRaw == null ? null
    : String(lyricsRaw).slice(0, 100_000); // plain text or LRC, capped
  const { data: song, error: insErr } = await db.from('songs').insert({
    user_id: user.id,
    title,
    artist: b?.artist ? String(b.artist).slice(0, 200) : null,
    album: b?.album ? String(b.album).slice(0, 200) : null,
    duration_sec: Number.isFinite(Number(b?.duration_sec)) ? Math.round(Number(b.duration_sec)) : null,
    file_path: target,
    file_size: bytes.length,
    cover_data: typeof b?.cover_data === 'string' && b.cover_data.startsWith('data:image/')
      ? b.cover_data.slice(0, 300000) : null,
    lyrics: lyrics && lyrics.trim() ? lyrics : null,
  }).select().single();

  if (insErr) {
    // roll the GitHub file back so the repo and library stay in sync
    const meta = await ghApi(`/repos/${gh.owner}/${gh.repo}/contents/${target}?ref=${encodeURIComponent(gh.branch)}`);
    if (meta.ok && meta.data?.sha) {
      await ghApi(`/repos/${gh.owner}/${gh.repo}/contents/${target}`, 'DELETE',
        { message: 'Rollback orphan: ' + title, sha: meta.data.sha, branch: gh.branch });
    }
    await removeStaging(stagingPath);
    return json({ error: 'Uploaded to GitHub, but saving to the library failed: ' + insErr.message }, 500);
  }

  await removeStaging(stagingPath);
  return json({ song });
});
