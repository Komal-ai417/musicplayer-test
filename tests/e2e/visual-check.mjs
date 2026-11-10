/* Visual check: screenshot every major UI state against the mock
   server. Output: /tmp/om-shots/*.jpeg (small, for review). */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = '/tmp/om-shots';
mkdirSync(OUT, { recursive: true });

const SUPA_CDN = 'node_modules/@supabase/supabase-js/dist/umd/supabase.js';
const TAGS_CDN = 'node_modules/jsmediatags/dist/jsmediatags.min.js';

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

async function newPage(width = 1280, height = 800) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js@2/**', (r) =>
    r.fulfill({ path: SUPA_CDN, contentType: 'text/javascript' }));
  await ctx.route('**/cdn.jsdelivr.net/npm/jsmediatags@3.9.7/**', (r) =>
    r.fulfill({ path: TAGS_CDN, contentType: 'text/javascript' }));
  await ctx.request.put('http://localhost:4173/__test/state', { data: { deleteScenario: 'ok', failSongsOnce: false } });
  return ctx.newPage();
}

async function login(page, email) {
  await page.goto('http://localhost:4173/');
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'family-code');
  await page.click('#login-btn');
  await page.waitForSelector('#song-list .song-row, #view-sub', { timeout: 15000 });
  await page.waitForTimeout(400);
}

const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.jpeg`, type: 'jpeg', quality: 55 });

/* 1. login screen */
{
  const page = await newPage();
  await page.goto('http://localhost:4173/');
  await page.waitForTimeout(400);
  await shot(page, '01-login');
  await page.close();
}

/* 2. library + playing song + queue panel */
{
  const page = await newPage();
  await login(page, 'member@example.test');
  await page.locator('#song-list .song-row', { hasText: 'Morning Walk' }).click();
  await page.waitForTimeout(1200);
  await shot(page, '02-library-playing');
  await page.close();
}

/* 3. lyrics panel with active line */
{
  const page = await newPage();
  await login(page, 'member@example.test');
  await page.locator('#song-list .song-row', { hasText: 'Morning Walk' }).click();
  await page.waitForFunction(() => document.getElementById('audio').duration > 0, null, { timeout: 15000 });
  await page.evaluate(() => { document.getElementById('audio').currentTime = 5; });
  await page.click('#btn-lyrics');
  await page.waitForTimeout(700);
  await shot(page, '03-lyrics');
  await page.close();
}

/* 4. lyrics editor modal */
{
  const page = await newPage();
  await login(page, 'member@example.test');
  await page.locator('#song-list .song-row', { hasText: 'Morning Walk' }).click();
  await page.click('#btn-lyrics');
  await page.waitForTimeout(600);
  await page.click('.lp-edit');
  await page.waitForTimeout(300);
  await shot(page, '04-lyrics-editor');
  await page.close();
}

/* 5. equalizer panel ON with a preset */
{
  const page = await newPage();
  await login(page, 'member@example.test');
  await page.click('#btn-eq');
  await page.click('.eq-toggle');
  await page.selectOption('#eq-panel select', 'bass');
  await page.waitForTimeout(300);
  await shot(page, '05-equalizer');
  await page.close();
}

/* 6. artists grid */
{
  const page = await newPage();
  await login(page, 'member@example.test');
  await page.click('#nav-artists');
  await page.waitForTimeout(300);
  await shot(page, '06-artists');
  await page.close();
}

/* 7. admin users view */
{
  const page = await newPage();
  await login(page, 'organizer@example.test');
  await page.waitForSelector('#nav-users:not([hidden])', { timeout: 15000 });
  await page.click('#nav-users');
  await page.waitForSelector('.admin-row', { timeout: 15000 });
  await page.waitForTimeout(300);
  await shot(page, '07-admin-users');
  await page.close();
}

/* 8. admin delete confirm modal */
{
  const page = await newPage();
  await login(page, 'organizer@example.test');
  await page.waitForSelector('#nav-users:not([hidden])', { timeout: 15000 });
  await page.click('#nav-users');
  await page.waitForSelector('.admin-row', { timeout: 15000 });
  await page.locator('.admin-row', { hasText: 'leaver@example.test' }).locator('button:has-text("Delete")').click();
  await page.waitForTimeout(300);
  await shot(page, '08-admin-delete-confirm');
  await page.close();
}

/* 9. mobile layout */
{
  const page = await newPage(390, 780);
  await login(page, 'member@example.test');
  await page.waitForTimeout(300);
  await shot(page, '09-mobile');
  await page.close();
}

await browser.close();
console.log('shots written to', OUT);
