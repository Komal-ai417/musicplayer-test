// ============================================================
// delete-user — Edge Function (administrator-only)
//
// GET                       -> admin: list users + song/playlist counts
// POST { user_id }          -> admin: permanently delete that account
//
// Deletion order (data safety first — a later stage only runs
// after the earlier one is fully clean):
//   1. GitHub   : every audio file under songs/<target>/ (Contents API)
//   2. Storage  : every object under song-staging/<target>/ (Storage API)
//   3. Database : delete_user_data() RPC (one transaction, service_role only)
//   4. Auth     : admin.auth.admin.deleteUser() — LAST
//
// Guarantees
//   * JWT verification stays ON. Unauthenticated -> 401.
//   * Caller must equal the ADMIN_USER_ID secret -> otherwise 403.
//     (Any isAdmin flag from the browser is ignored — this check
//     is the only authority.)
//   * Invalid target UUID -> 400. Self-deletion -> 400.
//   * Already-missing GitHub files / storage objects / auth users
//     count as CLEANED — the whole operation is idempotent, and a
//     retry after a partial failure finishes the job safely.
//   * Resumable: if the GitHub stage would exceed the time budget
//     for huge libraries, the function returns { done:false,
//     stage:'github', progress } — the client POSTs the same body
//     again until done:true. Each invocation handles a bounded
//     batch (<= 40 files / 40 s), so the Edge execution limit is
//     never at risk.
//   * The Auth account is deleted ONLY after stages 1-3 report
//     fully clean, so a failed run can always be retried.
//   * A per-isolate in-flight guard (409) plus a Postgres advisory
//     lock inside delete_user_data() stop concurrent double-runs.
//   * Logs and responses carry user IDs and counts only — never
//     tokens, secrets or passwords.
//
// Required secrets (Edge Functions -> Secrets):
//   ADMIN_USER_ID  — the admin's Supabase user UUID
//   (GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH are
//    the existing project-wide secrets, used for stage 1)
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

/* ---------- validation (pure — mirrored in tests/unit/delete-user.validators.test.js) ---------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/* file_path is generated server-side at upload as
   songs/<uid>/<ts>-<slug>.<ext>. Reject anything that could escape
   that shape: no "..", no absolute path, no empty/unsafe segments,
   exactly songs/<target>/basename. */
function safeSongPath(p: unknown, target: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 300) return false;
  if (p.includes('..') || p.startsWith('/') || p.includes('//') || p.includes('\\')) return false;
  if (p.includes('\0') || /[="'`;\s]/.test(p)) return false;
  const seg = p.split('/');
  return seg.length === 3 && seg[0] === 'songs' && seg[1] === target &&
    seg[2].length > 0 && /^[A-Za-z0-9._-]+$/.test(seg[2]);
}

/* ---------- per-isolate rate limiting (best effort; Supabase may
   run several isolates, so this is a seatbelt, not a wall) ---------- */
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

/* ---------- per-isolate in-flight guard ---------- */
const inFlight: Set<string> = (globalThis as any).__om_del ?? new Set();
(globalThis as any).__om_del = inFlight;

/* ---------- GitHub (same conventions as the songs function) ---------- */
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
    return { status: 500, ok: false, data: { message: 'GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO secrets are not all set (see setup guide).' } };
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
  if (status === 403) return 'GitHub refused (403) — often a temporary rate limit. Wait a few minutes and retry; the deletion resumes where it left off. ' + m;
  if (status === 404) return 'GitHub says not found (404). Check the GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH secrets.';
  return 'GitHub error (' + status + '). ' + m;
}

