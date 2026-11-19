// Runs the real Edge Function entry (supabase/functions/tt/index.ts) under Deno, with supabase-js talking to a
// small PostgREST-like bridge in front of the local Postgres. Proves the Deno wiring that the Node tests cannot.
// Skipped unless DENO points at a deno binary:  DENO=$(which deno) node --test test/deno.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { startDb } from './pg-local.mjs';

const DENO = process.env.DENO;
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('index.ts serves MCP and REST under Deno', { skip: DENO ? false : 'set DENO to run' }, async (t) => {
  const db = await startDb();
  if (!db) return t.skip('Postgres server binaries not found');
  const H = '11111111-1111-1111-1111-111111111111', TOKEN = 'tt_' + '9'.repeat(64);
  await db.pool.query(`insert into public.households (id, name) values ('${H}', 'home');
    insert into public.dishes (household_id, id, rom, region) values ('${H}', 'n1', 'Khao soi', 'nord');
    insert into public.ai_clients (household_id, name, author, token_hash, token_prefix) values ('${H}', 'Claude', 'claude', '${sha(TOKEN)}', 'tt_999999')`);
  let keySeen = null;
  const bridge = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(req.url);
    keySeen = req.headers.apikey;
    try {
      const out = await db.rpc(m[1], JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ message: e.message })); }
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  const port = 8700 + Math.floor(Math.random() * 200);
  const proc = spawn(DENO, ['run', '--allow-net', '--allow-env', 'supabase/functions/tt/index.ts'], {
    env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${bridge.address().port}`, SUPABASE_SERVICE_ROLE_KEY: 'service-key', APP_URL: 'https://app.example/tt/',
      DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`, TT_PUBLIC_URL: `http://127.0.0.1:${port}/tt`, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }, stdio: 'pipe' });
  let log = ''; proc.stderr.on('data', (d) => { log += d; }); proc.stdout.on('data', (d) => { log += d; });
  t.after(async () => { proc.kill(); bridge.close(); await db.stop(); });
  const base = `http://127.0.0.1:${port}/tt`;
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/.well-known/openid-configuration')).ok; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  assert.ok(up, 'function did not start:\n' + log);

  assert.equal((await fetch(base + '/mcp', { method: 'POST', body: '{}' })).status, 401);
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  const list = await (await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
  assert.equal(list.result.tools.length, 15);
  const added = await (await post('/api/add_entry', { dish_id: 'n1', note: 'from deno' })).json();
  assert.equal(added.author, 'claude'); assert.equal(added.dish.name, 'Khao soi');
  assert.equal(keySeen, 'service-key', 'the function uses the service-role key for the database');
  const meta = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
  assert.equal(meta.resource, base + '/mcp');
});
