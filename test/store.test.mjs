import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { startFake } from './fake-supabase.mjs';
import { createStore } from '../web/js/store.js';
import { openDb } from '../web/js/db.js';

const H = '11111111-1111-1111-1111-111111111111';
const iso = (n) => new Date(n).toISOString();

async function setup() {
  const fake = await startFake();
  fake.db.dishes.push({ household_id: H, id: 'n1', rom: 'khao soi', th: 'ข้าวซอย', d: 'curry', region: 'nord', sublabel: null, builtin: true, created_at: iso(1) });
  fake.db.dishes.push({ household_id: H, id: 'mine1', rom: 'my dish', region: 'sud', builtin: false, created_at: iso(5) });
  fake.db.places.push({ household_id: H, id: 'p1', name: 'Stall', stage: 'cnx', lat: 18.7, lng: 98.9, builtin: false, created_at: iso(5) });
  fake.db.entries.push({ household_id: H, id: 'e1', dish_id: 'n1', place_id: 'p1', date: '2026-11-08', stage: 'cnx', rating_greg: 3, rating_andra: 4, price_thb: 50,
    spice: null, again: true, note: 'good', photo_path: null, author: 'greg', source_client: 'migration', created_at: iso(10), updated_at: iso(20) });
  const sb = createClient(fake.url, 'anon', { auth: { persistSession: false, autoRefreshToken: false } });
  const close = fake.close;
  fake.close = () => { try { sb.realtime.disconnect(); } catch {} sb.removeAllChannels().catch(() => {}); close(); };
  const mk = async (o = {}) => createStore({ sb: o.sb ?? sb, householdId: H, me: 'greg', db: o.db ?? (await openDb()) });
  return { fake, sb, mk };
}

test('loads rows into the UI shape, builtin in catalogue order, custom after', async () => {
  const { fake, mk } = await setup();
  const s = await mk(); await s.start();
  const v = s.snapshot();
  assert.equal(v.dishes.builtin[0].id, 'n1'); assert.equal(v.dishes.custom[0].id, 'mine1');
  assert.equal(v.places.custom[0].c[0], 18.7);
  assert.deepEqual(v.entries.map((e) => [e.id, e.g, e.a, e.price, e.again, e.createdAt]), [['e1', 3, 4, 50, true, 10]]);
  await s.stop(); fake.close();
});

test('new entry shows at once, is sent with author and source_client, and survives an offline spell', async () => {
  const { fake, mk } = await setup();
  const s = await mk(); await s.start();
  fake.state.down = true;
  const id = s.saveEntry({ dishId: 'n1', date: '2026-11-09', stage: 'cnx', g: 5, a: null, note: 'offline one', photo: null });
  assert.equal(s.snapshot().entries.length, 2, 'optimistic');
  await s.flush();
  assert.equal(s.pending(), 1, 'kept in the outbox while the server is unreachable');
  assert.equal(fake.db.entries.length, 1);
  fake.state.down = false;
  await s.flush();
  assert.equal(s.pending(), 0);
  const row = fake.db.entries.find((r) => r.id === id);
  assert.equal(row.author, 'greg'); assert.equal(row.source_client, 'pwa'); assert.equal(row.rating_greg, 5); assert.equal(row.note, 'offline one');
  await s.stop(); fake.close();
});

test('the outbox survives a restart', async () => {
  const { fake, mk } = await setup();
  const db = await openDb();
  let s = await mk({ db }); await s.start();
  fake.state.down = true;
  s.saveEntry({ dishId: 'n1', date: '2026-11-09', stage: 'cnx', g: 4 });
  await new Promise((r) => setTimeout(r, 400));
  await s.stop();
  fake.state.down = false;
  s = await mk({ db });
  assert.equal(s.pending(), 1);
  assert.equal(s.snapshot().entries.length, 2, 'queued entry is visible straight after restart, before any network');
  await s.start();
  assert.equal(s.pending(), 0); assert.equal(fake.db.entries.length, 2);
  await s.stop(); fake.close();
});

