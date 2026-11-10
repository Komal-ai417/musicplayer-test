/* ============================================================
   delete-user Edge Function — behavioural tests.
   The REAL function code (supabase/functions/delete-user/index.ts)
   runs against fully mocked Supabase + GitHub backends, so every
   scenario is non-destructive.

   Covers the required test list:
     1.  unauthenticated                 -> 401
     2.  ordinary authenticated user     -> 403
     3.  admin deleting own account      -> 400
     4.  invalid target UUID             -> 400
     5.  successful deletion (test acct)
     6.  GitHub failure  -> DB + Auth not touched
     7.  Storage failure -> DB + Auth not touched
     8.  Database failure -> Auth not touched
     9.  Auth failure -> retry finishes safely
     10. already-missing GitHub files -> success
     11. user with no songs/playlists
     12. nested Storage folders
     13. shared file / shared playlist links
     14. two simultaneous deletions      -> 409
     15. many songs -> bounded batches + resume
   ============================================================ */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  createFixture, ghFetchFactory, installDeno, importFunction, resetRateLimiters, resetInFlight, makeRequest,
} from './helpers/sb-mock.js';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const USER2 = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';

const ENV = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  ADMIN_USER_ID: ADMIN,
  GITHUB_OWNER: 'o',
  GITHUB_REPO: 'r',
  GITHUB_BRANCH: 'main',
  GITHUB_TOKEN: 'gh-test',
};

let handler;
let f;

beforeAll(async () => {
  installDeno(ENV);
  f = createFixture();
  globalThis.__sbClientFactory = () => f.client();
  const ghFetch = ghFetchFactory(f);
  globalThis.fetch = ghFetch; // the function calls the global fetch
  handler = await importFunction('supabase/functions/delete-user/index.ts');
});

beforeEach(() => {
  resetRateLimiters();
  resetInFlight();
  // rebuild a clean fixture for every test
  f.authUsers.clear();
  f.tokens.clear();
  f.songs = [];
  f.playlists = [];
  f.playlistSongs = [];
  f.storageTree = {};
  f.calls.gh.length = 0;
  f.calls.authDeletes.length = 0;
  f.calls.rpc.length = 0;
  f.calls.storageList.length = 0;
  f.calls.storageRemove.length = 0;
  Object.assign(f.errors, { rpc: null, storageRemove: null, storageList: null, authDelete: null, listUsers: null });
  f.gh.files.clear();
  f.gh.failMethod = null;
  f.gh.failStatus = 0;

  f.authUsers.set(ADMIN, { id: ADMIN, email: 'organizer@example.test', created_at: '2026-01-01', last_sign_in_at: '2026-06-01' });
  f.authUsers.set(USER2, { id: USER2, email: 'member@example.test', created_at: '2026-02-01', last_sign_in_at: '2026-06-02' });
  f.authUsers.set(TARGET, { id: TARGET, email: 'leaver@example.test', created_at: '2026-03-01', last_sign_in_at: '2026-06-03' });
  f.tokens.set('tok-admin', ADMIN);
  f.tokens.set('tok-user', USER2);
});

/* reset per-isolate rate limiters between calls (except in the
   dedicated rate-limit tests, which pass keepLimit) so prod budgets
   don't interfere with behavioural scenarios */
const call = (method, opts = {}) => {
  if (!opts.keepLimit) resetRateLimiters();
  return handler(makeRequest(method, opts));
};

