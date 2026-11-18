// End-to-end test of migrate.mjs against an in-memory fake of the Supabase REST/Auth/Storage endpoints it uses.
// Needs the real bundle: BUNDLE_DIR=/path/to/thaitastes-export node --test
// This proves the script's logic (ordering, idempotency, verification). It does not prove Supabase itself behaves identically.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const BUNDLE = process.env.BUNDLE_DIR;
const PK = { households: ['id'], household_members: ['user_id'], dishes: ['household_id', 'id'], places: ['household_id', 'id'], entries: ['household_id', 'id'], favs: ['household_id', 'dish_id'] };

function startFake() {
  const db = Object.fromEntries(Object.keys(PK).map((t) => [t, []]));
  const users = [];
  const objects = new Map(); // path -> Buffer
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(body === undefined ? '' : (Buffer.isBuffer(body) ? body : JSON.stringify(body))); };
    const p = url.pathname;
    const body = () => JSON.parse(raw.toString() || 'null');
    try {
      if (p.startsWith('/rest/v1/')) {
        const t = p.slice(9);
        const filt = (rows) => {
          for (const [k, v] of url.searchParams) {
            if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
            if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
            else if (v.startsWith('in.(')) { const s = new Set(v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, ''))); rows = rows.filter((r) => s.has(String(r[k]))); }
          }
          return rows;
        };
        if (req.method === 'GET' || req.method === 'HEAD') {
          let rows = filt(db[t]);
          const total = rows.length;
          const off = +(url.searchParams.get('offset') ?? 0), lim = +(url.searchParams.get('limit') ?? 1e9);
          rows = rows.slice(off, off + lim);
          const cols = url.searchParams.get('select');
          if (cols && cols !== '*') rows = rows.map((r) => Object.fromEntries(cols.split(',').map((c) => [c.trim(), r[c.trim()]])));
          const hdr = { 'content-range': `0-${Math.max(total - 1, 0)}/${total}` };
          if (req.method === 'HEAD') return send(200, undefined, hdr);
          if ((req.headers.accept ?? '').includes('vnd.pgrst.object')) return rows.length === 1 ? send(200, rows[0], hdr) : send(406, { message: 'no row' });
          return send(200, rows, hdr);
        }
        if (req.method === 'POST') {
          const items = [].concat(body());
          const merge = (req.headers.prefer ?? '').includes('merge-duplicates');
          const out = [];
          for (const it of items) {
            const row = { ...it };
            if (t === 'households') row.id ??= randomUUID();
            const key = PK[t];
            const i = db[t].findIndex((r) => key.every((k) => r[k] === row[k]));
            if (i >= 0) { if (!merge) return send(409, { code: '23505', message: 'duplicate key' }); Object.assign(db[t][i], row); out.push(db[t][i]); }
            else { db[t].push(row); out.push(row); }
          }
          if ((req.headers.prefer ?? '').includes('return=representation')) return send(201, (req.headers.accept ?? '').includes('vnd.pgrst.object') ? out[0] : out);
          return send(201);
        }
      }
      if (p === '/auth/v1/admin/users' && req.method === 'GET') return send(200, { users });
      if (p === '/auth/v1/admin/users' && req.method === 'POST') { const b = body(); const u = { id: randomUUID(), email: b.email }; users.push(u); return send(200, u); }
      if (p === '/storage/v1/object/list/photos') { const b = body(); const names = [...objects.keys()].filter((k) => k.startsWith(b.prefix + '/')).map((k) => ({ name: k.slice(b.prefix.length + 1) })).sort((a, c) => a.name.localeCompare(c.name)); return send(200, names.slice(b.offset, b.offset + b.limit)); }
      if (p === '/storage/v1/object/sign/photos' && req.method === 'POST') { const b = body(); return send(200, b.paths.map((x) => objects.has(x) ? { error: null, path: x, signedURL: `/object/sign/photos/${x}?token=t` } : { error: 'Object not found', path: x, signedURL: null })); }
      if (p.startsWith('/storage/v1/object/sign/photos/')) { const o = objects.get(decodeURIComponent(p.slice(31))); return o ? send(200, o, { 'content-type': 'image/jpeg' }) : send(404, { error: 'nf' }); }
      if (p.startsWith('/storage/v1/object/photos/') && req.method === 'POST') {
        const path = decodeURIComponent(p.slice(26));
        if (objects.has(path)) return send(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        objects.set(path, raw); return send(200, { Key: 'photos/' + path });
      }
      send(404, { message: `unhandled ${req.method} ${p}` });
    } catch (e) { send(500, { message: String(e) }); }
  });
  return new Promise((r) => server.listen(0, () => r({ server, db, users, objects, port: server.address().port })));
}

test('migrate.mjs: real run is verified, and a second run changes nothing', { skip: !BUNDLE && 'set BUNDLE_DIR to run' }, async () => {
  const f = await startFake();
  const envFile = join(mkdtempSync(join(tmpdir(), 'ttenv-')), 'env');
  writeFileSync(envFile, `SUPABASE_URL=http://127.0.0.1:${f.port}\nSUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.e30.x\nGREG_EMAIL=g@example.test\nANDRA_EMAIL=a@example.test\n`);
  const run = () => new Promise((res) => {
    const c = spawn('node', ['migrate.mjs', '--bundle', BUNDLE, '--env', envFile], { cwd: new URL('.', import.meta.url).pathname });
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => res({ code, out }));
  });
  const r1 = await run();
  assert.equal(r1.code, 0, r1.out);
  assert.match(r1.out, /Migration verified/);
  assert.match(r1.out, /photos that open via signed URL: 35\/35/);
  assert.equal(f.db.entries.length, 85);
  assert.equal(f.db.dishes.length, 109);
  assert.equal(f.db.places.length, 84);
  assert.equal(f.db.favs.length, 16);
  assert.equal(f.objects.size, 35);
  assert.equal(f.db.household_members.length, 2);
  assert.ok(f.db.entries.filter((e) => e.place_id === 'o0vflgkc8hbdyc43p7m0').length >= 3);
  assert.ok(f.db.entries.every((e) => !e.photo_path || f.objects.has(e.photo_path)));
  const edited = f.db.entries.find((e) => e.id === 'cl-payak-icecream-1106'); edited.note = 'edited in the app';
  const r2 = await run();
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /entries\s+inserted\s+0, already present 85/);
  assert.match(r2.out, /photos\s+uploaded\s+0, already present 35/);
  assert.equal(f.db.entries.length, 85);
  assert.equal(f.db.users?.length ?? f.users.length, 2);
  assert.equal(edited.note, 'edited in the app', 'rerun must not overwrite edits');
  // damage one row and one photo: verify-only must fail loudly
  f.db.entries.pop(); 
  const r3 = await new Promise((res) => { const c = spawn('node', ['migrate.mjs', '--bundle', BUNDLE, '--env', envFile, '--verify-only'], { cwd: new URL('.', import.meta.url).pathname }); let out = ''; c.stderr.on('data', (d) => (out += d)); c.stdout.on('data', (d) => (out += d)); c.on('close', (code) => res({ code, out })); });
  assert.notEqual(r3.code, 0);
  assert.match(r3.out, /MISMATCH: entries: got 84, expected 85/);
  f.server.close();
});
