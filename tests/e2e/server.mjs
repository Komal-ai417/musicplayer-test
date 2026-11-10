/* ============================================================
   tests/e2e/server.mjs — static file server + FULLY MOCKED backend.
   Serves docs/ (with config.js pointed at this same origin) and
   answers Supabase Auth / Edge Function endpoints with fixture
   data, so Playwright drives the REAL frontend non-destructively.

   Scenario control endpoint (localhost only):
     PUT /__test/state { "deleteScenario": "staged", ... }
   Recorded calls:
     GET /__test/calls
   ============================================================ */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 4173);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = path.join(ROOT, 'docs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range, x-supabase-api-version, x-supabase-version',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
};

/* ---------- users & sessions ---------- */
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const LEAVER_ID = '33333333-3333-4333-8333-333333333333';

const USERS = {
  [ADMIN_ID]: { id: ADMIN_ID, email: 'organizer@example.test', role: 'admin' },
  [MEMBER_ID]: { id: MEMBER_ID, email: 'member@example.test', role: 'member' },
  [LEAVER_ID]: { id: LEAVER_ID, email: 'leaver@example.test', role: 'member' },
};
const PASSWORDS = { 'organizer@example.test': 'family-code', 'member@example.test': 'family-code' };

/* ---------- fixtures (neutral, non-copyrighted names) ---------- */
const SONGS = [
  { id: 's1', user_id: MEMBER_ID, title: 'Morning Walk', artist: 'The Neighbours', album: 'Home Sessions', duration_sec: 30, file_path: `songs/${MEMBER_ID}/170000000000-morning-walk.mp3`, file_size: 1000, cover_data: null, created_at: '2026-01-03T10:00:00Z' },
  { id: 's2', user_id: MEMBER_ID, title: 'Kitchen Jam', artist: 'The Neighbours', album: 'Home Sessions', duration_sec: 24, file_path: `songs/${MEMBER_ID}/170000000001-kitchen-jam.mp3`, file_size: 1000, cover_data: null, created_at: '2026-01-05T10:00:00Z' },
  { id: 's3', user_id: MEMBER_ID, title: 'Rainy Window', artist: 'Home Recordings', album: null, duration_sec: 18, file_path: `songs/${MEMBER_ID}/170000000002-rainy-window.mp3`, file_size: 1000, cover_data: null, created_at: '2026-01-04T10:00:00Z' },
  { id: 's4', user_id: MEMBER_ID, title: 'Track 04', artist: null, album: null, duration_sec: 21, file_path: `songs/${MEMBER_ID}/170000000003-track-04.mp3`, file_size: 1000, cover_data: null, created_at: '2026-01-06T10:00:00Z' },
  { id: 'sL1', user_id: LEAVER_ID, title: 'Leftover Tune', artist: 'The Neighbours', album: null, duration_sec: 12, file_path: `songs/${LEAVER_ID}/170000000000-leftover-tune.mp3`, file_size: 1000, cover_data: null, created_at: '2026-02-01T10:00:00Z' },
  { id: 'sL2', user_id: LEAVER_ID, title: 'Second Leftover', artist: null, album: null, duration_sec: 14, file_path: `songs/${LEAVER_ID}/170000000001-second-leftover.mp3`, file_size: 1000, cover_data: null, created_at: '2026-02-02T10:00:00Z' },
];
const LYRICS = {
  s1: '[00:01.00]First morning line\n[00:03.00]Second morning line\n[00:05.00]Third morning line\n[00:07.00]Fourth morning line\n[00:09.00]Fifth morning line',
};
const PLAYLISTS = [
  { id: 'pl1', user_id: MEMBER_ID, name: 'Evening', created_at: '2026-01-10T10:00:00Z' },
];
const LINKS = [
  { playlist_id: 'pl1', song_id: 's1', position: 0 },
  { playlist_id: 'pl1', song_id: 's2', position: 1 },
];

/* ---------- mutable scenario state ---------- */
const state = {
  deleteScenario: 'ok',     // 'ok' | 'staged' | 'fail-github'
  deleteCalls: [],          // recorded POST bodies
  deleteGets: 0,
  songOps: [],              // recorded songs POST ops
  failSongsOnce: false,
};
const tokens = new Map();   // token -> user id

function freshToken(uid) {
  const tok = 'tok-' + uid + '-' + Math.random().toString(36).slice(2, 10);
  tokens.set(tok, uid);
  return tok;
}

const refreshTokens = new Map(); // refresh token -> user id
function freshRefresh(uid) {
  const r = 'refresh-' + Math.random().toString(36).slice(2);
  refreshTokens.set(r, uid);
  return r;
}