/* helpers to build a typical target user */
function seedTargetLibrary(n = 2, { ghPresent = true, sharedWithUser2 = false } = {}) {
  for (let i = 0; i < n; i++) {
    const fp = `songs/${TARGET}/17000000000${i}-sample-track-${i + 1}.mp3`;
    if (ghPresent) f.gh.files.add(fp);
    if (sharedWithUser2 && i === 0) {
      // another user's row references the same file
      f.songs.push({
        id: `u2-shared-${i}`, user_id: USER2, title: 'Shared recording', artist: 'The Neighbours',
        album: 'Home Sessions', duration_sec: 100 + i, file_path: fp, file_size: 1000, created_at: '2026-05-01',
      });
    }
    f.songs.push({
      id: `t-${i}`, user_id: TARGET, title: `Sample Track ${i + 1}`, artist: 'The Neighbours',
      album: 'Home Sessions', duration_sec: 120 + i, file_path: fp, file_size: 1000, created_at: '2026-05-02',
    });
  }
  f.playlists.push({ id: 'pl-1', user_id: TARGET, name: 'Evening', created_at: '2026-05-03' });
  f.playlistSongs.push({ playlist_id: 'pl-1', song_id: 't-0', position: 0 });
  f.playlists.push({ id: 'pl-2', user_id: USER2, name: 'Guests', created_at: '2026-05-04' });
  f.playlistSongs.push({ playlist_id: 'pl-2', song_id: 't-1', position: 0 }); // other user's playlist references target's song
  f.storageTree['song-staging'] = {
    [TARGET]: {
      'leftover-upload.mp3': 0,
      'nested': { 'deeper': { 'song.mp3': 0 }, 'top.mp3': 0 },
    },
    [USER2]: { 'keep-me.mp3': 0 },
  };
}

async function body(res) { return res.json(); }

/* ================= 1–4: authorization ================= */
describe('authorization', () => {
  it('1. rejects unauthenticated requests with 401', async () => {
    const res = await call('POST', { body: { user_id: TARGET } });
    expect(res.status).toBe(401);
    expect((await body(res)).error).toMatch(/not signed in/i);
  });

  it('2. rejects ordinary authenticated users with 403', async () => {
    const res = await call('POST', { token: 'tok-user', body: { user_id: TARGET } });
    expect(res.status).toBe(403);
    expect((await body(res)).error).toMatch(/administrator/i);
    expect(f.calls.gh.length).toBe(0);        // nothing ran
    expect(f.calls.rpc.length).toBe(0);
    expect(f.calls.authDeletes.length).toBe(0);
  });

  it('3. rejects the admin deleting their own account with 400', async () => {
    const res = await call('POST', { token: 'tok-admin', body: { user_id: ADMIN } });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatch(/cannot delete itself/i);
  });

  it('4. rejects invalid target UUIDs with 400', async () => {
    for (const bad of ['', 'not-a-uuid', '123', '33333333-3333-4333-8333-33333333333g', '../../../etc']) {
      const res = await call('POST', { token: 'tok-admin', body: { user_id: bad } });
      expect(res.status, 'target=' + JSON.stringify(bad)).toBe(400);
    }
  });

  it('403 even when the browser claims isAdmin (server never trusts it)', async () => {
    const res = await call('POST', { token: 'tok-user', body: { user_id: TARGET, isAdmin: true, admin: true } });
    expect(res.status).toBe(403);
  });

  it('403 when ADMIN_USER_ID is not configured (500 setup error instead)', async () => {
    const envBackup = ENV.ADMIN_USER_ID;
    ENV.ADMIN_USER_ID = '';
    const res = await call('GET', { token: 'tok-admin' });
    expect(res.status).toBe(500);
    ENV.ADMIN_USER_ID = envBackup;
  });
});

