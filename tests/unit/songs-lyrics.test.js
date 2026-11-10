/* songs Edge Function — lyrics ops, rate limiting, ownership.
   Non-destructive: the real function code runs against the mocked
   client (tests/mocks/supabase-js.js via the vitest alias). */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  createFixture, ghFetchFactory, installDeno, importFunction, resetRateLimiters, makeRequest,
} from './helpers/sb-mock.js';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const USER2 = '22222222-2222-4222-8222-222222222222';

const ENV = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  STREAM_SIGNING_SECRET: 'test-signing-secret',
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
  globalThis.fetch = ghFetchFactory(f);
  handler = await importFunction('supabase/functions/songs/index.ts');
});

beforeEach(() => {
  resetRateLimiters();
  f.authUsers.clear();
  f.tokens.clear();
  f.songs = [];
  f.playlists = [];
  f.playlistSongs = [];
  f.calls.gh.length = 0;
  f.calls.authDeletes.length = 0;
  Object.assign(f.errors, { rpc: null, storageRemove: null, storageList: null, authDelete: null, listUsers: null });
  f.gh.files.clear();
  f.gh.failMethod = null;
  f.gh.failStatus = 0;

  f.authUsers.set(USER2, { id: USER2, email: 'member@example.test' });
  f.tokens.set('tok-user', USER2);
  f.tokens.set('tok-admin', ADMIN);

  f.songs.push({
    id: 's-own-1', user_id: USER2, title: 'Morning Walk', artist: 'The Neighbours',
    album: 'Home Sessions', duration_sec: 180, file_path: `songs/${USER2}/170000000000-morning-walk.mp3`,
    file_size: 1000, cover_data: null, lyrics: '[00:05.00]hello\n[00:09.00]world', created_at: '2026-05-01',
  });
  f.songs.push({
    id: 's-other-1', user_id: ADMIN, title: 'Someone Elses Recording', artist: 'The Others',
    album: null, duration_sec: 60, file_path: `songs/${ADMIN}/170000000000-theirs.mp3`,
    file_size: 1000, cover_data: null, lyrics: 'private lyrics of another user', created_at: '2026-05-02',
  });
  f.appConfig = { id: 1, invite_code: 'X', max_songs_per_user: 200, max_upload_mb: 20 };
});

const call = (method, opts = {}) => {
  if (!opts.keepLimit) resetRateLimiters();
  return handler(makeRequest(method, opts));
};

describe('songs: GET list', () => {
  it('returns own songs with limits and WITHOUT the lyrics column (lazy load)', async () => {
    const res = await call('GET', { token: 'tok-user' });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.songs).toHaveLength(1);
    expect(d.songs[0].title).toBe('Morning Walk');
    expect(d.songs[0].lyrics).toBeUndefined();     // not shipped in the library list
    expect(d.cfg.max_songs_per_user).toBe(200);
  });

  it('401 when not signed in', async () => {
    expect((await call('GET', {})).status).toBe(401);
  });
});

describe('songs: get-lyrics / save-lyrics', () => {
  it('returns the lyrics of an OWN song', async () => {
    const res = await call('POST', { token: 'tok-user', body: { op: 'get-lyrics', id: 's-own-1' } });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.id).toBe('s-own-1');
    expect(d.lyrics).toContain('[00:05.00]hello');
  });

  it('404 for ANOTHER user\'s song (ownership enforced server-side)', async () => {
    const res = await call('POST', { token: 'tok-user', body: { op: 'get-lyrics', id: 's-other-1' } });
    expect(res.status).toBe(404);
    const res2 = await call('POST', { token: 'tok-user', body: { op: 'save-lyrics', id: 's-other-1', lyrics: 'hijack' } });
    expect(res2.status).toBe(404);
    // the other user's lyrics were untouched
    expect(f.songs.find((s) => s.id === 's-other-1').lyrics).toBe('private lyrics of another user');
  });

  it('saves lyrics for an own song and round-trips', async () => {
    const res = await call('POST', { token: 'tok-user', body: { op: 'save-lyrics', id: 's-own-1', lyrics: '[00:01.00]new\n[00:02.00]words' } });
    expect(res.status).toBe(200);
    expect(f.songs.find((s) => s.id === 's-own-1').lyrics).toContain('new');
    const get = await call('POST', { token: 'tok-user', body: { op: 'get-lyrics', id: 's-own-1' } });
    expect((await get.json()).lyrics).toContain('[00:02.00]words');
  });

  it('saving an empty string clears lyrics (null in the DB)', async () => {
    await call('POST', { token: 'tok-user', body: { op: 'save-lyrics', id: 's-own-1', lyrics: '' } });
    expect(f.songs.find((s) => s.id === 's-own-1').lyrics).toBeNull();
  });

  it('rejects control characters with 400', async () => {
    const res = await call('POST', { token: 'tok-user', body: { op: 'save-lyrics', id: 's-own-1', lyrics: 'bad\u0003chars' } });
    expect(res.status).toBe(400);
  });

  it('caps lyric length at 100k characters', async () => {
    await call('POST', { token: 'tok-user', body: { op: 'save-lyrics', id: 's-own-1', lyrics: 'x'.repeat(150000) } });
    expect(f.songs.find((s) => s.id === 's-own-1').lyrics.length).toBe(100000);
  });

  it('unknown op -> 400', async () => {
    expect((await call('POST', { token: 'tok-user', body: { op: 'nope' } })).status).toBe(400);
  });
});

describe('songs: delete op regression', () => {
  it('still deletes an own song (GitHub + row)', async () => {
    f.gh.files.add(`songs/${USER2}/170000000000-morning-walk.mp3`);
    const res = await call('POST', { token: 'tok-user', body: { op: 'delete', id: 's-own-1' } });
    expect(res.status).toBe(200);
    expect(f.gh.files.size).toBe(0);
    expect(f.songs.find((s) => s.id === 's-own-1')).toBeUndefined();
  });

  it('cannot delete another user\'s song', async () => {
    f.gh.files.add(`songs/${ADMIN}/170000000000-theirs.mp3`);
    const res = await call('POST', { token: 'tok-user', body: { op: 'delete', id: 's-other-1' } });
    expect(res.status).toBe(404);
    expect(f.gh.files.size).toBe(1);
  });
});

describe('songs: rate limiting', () => {
  it('429 after 120 requests in a minute', async () => {
    for (let i = 0; i < 120; i++) {
      const r = await call('GET', { token: 'tok-user', keepLimit: true });
      if (r.status !== 200) throw new Error('unexpected early limit at ' + i);
    }
    const blocked = await call('GET', { token: 'tok-user', keepLimit: true });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });
});
