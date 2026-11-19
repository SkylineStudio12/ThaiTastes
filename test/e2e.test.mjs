// Browser tests of the real app (web/) against the in-memory fake Supabase. Needs Playwright with Chromium.
// Run with the export bundle for realistic data:  BUNDLE_DIR=/path/to/thaitastes-export node --test test/e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFake } from './fake-supabase.mjs';
import { serve } from './serve.mjs';
import { loadPlaywright } from './pw.mjs';
import { loadBundle, buildPlan } from '../scripts/lib/transform.mjs';

const pw = loadPlaywright();
const BUNDLE = process.env.BUNDLE_DIR;
const skip = !pw ? 'Playwright not available' : !BUNDLE ? 'set BUNDLE_DIR to run' : false;
const H = '11111111-1111-1111-1111-111111111111', UID = '00000000-0000-0000-0000-0000000000a1';

const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const session = (port) => ({
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, role: 'authenticated', exp: 4102444800 })}.sig`,
  refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800,
  user: { id: UID, email: 'greg@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} },
});

const open = [];
test.after(async () => { for (const c of open) await c().catch(() => {}); });

async function env() {
  const fake = await startFake();
  const plan = buildPlan(loadBundle(BUNDLE), { photoPath: (id) => `${H}/${id}.jpg` });
  fake.db.households.push({ id: H, name: 'home', location_retention_days: 30 });
  fake.db.household_members.push({ household_id: H, user_id: UID, name: 'greg' });
  for (const d of plan.dishes) fake.db.dishes.push({ household_id: H, ...d, created_at: d.created_at ?? new Date(1).toISOString() });
  for (const p of plan.places) fake.db.places.push({ household_id: H, ...p, created_at: p.created_at ?? new Date(1).toISOString() });
  for (const e of plan.entries) fake.db.entries.push({ household_id: H, again: null, ...e });
  for (const f of plan.favs) fake.db.favs.push({ household_id: H, ...f });
  for (const ph of plan.photos) fake.objects.set(ph.path, readFileSync(ph.file));
  const web = await serve({ port: 0, url: fake.url, anon: 'anon' });
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, serviceWorkers: 'allow' });
  const key = `sb-127-auth-token`;
  await ctx.addInitScript(([k, v]) => { if (!localStorage.getItem(k) && !sessionStorage.getItem('tt-signed-out')) localStorage.setItem(k, v); }, [key, JSON.stringify(session(fake.port))]);
  const base = `http://127.0.0.1:${web.port}/`;
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/realtime|WebSocket|Failed to load resource|favicon|fonts/i.test(m.text())) errors.push(m.text()); });
  const close = async () => { await browser.close(); web.close(); fake.close(); };
  open.push(close);
  return { fake, web, browser, ctx, page, base, errors, plan, close };
}

test('signed out: shows the sign-in form and asks Supabase for a link', { skip }, async () => {
  const e = await env();
  const page = await e.ctx.newPage();
  await e.ctx.clearCookies();
  const p2 = await (await e.browser.newContext()).newPage();
  await p2.goto(e.base);
  await p2.waitForSelector('#login-email');
  assert.equal(await p2.isVisible('#app'), false);
  await p2.fill('#login-email', 'greg@example.test');
  await p2.click('#login-card button[type=submit]');
  await p2.waitForSelector('#login-code:visible');
  assert.deepEqual(e.fake.state.otpEmails, ['greg@example.test']);
  await e.close();
});