/* ================= 5: happy path ================= */
describe('successful deletion', () => {
  it('5. deletes GitHub files, storage, DB rows and the auth account — in order', async () => {
    seedTargetLibrary(2);

    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(200);
    const d = await body(res);
    expect(d.done).toBe(true);
    expect(d.stage).toBe('complete');
    expect(d.email).toBe('leaver@example.test');
    expect(d.stages).toEqual({ github: true, storage: true, database: true, auth: true });

    // GitHub: both of the target's files gone
    expect(f.gh.files.has(`songs/${TARGET}/170000000000-sample-track-1.mp3`)).toBe(false);
    expect(f.gh.files.has(`songs/${TARGET}/170000000001-sample-track-2.mp3`)).toBe(false);

    // Storage: every FILE under song-staging/<target>/ gone, other users kept
    expect(f.calls.storageRemove.length).toBeGreaterThan(0);
    const removed = f.calls.storageRemove.flat();
    expect(removed).toContain(`${TARGET}/leftover-upload.mp3`);
    expect(removed).toContain(`${TARGET}/nested/top.mp3`);
    expect(removed).toContain(`${TARGET}/nested/deeper/song.mp3`);
    const filesLeft = (node) => Object.entries(node ?? {}).flatMap(([k, v]) =>
      v && typeof v === 'object' ? filesLeft(v) : [k]);
    expect(filesLeft(f.storageTree['song-staging'][TARGET])).toEqual([]);   // empty folders are a mock artifact
    expect(filesLeft(f.storageTree['song-staging'][USER2])).toEqual(['keep-me.mp3']);

    // DB: rows removed via the RPC with the right argument
    expect(f.calls.rpc).toEqual([{ name: 'delete_user_data', params: { p_target: TARGET } }]);
    expect(f.songs.filter((s) => s.user_id === TARGET)).toHaveLength(0);
    expect(f.playlists.filter((p) => p.user_id === TARGET)).toHaveLength(0);

    // Auth: exactly one delete call, for the target
    expect(f.calls.authDeletes).toEqual([TARGET]);
    expect(f.authUsers.has(TARGET)).toBe(false);
    expect(f.authUsers.has(ADMIN)).toBe(true);
  });

  it('GET lists users with counts and marks the admin', async () => {
    seedTargetLibrary(2);
    const res = await call('GET', { token: 'tok-admin' });
    expect(res.status).toBe(200);
    const d = await body(res);
    expect(d.users).toHaveLength(3);
    const admin = d.users.find((u) => u.id === ADMIN);
    const target = d.users.find((u) => u.id === TARGET);
    const member = d.users.find((u) => u.id === USER2);
    expect(admin.is_admin).toBe(true);
    expect(admin.song_count).toBe(0);
    expect(target.song_count).toBe(2);
    expect(target.playlist_count).toBe(1);
    expect(member.is_admin).toBe(false);
    expect(member.song_count).toBe(0); // no shared rows in this fixture
  });

  it('GET is refused for ordinary users (403) and unauthenticated (401)', async () => {
    expect((await call('GET', { token: 'tok-user' })).status).toBe(403);
    expect((await call('GET', {})).status).toBe(401);
  });
});

/* ================= 6–8: stage failures stop the pipeline ================= */
describe('stage failures', () => {
  it('6. GitHub file delete failure -> database and Auth are NOT touched', async () => {
    seedTargetLibrary(2);
    f.gh.failMethod = 'DELETE';
    f.gh.failStatus = 500;

    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(502);
    const d = await body(res);
    expect(d.stage).toBe('github');
    expect(d.done).toBe(false);

    expect(f.calls.rpc.length).toBe(0);
    expect(f.calls.authDeletes.length).toBe(0);
    expect(f.songs.filter((s) => s.user_id === TARGET)).toHaveLength(2);
    expect(f.authUsers.has(TARGET)).toBe(true);
  });

  it('7. Storage deletion failure -> database and Auth are NOT touched', async () => {
    seedTargetLibrary(2);
    f.errors.storageRemove = 'simulated storage failure';

    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(502);
    const d = await body(res);
    expect(d.stage).toBe('storage');

    expect(f.calls.rpc.length).toBe(0);
    expect(f.calls.authDeletes.length).toBe(0);
    // GitHub already cleaned (stage order), that is expected & safe
    expect(f.gh.files.size).toBe(0);
  });

  it('8. Database cleanup failure -> Auth deletion does NOT proceed', async () => {
    seedTargetLibrary(2);
    f.errors.rpc = 'simulated rpc failure';

    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(500);
    const d = await body(res);
    expect(d.stage).toBe('database');
    expect(d.done).toBe(false);

    expect(f.calls.authDeletes.length).toBe(0);
    expect(f.authUsers.has(TARGET)).toBe(true);
  });
});

/* ================= 9: auth failure + safe retry ================= */
describe('auth stage', () => {
  it('9. Auth deletion failure -> retry finishes the job safely', async () => {
    seedTargetLibrary(2);
    f.errors.authDelete = 'simulated auth admin failure';

    const first = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(first.status).toBe(500);
    const d1 = await body(first);
    expect(d1.stage).toBe('auth');
    expect(d1.done).toBe(false);

    // everything EXCEPT auth was cleaned
    expect(f.gh.files.size).toBe(0);
    expect(f.songs.filter((s) => s.user_id === TARGET)).toHaveLength(0);
    expect(f.authUsers.has(TARGET)).toBe(true);   // account still there

    // retry: stages 1-3 are no-ops now, auth succeeds
    f.errors.authDelete = null;
    const second = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(second.status).toBe(200);
    const d2 = await body(second);
    expect(d2.done).toBe(true);
    expect(f.calls.authDeletes).toEqual([TARGET, TARGET]);
    expect(f.authUsers.has(TARGET)).toBe(false);
  });

  it('an already-deleted auth account (user vanished) still completes cleanly', async () => {
    seedTargetLibrary(1);
    f.authUsers.delete(TARGET); // account gone beforehand
    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(200);
    const d = await body(res);
    expect(d.done).toBe(true);
  });
});

