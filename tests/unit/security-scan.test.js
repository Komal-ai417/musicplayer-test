/* Source-level security & correctness invariants.
   These read the SHIPPED files and assert the guards are present —
   they fail the build if someone removes a revoke, leaks a secret,
   or makes the service worker cache private responses. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

/* strip SQL line comments and JS comments so tests assert on CODE,
   not on documentation prose */
const stripSqlComments = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const stripJsComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');

/* ---------- SQL migration security ---------- */
describe('SQL migrations', () => {
  const delSql = read('../../supabase/migrations/20261109000001_admin_delete_user.sql');

  it('delete_user_data is SECURITY DEFINER', () => {
    expect(delSql).toMatch(/security\s+definer/i);
  });

  it('EXECUTE is revoked from public / anon / authenticated and granted ONLY to service_role', () => {
    expect(delSql).toMatch(/revoke\s+execute\s+on\s+function\s+public\.delete_user_data\(uuid\)\s+from\s+public/i);
    expect(delSql).toMatch(/revoke\s+execute\s+on\s+function\s+public\.delete_user_data\(uuid\)\s+from\s+anon/i);
    expect(delSql).toMatch(/revoke\s+execute\s+on\s+function\s+public\.delete_user_data\(uuid\)\s+from\s+authenticated/i);
    expect(delSql).toMatch(/grant\s+execute\s+on\s+function\s+public\.delete_user_data\(uuid\)\s+to\s+service_role/i);
  });

  it('concurrent deletions are serialized with an advisory lock', () => {
    expect(delSql).toMatch(/pg_advisory_xact_lock/i);
  });

  it('deletes in the required order: links -> playlists -> songs (FK-safe)', () => {
    const iLink = delSql.indexOf('delete from public.playlist_songs');
    const iPl = delSql.indexOf('delete from public.playlists');
    const iSong = delSql.indexOf('delete from public.songs');
    expect(iLink).toBeGreaterThanOrEqual(0);
    expect(iPl).toBeGreaterThan(iLink);
    expect(iSong).toBeGreaterThan(iPl);
  });

  it('other users\' playlists are never deleted (only link rows)', () => {
    const code = stripSqlComments(delSql);
    // every playlist_songs delete; the 2nd one must target the
    // target's SONGS, never other users' playlists
    const linkDeletes = code.match(/delete from public\.playlist_songs[^;]+;/g) ?? [];
    expect(linkDeletes.length).toBe(2);
    expect(linkDeletes[1]).toMatch(/song_id in \(select id from public\.songs where user_id = p_target\)/);
    expect(linkDeletes[1]).not.toMatch(/delete from public\.playlists/);
    // playlists delete targets ONLY the target's rows
    const plDelete = code.match(/delete from public\.playlists[^;]+;/g) ?? [];
    expect(plDelete).toHaveLength(1);
    expect(plDelete[0]).toMatch(/where user_id = p_target/);
  });

  it('never touches auth.users, storage.objects or GitHub from SQL', () => {
    const code = stripSqlComments(delSql);
    expect(code).not.toMatch(/auth\.users/);
    expect(code).not.toMatch(/storage\.objects/);
    expect(code).not.toMatch(/github/i);
  });

  it('the lyrics migration adds the column idempotently', () => {
    const sql = read('../../supabase/migrations/20261109000000_add_lyrics.sql');
    expect(sql).toMatch(/alter\s+table\s+public\.songs\s+add\s+column\s+if\s+not\s+exists\s+lyrics\s+text/i);
  });
});