test('signed in: Home, history with photos, logging an entry, offline, suggestions, settings', { skip }, async () => {
  const e = await env();
  const { page, fake } = e;
  await page.goto(e.base + '?sw=1');
  await page.waitForSelector('#sum .sum-top');
  assert.match(await page.textContent('#sum'), /Where to eat|Thailand/);
  await page.waitForFunction(() => /\/ 109 dishes tried/.test(document.querySelector('.trip-cnt')?.textContent || ''), null, { timeout: 10000 });

  // History: all 85 entries, and the photos open
  await page.click('nav.tabs button[data-v=hist]');
  await page.waitForSelector('#hist .gcard, #hist [class*=card]');
  await page.waitForFunction(() => [...document.querySelectorAll('#hist img')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
  const imgs = await page.$$eval('#hist img', (is) => is.filter((i) => i.complete && i.naturalWidth > 0).length);
  assert.ok(imgs >= 10, `photos rendered in History (${imgs})`);

  // Log a new dish through the form
  await page.click('#plus');
  await page.fill('#dish-q', 'khao soi');
  await page.click('#dish-res li button');
  await page.click('button[aria-label="Greg 5"]');
  await page.fill('#f-note', 'e2e note');
  await page.click('#save');
  await page.waitForSelector('.toast:has-text("Saved")');
  await page.waitForFunction(() => document.querySelector('#sync').textContent === '', null, { timeout: 8000 });
  const row = fake.db.entries.find((r) => r.note === 'e2e note');
  assert.ok(row, 'entry reached the server');
  assert.equal(row.author, 'greg'); assert.equal(row.source_client, 'pwa'); assert.equal(row.rating_greg, 5); assert.equal(row.dish_id, 'n1');

  // Offline: reload from the service worker cache, add an entry, come back online
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForSelector('#sum .sum-top');
  await e.ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('#sum .sum-top', { timeout: 15000 });
  await page.click('#plus');
  await page.fill('#dish-q', 'pad thai');
  await page.click('#dish-res li button');
  await page.click('button[aria-label="Andra 4"]');
  await page.fill('#f-note', 'offline note');
  await page.click('#save');
  await page.waitForSelector('.toast:has-text("Saved")');
  assert.match(await page.textContent('#sync'), /Offline|waiting/);
  assert.ok(!fake.db.entries.some((r) => r.note === 'offline note'));
  await e.ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#sync').textContent === '', null, { timeout: 10000 });
  assert.ok(fake.db.entries.some((r) => r.note === 'offline note' && r.rating_andra === 4), 'queued entry synced');

  // A change made elsewhere (an AI) shows up after a sync
  fake.db.suggestions.push({ id: 's1', household_id: H, author: 'claude', kind: 'dish', status: 'new', created_at: fake.nowIso(),
    payload: { rom: 'Gaeng test-kua', th: 'แกงทดสอบ', d: 'A made-up curry', region: 'centru', reason: 'You liked curry' } });
  fake.db.entries.push({ household_id: H, id: 'ai-1', dish_id: 'n2', date: '2026-11-18', stage: 'bkk', rating_greg: null, rating_andra: null, author: 'claude', source_client: 'mcp', created_at: fake.nowIso(), updated_at: fake.nowIso(), note: 'added by claude' });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForSelector('.inbox', { timeout: 10000 });
  await page.click('.inbox');
  await page.waitForSelector('.sug-card');
  assert.match(await page.textContent('.sug-card'), /Gaeng test-kua/);
  await page.click('.sug-card .primary');
  await page.waitForFunction(() => document.querySelector('.fempty'), null, { timeout: 8000 });
  assert.ok(await until(() => fake.db.dishes.some((d) => d.rom === 'Gaeng test-kua' && d.region === 'centru' && d.builtin === false)), 'accepted dish created');
  assert.ok(await until(() => fake.db.suggestions[0].status === 'accepted'), 'suggestion marked accepted');

  // Settings: create a token
  fake.state.rpc.create_ai_client = (a) => [{ id: 'c1', token: 'tt_' + 'a'.repeat(64) }];
  fake.state.rpc.revoke_ai_client = () => null;
  await page.click('nav.tabs button[data-v=sum]');
  await page.click('button[aria-label=Settings]');
  await page.waitForSelector('.settings');
  await page.fill('#ai-name', 'Claude on my phone');
  await page.click('.set-add button[type=submit]');
  await page.waitForSelector('.token-box .token');
  assert.match(await page.textContent('.token-box .token'), /^tt_a{64}$/);

  assert.deepEqual(e.errors, []);
  await e.close();
});

test('dark mode and installability', { skip }, async () => {
  const e = await env();
  const page = await (await e.browser.newContext({ colorScheme: 'dark', viewport: { width: 390, height: 844 } })).newPage();
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-127-auth-token', JSON.stringify(session())]);
  await page.goto(e.base + '?sw=1');
  await page.waitForSelector('#sum .sum-top');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+(\.\d+)?/g).map(Number);
  assert.ok(r < 60 && g < 60 && b < 60, 'dark background in dark mode: ' + bg);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await page.context().newCDPSession(page);
  const res = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(res.installabilityErrors, []);
  const manifest = await (await fetch(e.base + 'manifest.webmanifest')).json();
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512') && manifest.icons.some((i) => i.purpose === 'maskable'));
  await e.close();
});