/* ================= 10–12: idempotency & shapes ================= */
describe('idempotency and edge shapes', () => {
  it('10. already-missing GitHub files count as cleaned and succeed', async () => {
    seedTargetLibrary(2, { ghPresent: false }); // files never existed on GitHub
    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(200);
    expect((await body(res)).done).toBe(true);
  });

  it('a full retry after success is a clean no-op', async () => {
    seedTargetLibrary(2);
    await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    const again = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(again.status).toBe(200);
    expect((await body(again)).done).toBe(true);
    // the account is already gone — the auth-admin delete is NOT called again
    expect(f.calls.authDeletes).toEqual([TARGET]);
  });

  it('11. a user with no songs or playlists deletes cleanly', async () => {
    f.storageTree['song-staging'] = { [TARGET]: {} };
    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(200);
    const d = await body(res);
    expect(d.done).toBe(true);
    expect(d.summary).toEqual({
      links_own_deleted: 0, links_other_deleted: 0, playlists_deleted: 0, songs_deleted: 0,
    });
  });

  it('12. nested Storage folders are enumerated recursively and removed', async () => {
    f.storageTree['song-staging'] = {
      [TARGET]: {
        'a.mp3': 0,
        'lvl1': { 'b.mp3': 0, 'lvl2': { 'lvl3': { 'c.mp3': 0 } } },
      },
    };
    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(200);
    const removed = f.calls.storageRemove.flat();
    expect(removed.sort()).toEqual([
      `${TARGET}/a.mp3`,
      `${TARGET}/lvl1/b.mp3`,
      `${TARGET}/lvl1/lvl2/lvl3/c.mp3`,
    ].sort());
  });
});

/* ================= 13: shared data ================= */
describe('shared files and playlists', () => {
  it('13. skips a GitHub file referenced by another user; removes only link rows from other playlists', async () => {
    seedTargetLibrary(2, { sharedWithUser2: true });

    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(200);
    expect((await body(res)).done).toBe(true);

    // the SHARED file stays on GitHub; the uniquely-owned one is gone
    expect(f.gh.files.has(`songs/${TARGET}/170000000000-sample-track-1.mp3`)).toBe(true);
    expect(f.gh.files.has(`songs/${TARGET}/170000000001-sample-track-2.mp3`)).toBe(false);

    // other user's playlist and song row survive; the link to the deleted song is gone
    const pl2 = f.playlists.find((p) => p.id === 'pl-2');
    expect(pl2.user_id).toBe(USER2);
    expect(f.playlistSongs.filter((l) => l.playlist_id === 'pl-2')).toHaveLength(0);
    expect(f.songs.find((s) => s.id === 'u2-shared-0')).toBeTruthy();
    // the target's own playlist is gone
    expect(f.playlists.find((p) => p.id === 'pl-1')).toBeUndefined();
  });
});

/* ================= 14: concurrency ================= */
describe('concurrency', () => {
  it('14. a second deletion for the same account is rejected with 409', async () => {
    // simulate an in-flight deletion (same isolate guard)
    globalThis.__om_del.add(TARGET);
    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(409);
    const d = await body(res);
    expect(d.stage).toBe('concurrency');
    expect(f.calls.authDeletes.length).toBe(0);
    globalThis.__om_del.delete(TARGET);
  });
});

