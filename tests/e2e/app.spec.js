/* ============================================================
   End-to-end tests: the REAL frontend against the MOCKED backend
   (tests/e2e/server.mjs). Non-destructive — no real accounts,
   repos or buckets are touched. Fixture names are intentionally
   generic, non-copyrighted titles.
   ============================================================ */
import { test, expect } from '@playwright/test';

const SUPA_CDN = 'node_modules/@supabase/supabase-js/dist/umd/supabase.js';
const TAGS_CDN = 'node_modules/jsmediatags/dist/jsmediatags.min.js';

test.beforeEach(async ({ context }) => {
  // vendor the CDN scripts locally so tests never need the internet
  await context.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js@2/**', (r) =>
    r.fulfill({ path: SUPA_CDN, contentType: 'text/javascript' }));
  await context.route('**/cdn.jsdelivr.net/npm/jsmediatags@3.9.7/**', (r) =>
    r.fulfill({ path: TAGS_CDN, contentType: 'text/javascript' }));
  // fresh scenario state
  await context.request.put('/__test/state', { data: { deleteScenario: 'ok', failSongsOnce: false } });
});

async function login(page, email, expectedSongs = 4) {
  await page.goto('/');
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'family-code');
  await page.click('#login-btn');
  await expect(page.locator('#app-screen')).toBeVisible({ timeout: 15_000 });
  if (expectedSongs > 0) {
    await expect(page.locator('#song-list .song-row')).toHaveCount(expectedSongs, { timeout: 15_000 });
  } else {
    await expect(page.locator('#loading-state')).toBeHidden({ timeout: 15_000 });
  }
}

test('library renders and playback works through the mocked stream', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await login(page, 'member@example.test');

  // default sort: recently added first
  const titles = await page.locator('#song-list .c-title b').allTextContents();
  expect(titles[0]).toBe('Track 04');

  // click a song: signed playback link fetched from the songs function
  await page.locator('#song-list .song-row', { hasText: 'Morning Walk' }).click();
  await expect
    .poll(() => page.evaluate(() => document.getElementById('audio').src), { timeout: 15_000 })
    .toContain('/functions/v1/stream?');
  await expect
    .poll(() => page.evaluate(() => document.getElementById('audio').duration), { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('sorting: title A-Z re-orders the library', async ({ page }) => {
  await login(page, 'member@example.test');
  await page.click('.sort-btn');
  await page.locator('.menu li', { hasText: 'Title A–Z' }).click();
  const titles = await page.locator('#song-list .c-title b').allTextContents();
  expect(titles).toEqual(['Kitchen Jam', 'Morning Walk', 'Rainy Window', 'Track 04']);
  // persisted
  expect(await page.evaluate(() => localStorage.getItem('om-sort'))).toContain('"key":"title"');
});

test('lyrics: synced panel, click-to-seek, and saving edits', async ({ page }) => {
  await login(page, 'member@example.test');
  await page.locator('#song-list .song-row', { hasText: 'Morning Walk' }).click();
  await expect
    .poll(() => page.evaluate(() => document.getElementById('audio').duration), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await page.click('#btn-lyrics');
  await expect(page.locator('#lyrics-panel')).toBeVisible();
  await expect(page.locator('#lyrics-panel .lyrics-line')).toHaveCount(5);
  await expect(page.locator('.lp-title')).toHaveText('Morning Walk');

  // click the third line ([00:05.00]) -> audio seeks to ~5s
  await page.locator('#lyrics-panel .lyrics-line').nth(2).click();
  await expect
    .poll(() => page.evaluate(() => document.getElementById('audio').currentTime), { timeout: 10_000 })
    .toBeGreaterThan(4);

  // active line gets highlighted as time passes
  await page.evaluate(() => { document.getElementById('audio').currentTime = 9.2; });
  await expect(page.locator('#lyrics-panel .lyrics-line.active')).toHaveText('Fifth morning line');

  // edit + save -> server records the op, panel updates
  await page.click('.lp-edit');
  await page.fill('#modal-card textarea', '[00:01.00]edited line one\n[00:02.00]edited line two');
  await page.click('#modal-card button:has-text("Save")');
  await expect(page.locator('#lyrics-panel .lyrics-line')).toHaveCount(2);
  const calls = await (await page.request.get('/__test/calls')).json();
  expect(calls.songOps).toContain('save-lyrics');
});

test('equalizer: panel, toggle, sliders persist', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await login(page, 'member@example.test');

  await page.click('#btn-eq');
  await expect(page.locator('#eq-panel')).toBeVisible();
  // 10 band sliders + preamp
  await expect(page.locator('#eq-panel .eq-band input[type=range]')).toHaveCount(10);

  await page.click('.eq-toggle');
  await expect(page.locator('.eq-toggle.on')).toBeVisible();

  // move the 31 Hz band to +6 dB
  const band = page.locator('#eq-panel .eq-band input[type=range]').first();
  await band.fill('6');
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('om-eq')));
  expect(saved.on).toBe(true);
  expect(saved.gains[0]).toBe(6);

  // preset select works
  await page.selectOption('#eq-panel select', 'bass');
  const saved2 = JSON.parse(await page.evaluate(() => localStorage.getItem('om-eq')));
  expect(saved2.preset).toBe('bass');
  expect(saved2.gains[0]).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('browse: artist and album pages', async ({ page }) => {
  await login(page, 'member@example.test');

  await page.click('#nav-artists');
  await expect(page.locator('#view-title')).toHaveText('Artists');
  await expect(page.locator('.tile')).toHaveCount(3); // The Neighbours, Home Recordings, Unknown artist
  await page.locator('.tile', { hasText: 'The Neighbours' }).click();
  await expect(page.locator('#view-title')).toHaveText('The Neighbours');
  await expect(page.locator('#song-list .song-row')).toHaveCount(2);

  await page.click('#nav-albums');
  await expect(page.locator('#view-title')).toHaveText('Albums');
  await expect(page.locator('.tile')).toHaveCount(1); // Home Sessions
  await page.locator('.tile', { hasText: 'Home Sessions' }).click();
  await expect(page.locator('#song-list .song-row')).toHaveCount(2);
});

test('admin hidden for ordinary users, visible for the admin', async ({ page }) => {
  await login(page, 'member@example.test');
  await expect(page.locator('#nav-users')).toBeHidden();

  await page.click('#btn-logout');
  await expect(page.locator('#auth-screen')).toBeVisible({ timeout: 15_000 });
  await login(page, 'organizer@example.test', 0);
  await expect(page.locator('#nav-users')).toBeVisible({ timeout: 15_000 });
});

test('admin: staged deletion with progress, then success and list refresh', async ({ page }) => {
  await login(page, 'organizer@example.test', 0);
  await page.click('#nav-users');
  await expect(page.locator('.admin-row:not(.head)')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.locator('.admin-row', { hasText: 'organizer@example.test' }).locator('.badge')).toBeVisible();

  // staged scenario: first POST reports partial progress, second finishes
  await page.request.put('/__test/state', { data: { deleteScenario: 'staged' } });

  // capture every progress-note state (some flash too briefly to poll)
  await page.evaluate(() => {
    window.__delSnapshots = [];
    const card = document.getElementById('modal-card');
    const obs = new MutationObserver(() => window.__delSnapshots.push(card.textContent));
    obs.observe(card, { childList: true, characterData: true, subtree: true });
  });

  await page.locator('.admin-row', { hasText: 'leaver@example.test' }).locator('button:has-text("Delete")').click();
  await expect(page.locator('#modal-card')).toContainText('leaver@example.test');
  await page.click('#modal-card button:has-text("Delete leaver@example.test")');

  // completion toast + closed modal
  await expect(page.locator('#toasts .toast').last()).toContainText('Deleted', { timeout: 15_000 });

  // the progress UI really showed the partial batch before finishing
  const snaps = await page.evaluate(() => window.__delSnapshots);
  expect(snaps.some((s) => s.includes('1 of 2'))).toBe(true);
  expect(snaps.some((s) => s.includes('Done'))).toBe(true);

  // exactly two POSTs, the second carrying the cursor
  const calls = await (await page.request.get('/__test/calls')).json();
  expect(calls.deleteCalls).toHaveLength(2);
  expect(calls.deleteCalls[0].cursor).toBe(0);       // fresh run starts at 0
  expect(calls.deleteCalls[1].cursor).toBe(1);       // resumed from the reported cursor
  // user list refreshed after completion
  expect(calls.deleteGets).toBeGreaterThanOrEqual(2);
});

test('admin: failed stage surfaces the failing stage name', async ({ page }) => {
  await login(page, 'organizer@example.test', 0);
  await page.click('#nav-users');
  await expect(page.locator('.admin-row:not(.head)')).toHaveCount(3, { timeout: 15_000 });

  await page.request.put('/__test/state', { data: { deleteScenario: 'fail-github' } });
  await page.locator('.admin-row', { hasText: 'leaver@example.test' }).locator('button:has-text("Delete")').click();
  await page.click('#modal-card button:has-text("Delete leaver@example.test")');

  await expect(page.locator('#toasts .toast.error').last()).toContainText('github', { timeout: 15_000 });
});

test('429 from the server becomes a friendly error screen', async ({ page }) => {
  await page.request.put('/__test/state', { data: { failSongsOnce: true } });
  await page.goto('/');
  await page.fill('#login-email', 'member@example.test');
  await page.fill('#login-password', 'family-code');
  await page.click('#login-btn');
  await expect(page.locator('#error-state')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#error-msg')).toContainText('Too many requests');
});

test('PWA: manifest served and the service worker registers', async ({ page }) => {
  const res = await page.request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('manifest+json');
  const mf = await res.json();
  expect(mf.icons).toHaveLength(3);

  await login(page, 'member@example.test');
  const sw = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.active.scriptURL));
  expect(sw).toContain('sw.js');
});