/* ---------- delete-user Edge Function security ---------- */
describe('delete-user Edge Function', () => {
  const src = read('../../supabase/functions/delete-user/index.ts');

  it('checks the ADMIN_USER_ID secret server-side', () => {
    expect(src).toMatch(/ADMIN_USER_ID/);
    expect(src).toMatch(/403/);
    expect(src).toMatch(/401/);
  });

  it('rejects invalid UUIDs and self-deletion with 400', () => {
    expect(src).toMatch(/Invalid target user id/);
    expect(src).toMatch(/cannot delete itself/);
  });

  it('deletes the auth account only AFTER github/storage/database stages', () => {
    const gh = src.indexOf('STAGE 1: GitHub');
    const st = src.indexOf('STAGE 2: Storage');
    const db = src.indexOf('STAGE 3: database');
    const au = src.indexOf('STAGE 4: auth');
    expect(gh).toBeGreaterThan(-1);
    expect(st).toBeGreaterThan(gh);
    expect(db).toBeGreaterThan(st);
    expect(au).toBeGreaterThan(db);
  });

  it('validates file paths before touching GitHub', () => {
    expect(src).toMatch(/safeSongPath/);
    expect(src).toMatch(/\.\./);
  });

  it('never logs tokens or secrets', () => {
    expect(src).not.toMatch(/console\.(log|info|debug|error)/);
  });

  it('uses the admin Auth API (never the browser path)', () => {
    expect(src).toMatch(/auth\.admin\.deleteUser/);
  });
});

/* ---------- frontend secret hygiene ---------- */
describe('frontend hygiene', () => {
  const docs = readdirSync(fileURLToPath(new URL('../../docs', import.meta.url)))
    .filter((f) => f.endsWith('.js'));

  it('no service-role key or admin secret ever appears in shipped JS', () => {
    for (const file of docs) {
      const src = stripJsComments(read('../../docs/' + file));
      expect(src, file).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/i);
      expect(src, file).not.toMatch(/service_role/i);
      expect(src, file).not.toMatch(/ADMIN_USER_ID/);
      expect(src, file).not.toMatch(/GITHUB_TOKEN/);
    }
  });

  it('frontend never calls GitHub APIs directly', () => {
    for (const file of docs) {
      const src = read('../../docs/' + file);
      expect(src, file).not.toMatch(/api\.github\.com/);
      expect(src, file).not.toMatch(/raw\.githubusercontent\.com/);
    }
  });
});

/* ---------- PWA / service worker ---------- */
describe('service worker', () => {
  const sw = read('../../docs/sw.js');

  it('never caches or intercepts private backend traffic', () => {
    expect(sw).toMatch(/\/functions\//);
    expect(sw).toMatch(/\/storage\//);
    expect(sw).toMatch(/\/auth\//);
    // the guard must come BEFORE any respondWith for those paths
    const guardIdx = sw.indexOf("url.pathname.includes('/functions/')");
    const respondIdx = sw.indexOf('e.respondWith(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(respondIdx);
  });

  it('caches only GET requests', () => {
    expect(sw).toMatch(/req\.method\s*!==\s*'GET'/);
  });

  it('index.html references the manifest, icons and every script', () => {
    const html = read('../../docs/index.html');
    for (const needle of [
      'manifest.webmanifest', 'icon-192.png',
      './om-core.js', './equalizer.js', './lyrics.js', './sort.js', './browse.js', './admin.js',
    ]) {
      expect(html).toContain(needle);
    }
    // app.js registers the service worker
    expect(read('../../docs/app.js')).toMatch(/serviceWorker/);
    expect(existsSync(fileURLToPath(new URL('../../docs/icon-512.png', import.meta.url)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL('../../docs/icon-512-maskable.png', import.meta.url)))).toBe(true);
  });

  it('429 responses get a friendly message', () => {
    expect(read('../../docs/functions.js')).toMatch(/429/);
  });
});

/* ---------- rate limiting present in every Edge Function ---------- */
describe('Edge Function rate limits', () => {
  for (const fn of ['songs', 'upload-song', 'playlists', 'stream', 'delete-user']) {
    it(`${fn} implements a rate limit and returns 429`, () => {
      const src = read(`../../supabase/functions/${fn}/index.ts`);
      expect(src).toMatch(/rateLimit|rlStore/);
      expect(src).toMatch(/429/);
      expect(src).toMatch(/Retry-After/);
    });
  }
});