/* ---------- 30 s sine-wave WAV (real audio bytes) ---------- */
function makeWav(seconds = 30, rate = 8000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = 0.45 * (1 - (i % rate) / rate); // fade each second, no clicks
    const v = Math.sin((2 * Math.PI * 440 * i) / rate) * env;
    buf.writeInt16LE(Math.round(v * 32767 * 0.6), 44 + i * 2);
  }
  return buf;
}
const WAV = makeWav();

/* ---------- helpers ---------- */
const CTYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const j = (data, status = 200, extra = {}) => [JSON.stringify(data), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
}];

function authUser(req) {
  const h = req.headers.authorization || '';
  const tok = h.replace(/^Bearer\s+/i, '');
  const uid = tokens.get(tok);
  return uid ? USERS[uid] : null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); }
    });
  });
}

function userJson(u, tok, refresh) {
  return {
    access_token: tok,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refresh,
    user: {
      id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
      email_confirmed_at: '2026-01-01T00:00:00Z', phone: '',
      last_sign_in_at: new Date().toISOString(),
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {}, identities: [],
      created_at: '2026-01-01T00:00:00Z', updated_at: new Date().toISOString(),
    },
  };
}

/* ---------- the mock backend ---------- */
async function handleApi(req, res, url) {
  const p = url.pathname;

  /* ---- test control (localhost only) ---- */
  if (p === '/__test/state' && req.method === 'PUT') {
    const b = await readBody(req);
    Object.assign(state, b);
    return j({ ok: true });
  }
  if (p === '/__test/calls') {
    return j({ ...state });
  }

  /* ---- auth ---- */
  if (p === '/auth/v1/token' && req.method === 'POST') {
    const b = await readBody(req);
    if (url.searchParams.get('grant_type') === 'password') {
      const pw = PASSWORDS[b.email];
      const uid = pw && pw === b.password && Object.values(USERS).find((u) => u.email === b.email)?.id;
      if (!uid) return j({ error: 'invalid_credentials', error_description: 'Invalid login credentials' }, 400);
      return j(userJson(USERS[uid], freshToken(uid), freshRefresh(uid)));
    }
    if (url.searchParams.get('grant_type') === 'refresh_token') {
      const uid = refreshTokens.get(b.refresh_token);
      if (!uid) return j({ error: 'invalid refresh token' }, 400);
      return j(userJson(USERS[uid], freshToken(uid), freshRefresh(uid)));
    }
    return j({ error: 'unsupported' }, 400);
  }
  if (p === '/auth/v1/user') {
    const u = authUser(req);
    if (!u) return j({ error: 'invalid token' }, 401);
    return j(userJson(u, 'x', 'x').user);
  }
  if (p === '/auth/v1/logout') return [null, { status: 204, headers: CORS }];

  /* ---- functions ---- */
  if (p.startsWith('/functions/v1/')) {
    const fn = p.slice('/functions/v1/'.length).split('/')[0];

    if (fn === 'songs') {
      const u = authUser(req);
      if (!u) return j({ error: 'Not signed in.' }, 401);
      if (req.method === 'GET') {
        if (state.failSongsOnce) { state.failSongsOnce = false; return j({ error: 'Too many requests' }, 429, { 'Retry-After': '9' }); }
        const mine = SONGS.filter((s) => s.user_id === u.id)
          .map(({ lyrics, ...rest }) => rest)  // eslint-disable-line no-unused-vars
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        return j({ songs: mine, cfg: { max_songs_per_user: 200, max_upload_mb: 20 } });
      }
      const b = await readBody(req);
      state.songOps.push(b.op);
      if (b.op === 'get-lyrics') {
        const song = SONGS.find((s) => s.id === b.id && s.user_id === u.id);
        if (!song) return j({ error: 'Song not found (or not yours).' }, 404);
        return j({ id: song.id, lyrics: LYRICS[song.id] ?? '' });
      }
      if (b.op === 'save-lyrics') {
        const song = SONGS.find((s) => s.id === b.id && s.user_id === u.id);
        if (!song) return j({ error: 'Song not found (or not yours).' }, 404);
        LYRICS[song.id] = String(b.lyrics ?? '');
        return j({ ok: true });
      }
      if (b.op === 'stream-url') {
        const song = SONGS.find((s) => s.id === b.id && s.user_id === u.id);
        if (!song) return j({ error: 'Song not found (or not yours).' }, 404);
        const exp = Math.floor(Date.now() / 1000) + 3600;
        return j({ url: `/functions/v1/stream?p=${encodeURIComponent(song.file_path)}&e=${exp}&s=mocksig`, expires_at: exp });
      }
      if (b.op === 'delete') {
        const i = SONGS.findIndex((s) => s.id === b.id && s.user_id === u.id);
        if (i < 0) return j({ error: 'Song not found (or not yours).' }, 404);
        SONGS.splice(i, 1);
        return j({ ok: true });
      }
      return j({ error: 'Unknown op.' }, 400);
    }

    if (fn === 'playlists') {
      const u = authUser(req);
      if (!u) return j({ error: 'Not signed in.' }, 401);
      if (req.method === 'GET') {
        const mine = PLAYLISTS.filter((x) => x.user_id === u.id);
        const ids = mine.map((x) => x.id);
        return j({ playlists: mine, links: LINKS.filter((l) => ids.includes(l.playlist_id)) });
      }
      return j({ ok: true });
    }

    if (fn === 'upload-song') {
      const u = authUser(req);
      if (!u) return j({ error: 'Not signed in.' }, 401);
      return j({ song: { id: 'new1', user_id: u.id, title: 'Uploaded Tune', artist: null, album: null, duration_sec: 10, file_path: 'x', file_size: 10, created_at: new Date().toISOString() } });
    }

    if (fn === 'stream') {
      return [WAV, {
        status: 200,
        headers: {
          ...CORS,
          'Content-Type': 'audio/wav',
          'Content-Length': String(WAV.length),
          'Accept-Ranges': 'none',
        },
      }];
    }

    if (fn === 'delete-user') {
      const u = authUser(req);
      if (!u) return j({ error: 'Not signed in.' }, 401);
      if (u.id !== ADMIN_ID) return j({ error: 'Administrator access required.' }, 403);

      if (req.method === 'GET') {
        state.deleteGets++;
        const songsBy = new Map(), plsBy = new Map();
        for (const s of SONGS) songsBy.set(s.user_id, (songsBy.get(s.user_id) ?? 0) + 1);
        for (const x of PLAYLISTS) plsBy.set(x.user_id, (plsBy.get(x.user_id) ?? 0) + 1);
        return j({
          users: Object.values(USERS).map((x) => ({
            id: x.id, email: x.email, created_at: '2026-01-01', last_sign_in_at: '2026-06-01',
            is_admin: x.id === ADMIN_ID,
            song_count: songsBy.get(x.id) ?? 0,
            playlist_count: plsBy.get(x.id) ?? 0,
          })),
        });
      }

      const b = await readBody(req);
      state.deleteCalls.push({ ...b, _n: state.deleteCalls.length });
      if (state.deleteScenario === 'fail-github') {
        return j({ error: 'GitHub refused (403) — often a temporary rate limit.', stage: 'github', done: false }, 502);
      }
      if (state.deleteScenario === 'staged') {
        if (!b.cursor) {  // first call (absent, null or 0) -> partial batch
          // realistic pause: GitHub file deletes take a moment, and it
          // makes the progress UI observable in tests
          await new Promise((r) => setTimeout(r, 600));
          return j({
            done: false, stage: 'github', target: b.user_id, cursor: 1,
            progress: { files_done: 1, files_total: 2, files_remaining: 1 },
          });
        }
      }
      // 'ok' (or the second call of 'staged'): full success
      return j({
        done: true, stage: 'complete', target: b.user_id, email: 'leaver@example.test',
        stages: { github: true, storage: true, database: true, auth: true },
        summary: { links_own_deleted: 0, links_other_deleted: 0, playlists_deleted: 0, songs_deleted: 2 },
      });
    }

    return j({ error: 'Function not found: ' + fn }, 404);
  }

  return j({ error: 'not found' }, 404);
}