/* ---------- Storage: recursive, paginated enumeration ---------- */
async function listStagingFiles(db: ReturnType<typeof admin>, target: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    let offset = 0;
    const PAGE = 100;
    while (true) {
      const { data, error } = await db.storage.from('song-staging').list(folder, {
        limit: PAGE,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw new Error(error.message);
      const items = (data ?? []) as Array<Record<string, unknown>>;
      if (!items.length) return;
      for (const it of items) {
        const name = String(it.name ?? '');
        if (!name) continue;
        if (it.id) out.push(folder + '/' + name);          // a file
        else await walk(folder + '/' + name);              // a subfolder -> recurse
      }
      offset += items.length;
      if (items.length < PAGE) return;                     // this folder is done
    }
  };
  await walk(target); // empty or already-deleted folder -> no entries -> []
  return out;
}

/* ============================================================
 * MAIN
 * ============================================================ */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // ---- authentication (JWT verification stays ON) ----
  const user = await caller(req);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  // ---- administrator authorization: server-side secret ONLY ----
  const adminId = (Deno.env.get('ADMIN_USER_ID') ?? '').trim().toLowerCase();
  if (!validUuid(adminId)) {
    return json({ error: 'ADMIN_USER_ID secret is not set to a valid user UUID (see setup guide, admin section).' }, 500);
  }
  if (String(user.id).toLowerCase() !== adminId) {
    return json({ error: 'Administrator access required.' }, 403);
  }
  const db = admin();

  // ================= GET: user list for the admin UI =================
  if (req.method === 'GET') {
    const wait = rateLimit('du-list', user.id, 10, 60_000);
    if (wait) return json({ error: 'Too many requests — try again in ' + wait + 's.' }, 429, { 'Retry-After': String(wait) });

    const users: Array<{ id: string; email?: string; created_at?: string; last_sign_in_at?: string }> = [];
    try {
      let page = 1;
      while (page <= 10) { // hard cap: 10 x 200 = 2000 accounts
        const { data: pageData, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
        if (error) return json({ error: 'Could not list users: ' + error.message }, 500);
        const meta = pageData as unknown as { users?: Array<any> } | null;
        const list = meta?.users ?? [];
        users.push(...list.map(u => ({
          id: String(u.id), email: u.email ?? '', created_at: u.created_at ?? null, last_sign_in_at: u.last_sign_in_at ?? null,
        })));
        const next = (pageData as unknown as { nextPage?: number | null })?.nextPage;
        if (!list.length || !next) break;
        page = next;
      }
    } catch (e) {
      return json({ error: 'Could not list users: ' + (e instanceof Error ? e.message : 'unknown') }, 500);
    }

    // song + playlist counts, grouped in two light queries
    const [{ data: songRows }, { data: plRows }] = await Promise.all([
      db.from('songs').select('user_id'),
      db.from('playlists').select('user_id'),
    ]);
    const songsByUser = new Map<string, number>();
    for (const r of (songRows ?? [])) songsByUser.set(r.user_id, (songsByUser.get(r.user_id) ?? 0) + 1);
    const plsByUser = new Map<string, number>();
    for (const r of (plRows ?? [])) plsByUser.set(r.user_id, (plsByUser.get(r.user_id) ?? 0) + 1);

    return json({
      users: users.map(u => ({
        id: u.id,
        email: u.email ?? '',
        created_at: u.created_at ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
        is_admin: String(u.id).toLowerCase() === adminId,
        song_count: songsByUser.get(u.id) ?? 0,
        playlist_count: plsByUser.get(u.id) ?? 0,
      })),
    });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  // ================= POST: the deletion itself =================
  const wait = rateLimit('du-run', user.id, 4, 3_600_000);
  if (wait) return json({ error: 'Deletion attempts are rate limited — try again in ' + Math.ceil(wait / 60) + ' min.' }, 429, { 'Retry-After': String(wait) });

  const body = await req.json().catch(() => null);
  const target = typeof body?.user_id === 'string' ? body.user_id.trim().toLowerCase() : '';
  if (!validUuid(target)) return json({ error: 'Invalid target user id.' }, 400);
  if (target === String(user.id).toLowerCase()) {
    return json({ error: 'The administrator account cannot delete itself.' }, 400);
  }
  // resumable github stage: index to start from (0 for a fresh run).
  // Defensively clamped below against the real song list length.
  let cursor = Number(body?.cursor);
  if (!Number.isInteger(cursor) || cursor < 0) cursor = 0;

  // concurrent deletion of the same account (same isolate)
  if (inFlight.has(target)) {
    return json({ error: 'This account is already being deleted — wait for it to finish.', stage: 'concurrency' }, 409);
  }
  inFlight.add(target);

  try {
    // ---------- the target must exist in Auth ----------
    const { data: targetUser, error: tgtErr } = await db.auth.admin.getUserById(target);
    if (tgtErr && !/not found|does not exist/i.test(String(tgtErr.message))) {
      return json({ error: 'Could not look up the account: ' + tgtErr.message, stage: 'auth-lookup' }, 500);
    }
    const authGone = !targetUser?.user;
    const targetEmail = targetUser?.user?.email ?? '';

    // ---------- STAGE 1: GitHub audio files ----------
    // The app stores ONLY audio under songs/<uid>/ on GitHub — cover
    // art lives in the database (songs.cover_data), so there are no
    // other user-owned GitHub assets to clean.
    const gh = ghEnv();
    const { data: songs, error: songErr } = await db.from('songs')
      .select('id, title, file_path').eq('user_id', target);
    if (songErr) return json({ error: 'Database error: ' + songErr.message, stage: 'github-list' }, 500);
    const songList: Array<{ id: string; title: string; file_path: string }> = songs ?? [];

    const DEADLINE_MS = 40_000;  // stay well inside the Edge wall-clock limit
    const BATCH = 40;            // bounded batch of GitHub DELETEs per invocation
    const start = Date.now();
    let cleaned = 0;            // files confirmed gone after this invocation
    let skippedShared = 0;
    let expensive = 0;          // actual GitHub DELETE calls made (404 checks are cheap)
    let i = Math.min(cursor, songList.length);

    for (; i < songList.length; i++) {
      const song = songList[i];
      if (!safeSongPath(song.file_path, target)) {
        // A path that fails validation means a hand-edited row. NEVER
        // delete blindly — abort and name the row so it can be fixed.
        return json({
          error: 'Song ' + song.id + ' has an unexpected file_path and was left untouched. ' +
                 'Fix or remove that row (check it starts with songs/' + target + '/), then retry.',
          stage: 'github-path',
          done: false,
        }, 500);
      }
      if (expensive >= BATCH || Date.now() - start > DEADLINE_MS) break;

      // defense in depth: if another user's song row points at the SAME
      // file, it is still referenced — skip the GitHub delete (the row
      // itself is removed in the DB stage regardless).
      const { count: shared } = await db.from('songs')
        .select('id', { count: 'exact', head: true })
        .eq('file_path', song.file_path).neq('user_id', target);
      if ((shared ?? 0) > 0) { skippedShared++; continue; }

      const enc = song.file_path.split('/').map(encodeURIComponent).join('/');
      const meta = await ghApi(`/repos/${gh.owner}/${gh.repo}/contents/${enc}?ref=${encodeURIComponent(gh.branch)}`);
      if (meta.status === 404) { cleaned++; continue; }              // already gone = cheap, no batch cost
      if (!meta.ok) {
        return json({ error: ghErr(meta.status, meta.data), stage: 'github', done: false }, 502, { 'Retry-After': '30' });
      }
      const sha = meta.data?.sha;
      if (!sha) { cleaned++; continue; }                             // odd API reply — treat as gone
      expensive++;                                                  // a real DELETE is the costly call
      let del = await ghApi(`/repos/${gh.owner}/${gh.repo}/contents/${enc}`, 'DELETE',
        { message: 'Delete user audio: ' + song.title, sha, branch: gh.branch });
      if (del.status === 409) { // sha moved (rare race) — re-fetch once, retry once
        const meta2 = await ghApi(`/repos/${gh.owner}/${gh.repo}/contents/${enc}?ref=${encodeURIComponent(gh.branch)}`);
        if (meta2.status === 404) { cleaned++; continue; }
        if (meta2.ok && meta2.data?.sha) {
          del = await ghApi(`/repos/${gh.owner}/${gh.repo}/contents/${enc}`, 'DELETE',
            { message: 'Delete user audio: ' + song.title, sha: meta2.data.sha, branch: gh.branch });
        }
      }
      if (del.status === 404) { cleaned++; continue; }               // vanished between the two calls
      if (!del.ok) {
        return json({ error: ghErr(del.status, del.data), stage: 'github', done: false }, 502, { 'Retry-After': '30' });
      }
      cleaned++;
    }

    if (i < songList.length) {
      // Resumable: the client re-POSTs with the returned cursor;
      // already-gone files were cheap 404 checks, so progress is real.
      return json({
        done: false,
        stage: 'github',
        target,
        cursor: i,
        progress: { files_done: i, files_total: songList.length, files_remaining: songList.length - i },
        next: 'Re-invoke with the same body and this cursor to continue.',
      });
    }

    // ---------- STAGE 2: Storage (song-staging/<target>/) ----------
    let stagingFiles: string[] = [];
    try {
      stagingFiles = await listStagingFiles(db, target);
    } catch (e) {
      return json({ error: 'Storage listing failed: ' + (e instanceof Error ? e.message : 'unknown'), stage: 'storage', done: false }, 502, { 'Retry-After': '30' });
    }
    for (let i = 0; i < stagingFiles.length; i += 100) {   // safe batches
      const { error: rmErr } = await db.storage.from('song-staging').remove(stagingFiles.slice(i, i + 100));
      if (rmErr) {
        return json({ error: 'Storage deletion failed: ' + rmErr.message, stage: 'storage', done: false }, 502, { 'Retry-After': '30' });
      }
    }

    // ---------- STAGE 3: database (one transactional RPC) ----------
    const { data: dbResult, error: rpcErr } = await db.rpc('delete_user_data', { p_target: target });
    if (rpcErr) {
      return json({
        error: 'Database cleanup failed (nothing was half-deleted — the RPC is a single transaction): ' + rpcErr.message,
        stage: 'database', done: false,
      }, 500, { 'Retry-After': '30' });
    }

    // ---------- STAGE 4: auth account (ONLY now) ----------
    if (authGone) {
      return json({ done: true, stage: 'complete', target, email: targetEmail, stages: { github: true, storage: true, database: true, auth: true }, summary: dbResult ?? null });
    }
    const { error: authErr } = await db.auth.admin.deleteUser(target);
    if (authErr) {
      if (/not found|does not exist/i.test(String(authErr.message))) {
        return json({ done: true, stage: 'complete', target, email: targetEmail, stages: { github: true, storage: true, database: true, auth: true }, summary: dbResult ?? null });
      }
      // GitHub/Storage/DB are already clean; only the auth row stayed.
      // A retry races through stages 1-3 as no-ops and lands here again.
      return json({ error: 'Auth deletion failed: ' + authErr.message, stage: 'auth', done: false }, 500, { 'Retry-After': '30' });
    }

    return json({
      done: true,
      stage: 'complete',
      target,
      email: targetEmail,
      stages: { github: true, storage: true, database: true, auth: true },
      summary: dbResult ?? null,
    });
  } finally {
    inFlight.delete(target);
  }
});