/* ================= 15: batching / resumability ================= */
describe('resumable batches', () => {
  it('15. 45 songs -> bounded batch + cursor; the retry continues from the cursor and finishes', async () => {
    // 45 songs, all present on GitHub
    for (let i = 0; i < 45; i++) {
      const fp = `songs/${TARGET}/1700000000${String(i).padStart(2, '0')}-sample-track-${i}.mp3`;
      f.gh.files.add(fp);
      f.songs.push({
        id: `t-${i}`, user_id: TARGET, title: `Sample Track ${i}`, artist: 'The Neighbours',
        album: null, duration_sec: 100, file_path: fp, file_size: 1, created_at: '2026-05-01',
      });
    }

    const first = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    const d1 = await body(first);
    expect(first.status).toBe(200);
    expect(d1.done).toBe(false);
    expect(d1.stage).toBe('github');
    expect(d1.cursor).toBe(40);                 // BATCH = 40 real deletes
    expect(d1.progress.files_total).toBe(45);
    expect(d1.progress.files_done).toBe(40);
    expect(d1.progress.files_remaining).toBe(5);
    // auth NOT deleted mid-run
    expect(f.calls.authDeletes.length).toBe(0);
    expect(f.authUsers.has(TARGET)).toBe(true);

    // the client passes the cursor back — the run resumes at file 40
    const second = await call('POST', { token: 'tok-admin', body: { user_id: TARGET, cursor: d1.cursor } });
    const d2 = await body(second);
    expect(d2.done).toBe(true);
    expect(f.gh.files.size).toBe(0);
    expect(f.calls.authDeletes).toEqual([TARGET]);
    expect(f.songs.filter((s) => s.user_id === TARGET)).toHaveLength(0);
  });

  it('a malicious/invalid cursor is clamped safely', async () => {
    for (let i = 0; i < 3; i++) {
      const fp = `songs/${TARGET}/1700000000${i}-sample-track-${i}.mp3`;
      f.gh.files.add(fp);
      f.songs.push({ id: `t-${i}`, user_id: TARGET, title: `Sample Track ${i}`, artist: null, album: null, duration_sec: 1, file_path: fp, file_size: 1, created_at: '2026-05-01' });
    }
    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET, cursor: -5 } });
    expect(res.status).toBe(200);
    expect((await body(res)).done).toBe(true);
    expect(f.gh.files.size).toBe(0);
  });
});

/* ================= extra: security hardening ================= */
describe('path validation', () => {
  it('aborts when a song row has a file_path outside songs/<target>/', async () => {
    f.songs.push({
      id: 'evil-1', user_id: TARGET, title: 'Bad row', artist: null, album: null,
      duration_sec: 1, file_path: 'songs/../../etc/passwd', file_size: 1, created_at: '2026-05-01',
    });
    f.gh.files.add('songs/../../etc/passwd');
    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(500);
    const d = await body(res);
    expect(d.stage).toBe('github-path');
    expect(d.error).toMatch(/left untouched/i);
    // nothing was deleted at all
    expect(f.gh.files.has('songs/../../etc/passwd')).toBe(true);
    expect(f.calls.authDeletes.length).toBe(0);
  });

  it('rejects paths pointing at another user folder', async () => {
    f.songs.push({
      id: 'evil-2', user_id: TARGET, title: 'Not mine', artist: null, album: null,
      duration_sec: 1, file_path: `songs/${USER2}/170000000000-theirs.mp3`, file_size: 1, created_at: '2026-05-01',
    });
    f.gh.files.add(`songs/${USER2}/170000000000-theirs.mp3`);
    const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET } });
    expect(res.status).toBe(500);
    expect(f.gh.files.has(`songs/${USER2}/170000000000-theirs.mp3`)).toBe(true);
  });
});

describe('rate limiting', () => {
  it('POSTs are rate limited after 4 attempts per hour', async () => {
    f.storageTree['song-staging'] = {};
    for (let i = 0; i < 4; i++) {
      const res = await call('POST', { token: 'tok-admin', body: { user_id: TARGET }, keepLimit: true });
      expect(res.status).toBe(200);
      f.authUsers.set(TARGET, { id: TARGET, email: 'leaver@example.test' }); // re-create for next round
    }
    const fifth = await call('POST', { token: 'tok-admin', body: { user_id: TARGET }, keepLimit: true });
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get('Retry-After')).toBeTruthy();
  });

  it('GET listing is rate limited after 10 per minute', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call('GET', { token: 'tok-admin', keepLimit: true })).status).toBe(200);
    }
    expect((await call('GET', { token: 'tok-admin', keepLimit: true })).status).toBe(429);
  });
});