/* ---------- static docs/ ---------- */
async function serveStatic(url, res) {
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = file.replace(/^\/+/, '');
  let full = path.normalize(path.join(DOCS, file));
  if (!full.startsWith(DOCS)) return [null, { status: 403 }];

  if (file === 'config.js') {
    const cfg = `/* test config */
const SUPABASE_URL = 'http://localhost:${PORT}';
const SUPABASE_ANON_KEY = 'test-anon-key';
const APP_NAME = 'Our Music';
`;
    return [cfg, { status: 200, headers: { ...CORS, 'Content-Type': CTYPES['.js'] } }];
  }
  try {
    const data = await readFile(full);
    const ext = path.extname(full);
    return [data, { status: 200, headers: { ...CORS, 'Content-Type': CTYPES[ext] ?? 'application/octet-stream' } }];
  } catch {
    return [null, { status: 404 }];
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  try {
    const isApi = url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/functions/') ||
      url.pathname.startsWith('/storage/') ||
      url.pathname.startsWith('/__test/');
    let body, meta;
    if (isApi) [body, meta] = await handleApi(req, res, url);
    else [body, meta] = await serveStatic(url, res);
    if (meta.status === 204 || body === null && meta.status === 204) {
      res.writeHead(204, meta.headers);
      res.end();
      return;
    }
    if (body === null) {
      res.writeHead(meta.status, { ...CORS, 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(meta.status, meta.headers);
    res.end(body);
  } catch (e) {
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e-server] http://localhost:${PORT} (docs + mocked Supabase)`);
});