test('an edit to one field does not overwrite a change made elsewhere to another field', async () => {
  const { fake, mk } = await setup();
  const s = await mk(); await s.start();
  const cur = s.snapshot().entries[0];
  // Claude changes the note on the server after the app loaded
  fake.state.down = true;
  s.saveEntry({ ...cur, g: 5 }, 'e1');                       // person: rating 3 -> 5, offline
  fake.state.down = false;
  Object.assign(fake.db.entries[0], { note: 'edited by claude', updated_at: fake.nowIso() });
  await s.flush();
  const row = fake.db.entries[0];
  assert.equal(row.rating_greg, 5); assert.equal(row.note, 'edited by claude');
  await s.stop(); fake.close();
});

test('a write that loses the race on updated_at is retried against the newer row', async () => {
  const { fake, mk } = await setup();
  const s = await mk(); await s.start();
  const cur = s.snapshot().entries[0];
  let bumped = 0;
  fake.state.beforePatch = () => { if (!bumped++) Object.assign(fake.db.entries[0], { spice: 7, updated_at: fake.nowIso() }); };
  s.saveEntry({ ...cur, g: 1 }, 'e1');
  await s.flush();
  assert.equal(fake.db.entries[0].rating_greg, 1); assert.equal(fake.db.entries[0].spice, 7);
  assert.ok(bumped >= 1);
  await s.stop(); fake.close();
});

test('delete then Undo: before sync it cancels, after sync it restores the same row', async () => {
  const { fake, mk } = await setup();
  const s = await mk(); await s.start();
  fake.state.down = true;
  let e = s.snapshot().entries[0];
  s.deleteEntry('e1'); assert.equal(s.snapshot().entries.length, 0);
  s.restoreEntry(e); assert.equal(s.snapshot().entries.length, 1); assert.equal(s.pending(), 0);
  fake.state.down = false;
  s.deleteEntry('e1'); await s.flush(); assert.equal(fake.db.entries.length, 0);
  s.restoreEntry(e); await s.flush();
  const row = fake.db.entries[0];
  assert.equal(row.id, 'e1'); assert.equal(row.created_at, iso(10)); assert.equal(row.again, true); assert.equal(row.rating_andra, 4);
  await s.stop(); fake.close();
});

test('an entry created and deleted offline never reaches the server', async () => {
  const { fake, mk } = await setup();
  const s = await mk(); await s.start();
  fake.state.down = true;
  const id = s.saveEntry({ dishId: 'n1', date: '2026-11-09', stage: 'cnx', g: 4 });
  s.deleteEntry(id);
  assert.equal(s.pending(), 0);
  await s.stop(); fake.close();
});

test('favourites, custom dishes and places, catalogue place link and note', async () => {
  const { fake, mk } = await setup();
  fake.db.places.push({ household_id: H, id: 'bkk-x', name: 'Catalogue', stage: 'bkk', builtin: true, created_at: iso(1) });
  const s = await mk(); await s.start();
  s.setFav('n1', true); await s.flush();
  assert.equal(fake.db.favs.length, 1); assert.ok(s.snapshot().favs.has('n1'));
  s.setFav('n1', false); await s.flush(); assert.equal(fake.db.favs.length, 0);
  const d = s.saveDish({ rom: 'New thing', r: 'isaan' }); await s.flush();
  assert.equal(fake.db.dishes.find((x) => x.id === d).region, 'isaan');
  s.saveDish({ rom: 'Renamed', r: 'isaan' }, d); await s.flush();
  assert.equal(fake.db.dishes.find((x) => x.id === d).rom, 'Renamed');
  const p = s.savePlace({ n: 'A stall', st: 'cnx', a: 'soi 1' }); await s.flush();
  assert.equal(fake.db.places.find((x) => x.id === p).address, 'soi 1');
  s.savePlaceInfo('bkk-x', { ig: 'https://instagram.com/x', note: 'go early' }); await s.flush();
  const bx = fake.db.places.find((x) => x.id === 'bkk-x'); assert.equal(bx.ig, 'https://instagram.com/x'); assert.equal(bx.note, 'go early');
  assert.equal(s.snapshot().places.builtin.find((x) => x.id === 'bkk-x').ig, 'https://instagram.com/x');
  s.deleteDish(d); await s.flush(); assert.ok(!fake.db.dishes.some((x) => x.id === d));
  await s.stop(); fake.close();
});

test('photos: stored locally, uploaded in order before the entry, kept while another entry uses them', async () => {
  const { fake, mk } = await setup();
  const s = await mk(); await s.start();
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 1, 2, 3])], { type: 'image/jpeg' });
  const photo = await s.addPhoto(blob);
  assert.ok(photo.id.startsWith(H + '/')); assert.ok(photo.url.startsWith('blob:'));
  const id = s.saveEntry({ dishId: 'n1', date: '2026-11-09', stage: 'cnx', g: 4, photo });
  await s.flush();
  assert.ok(fake.objects.has(photo.id)); assert.equal(fake.db.entries.find((r) => r.id === id).photo_path, photo.id);
  assert.equal(s.snapshot().entries.find((e) => e.id === id).photo.url, photo.url);
  await s.removePhoto(photo.id); await s.flush();
  assert.ok(fake.objects.has(photo.id), 'still referenced, so not removed');
  s.updateEntry(id, { photo: null }); await s.flush();
  await s.removePhoto(photo.id); await s.flush();
  assert.ok(!fake.objects.has(photo.id));
  await s.stop(); fake.close();
});

test('a fresh device gets signed URLs and a local copy of the photos', async () => {
  const { fake, mk } = await setup();
  const path = `${H}/abc.jpg`;
  fake.objects.set(path, Buffer.from([0xff, 0xd8, 9, 9]));
  Object.assign(fake.db.entries[0], { photo_path: path });
  const s = await mk(); await s.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(s.snapshot().entries[0].photo.url.startsWith('blob:'), 'cached as a blob after download');
  await s.stop(); fake.close();
});

test('realtime events from the server (an AI adding an entry) appear without a refetch', async () => {
  const { fake, sb, mk } = await setup();
  const handlers = [];
  const chan = { on: (_t, _f, fn) => { handlers.push(fn); return chan; }, subscribe: (cb) => { cb('SUBSCRIBED'); return chan; } };
  const proxy = new Proxy(sb, { get: (t, k) => (k === 'channel' ? () => chan : k === 'removeChannel' ? async () => {} : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  const s = await mk({ sb: proxy }); await s.start();
  assert.equal(handlers.length, 5);
  let changes = 0; s.onChange(() => changes++);
  const row = { household_id: H, id: 'ai1', dish_id: 'n1', date: '2026-11-10', stage: 'cnx', rating_greg: null, rating_andra: null, author: 'claude', source_client: 'mcp', created_at: iso(30), updated_at: iso(30) };
  for (const h of handlers) h({ eventType: 'INSERT', new: row, old: {} });
  await new Promise((r) => setTimeout(r, 10));
  const e = s.snapshot().entries.find((x) => x.id === 'ai1');
  assert.equal(e.author, 'claude'); assert.ok(changes > 0);
  for (const h of handlers) h({ eventType: 'DELETE', new: {}, old: { household_id: H, id: 'ai1' } });
  assert.ok(!s.snapshot().entries.some((x) => x.id === 'ai1'));
  await s.stop(); fake.close();
});

test('a rejected change is reported and dropped instead of blocking the queue', async () => {
  const { fake, mk } = await setup();
  const s = await mk(); await s.start();
  const errors = []; s.onError((m) => errors.push(m));
  fake.state.reject = ['entries'];
  s.saveEntry({ dishId: 'n1', date: '2026-11-09', stage: 'cnx', g: 4 });
  s.setFav('n1', true);
  await s.flush();
  assert.equal(s.pending(), 0);
  assert.match(errors[0], /permission denied/);
  assert.equal(fake.db.favs.length, 1, 'the change after the rejected one still went through');
  await s.stop(); fake.close();
});
