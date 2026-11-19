// The AI layer end to end: the real handler (supabase/functions/_shared) over HTTP, on a real local Postgres with
// every migration applied. Skipped when the Postgres server binaries are not installed.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { startDb } from './pg-local.mjs';
import { createHandler } from '../supabase/functions/_shared/handler.js';
import { TOOLS, validate } from '../supabase/functions/_shared/tools.js';
import { openapi } from '../supabase/functions/_shared/openapi.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const HOME = '11111111-1111-1111-1111-111111111111', OTHER = '22222222-2222-2222-2222-222222222222';
const GREG = '00000000-0000-0000-0000-0000000000a1', STRANGER = '00000000-0000-0000-0000-0000000000b1';
const APP = 'https://app.example/thaitastes/';
const T = { claude: 'tt_' + 'c'.repeat(64), gpt: 'tt_' + 'd'.repeat(64), other: 'tt_' + 'e'.repeat(64), revoked: 'tt_' + 'f'.repeat(64) };

let db, server, base;
const skip = { skip: false };

before(async () => {
  db = await startDb();
  // In CI a missing Postgres must fail the run, not quietly skip the whole AI layer.
  if (!db && process.env.CI) throw new Error('Postgres server binaries not found: the AI layer tests cannot run');
  if (!db) { skip.skip = 'Postgres server binaries not found'; return; }
  await db.pool.query(`
    insert into auth.users (id, email) values ('${GREG}', 'greg@example.test'), ('${STRANGER}', 's@example.test');
    insert into public.households (id, name) values ('${HOME}', 'home'), ('${OTHER}', 'other');
    insert into public.household_members values ('${HOME}', '${GREG}', 'greg', now()), ('${OTHER}', '${STRANGER}', 'greg', now());
    insert into public.dishes (household_id, id, rom, th, region, builtin) values ('${HOME}', 'n1', 'Khao soi', 'ข้าวซอย', 'nord', true), ('${OTHER}', 'n1', 'secret dish', null, 'nord', false);
    insert into public.entries (household_id, id, dish_id, date, stage, author) values ('${OTHER}', 'x1', 'n1', '2026-11-03', 'bkk', 'greg');
    insert into public.ai_clients (household_id, name, author, token_hash, token_prefix, revoked_at) values
      ('${HOME}', 'Claude', 'claude', '${sha(T.claude)}', 'tt_cccccc', null), ('${HOME}', 'ChatGPT', 'chatgpt', '${sha(T.gpt)}', 'tt_dddddd', null),
      ('${OTHER}', 'Other', 'claude', '${sha(T.other)}', 'tt_eeeeee', null), ('${HOME}', 'Old', 'claude', '${sha(T.revoked)}', 'tt_ffffff', now());`);
  server = http.createServer(async (req, res) => {
    // Like Supabase: only /functions/v1/tt/* reaches the function; the host root serves nothing.
    if (!req.url.startsWith('/functions/v1/tt')) { res.writeHead(404).end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const out = await handler(new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
    res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/functions/v1/tt`;
  handler = createHandler({ rpc: db.rpc, base, appUrl: APP });
});
let handler;
after(async () => { if (server) await new Promise((r) => server.close(r)); if (db) await db.stop(); });

const api = (tool, args, token = T.claude) => fetch(`${base}/api/${tool}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(args ?? {}) });
const call = async (tool, args, token) => { const r = await api(tool, args, token); return { status: r.status, body: await r.json() }; };
const rpc = (method, params, token = T.claude, id = 1) => fetch(`${base}/mcp`, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
const clearLimits = () => db.pool.query('delete from public.rate_limits');

test('tool definitions are well formed and fit the ChatGPT Actions limits', () => {
  assert.equal(TOOLS.length, 15);
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(t.description.length <= 300, `${t.name} description is ${t.description.length} chars`);
    assert.equal(t.input.type, 'object'); assert.equal(t.input.additionalProperties, false);
    for (const [k, p] of Object.entries(t.input.properties)) assert.ok(p.description && p.description.length <= 700, `${t.name}.${k} description`);
    for (const k of t.input.required) assert.ok(t.input.properties[k], `${t.name} requires unknown ${k}`);
  }
  assert.deepEqual(validate(TOOLS.find((t) => t.name === 'add_entry').input, { dish_id: 'n1', spice: 11, nope: 1, price_thb: '60' }),
    ['spice must be at most 10', 'nope is not a known field', 'price_thb must be integer']);
});

test('OpenAPI document covers every tool', () => {
  const doc = openapi('https://x.supabase.co/functions/v1/tt');
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual(Object.keys(doc.paths), TOOLS.map((t) => '/api/' + t.name));
  assert.deepEqual(Object.values(doc.paths).map((p) => p.post.operationId), TOOLS.map((t) => t.name));
  assert.equal(doc.paths['/api/get_stats'].post['x-openai-isConsequential'], false);
  assert.equal('x-openai-isConsequential' in doc.paths['/api/add_entry'].post, false);
  assert.deepEqual(doc.security, [{ bearer: [] }]);
  JSON.parse(JSON.stringify(doc));
});

test('without a valid token every route except the OAuth ones answers 401', skip, async () => {
  const routes = [['POST', '/mcp'], ['GET', '/mcp'], ['POST', '/api/get_context'], ['GET', '/api/get_context'], ['POST', '/api/add_entry'],
    ['POST', '/api/nope'], ['GET', '/'], ['GET', '/anything'], ['POST', '/rpc/ai_call'], ['DELETE', '/mcp']];
  for (const [method, p] of routes) {
    for (const auth of [undefined, 'Bearer nope', `Bearer ${T.revoked}`, 'Basic abc']) {
      const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(r.status, 401, `${method} ${p} with ${auth}`);
      assert.match(r.headers.get('www-authenticate'), /^Bearer resource_metadata="http.*\/\.well-known\/oauth-protected-resource"/);
      await r.arrayBuffer();
    }
  }
  // Malformed requests must not be explained to a stranger either.
  const big = JSON.stringify({ note: 'x'.repeat(120000) });
  const bodies = ['{not json', big, '[]', JSON.stringify(new Array(21).fill({ jsonrpc: '2.0', id: 1, method: 'ping' })),
    JSON.stringify({ method: 'tools/call', params: { name: 'get_context' } }), JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_context' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } }),
    JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context' } }, 5]), JSON.stringify({ dish_id: 'n1', spice: 99 }), 'null', '5'];
  for (const p of ['/mcp', '/api/add_entry', '/api/nope']) for (const body of bodies) for (const auth of ['Bearer nope', `Bearer ${T.revoked}`]) {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body });
    assert.equal(r.status, 401, `POST ${p} ${body.slice(0, 60)} with ${auth}`);
    await r.arrayBuffer();
  }
  // The same malformed requests with a valid token get a proper answer.
  await clearLimits();
  const good = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${T.claude}` }, body });
  assert.equal((await good('/mcp', '{not json')).status, 400); assert.equal((await good('/mcp', big)).status, 413); assert.equal((await good('/mcp', '[]')).status, 400);
  assert.equal((await good('/mcp', 'null')).status, 200); assert.equal((await good('/api/add_entry', 'null')).status, 400);
  assert.equal((await good('/mcp', JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_context' } }))).status, 202);
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server', '/jwks'])
    assert.equal((await fetch(base + p)).status, 200, p);
  assert.equal((await fetch(base + '/nope', { headers: { authorization: `Bearer ${T.claude}` } })).status, 404);
});

test('REST: add, read, search; author and audit are recorded', skip, async () => {
  await clearLimits();
  const ctx = await call('get_context');
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.today, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date()));
  assert.equal(ctx.body.you_write_as, 'claude');
  const add = await call('add_entry', { dish_id: 'n1', date: '2026-11-10', price_thb: 60, note: 'rich broth' });
  assert.equal(add.status, 200);
  assert.equal(add.body.author, 'claude'); assert.equal(add.body.source_client, 'Claude'); assert.equal(add.body.stage, 'cnx');
  assert.equal(add.body.dish.thai, 'ข้าวซอย');
  const row = (await db.pool.query('select author, source_client from public.entries where id = $1', [add.body.id])).rows[0];
  assert.deepEqual(row, { author: 'claude', source_client: 'Claude' });
  const audit = (await db.pool.query(`select actor, tool, table_name, after->>'note' as note from public.audit_log where record_id = $1`, [add.body.id])).rows;
  assert.deepEqual(audit, [{ actor: 'claude', tool: 'add_entry', table_name: 'entries', note: 'rich broth' }]);
  assert.equal((await call('get_entry', { id: add.body.id }, T.gpt)).body.note, 'rich broth');
  assert.equal((await call('search_entries', { query: 'ข้าวซอย' })).body.total, 1);
  assert.equal((await call('get_entry', { id: 'nope' })).status, 404);
  const bad = await call('add_entry', { dish_id: 'n1', spice: 99 });
  assert.equal(bad.status, 400); assert.match(bad.body.error.message, /spice must be at most 10/);
  assert.equal((await call('add_entry', { dish_id: 'n1', rating_greg: 5 })).status, 400, 'add_entry takes no ratings');
  assert.equal((await fetch(`${base}/api/add_entry`, { method: 'POST', headers: { authorization: `Bearer ${T.claude}` }, body: '{not json' })).status, 400);
  assert.equal((await fetch(`${base}/api/add_entry`, { method: 'POST', headers: { authorization: `Bearer ${T.claude}` }, body: JSON.stringify({ dish_id: 'n1', note: 'x'.repeat(120000) }) })).status, 413);
});

test('one household\'s token cannot read or change another household', skip, async () => {
  await clearLimits();
  const mine = (await call('add_entry', { dish_id: 'n1' })).body;
  assert.equal((await call('get_entry', { id: mine.id }, T.other)).status, 404);
  assert.equal((await call('update_entry', { id: mine.id, expected_updated_at: mine.updated_at, note: 'hack' }, T.other)).status, 404);
  assert.equal((await call('rate_entry', { id: mine.id, person: 'greg', rating: 1 }, T.other)).status, 404);
  const theirs = (await call('search_entries', {}, T.other)).body;
  assert.deepEqual(theirs.entries.map((e) => e.id), ['x1']);
  assert.deepEqual((await call('list_dishes', {}, T.other)).body.dishes.map((d) => d.name), ['secret dish']);
  assert.equal((await call('get_entry', { id: 'x1' })).status, 404);
});

test('two AI clients editing the same entry at once: one wins, the other gets a conflict, nothing is lost', skip, async () => {
  await clearLimits();
  const e = (await call('add_entry', { dish_id: 'n1', note: 'start', price_thb: 50 })).body;
  for (let round = 0; round < 5; round++) {
    const cur = (await call('get_entry', { id: e.id })).body;
    const [a, b] = await Promise.all([
      call('update_entry', { id: e.id, expected_updated_at: cur.updated_at, note: `claude ${round}` }, T.claude),
      call('update_entry', { id: e.id, expected_updated_at: cur.updated_at, price_thb: 100 + round }, T.gpt),
    ]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const conflicts = [a, b].filter((r) => r.body.conflict);
    assert.equal(conflicts.length, 1, 'exactly one of two simultaneous edits is refused');
    const winner = [a, b].find((r) => !r.body.conflict).body, loser = conflicts[0].body;
    assert.equal(loser.current.updated_at, winner.updated_at, 'the conflict carries the record as the winner left it');
    // The loser merges and retries, as the tool description says.
    const retry = loser === a.body ? { note: `claude ${round}` } : { price_thb: 100 + round };
    const again = await call('update_entry', { id: e.id, expected_updated_at: loser.current.updated_at, ...retry }, loser === a.body ? T.claude : T.gpt);
    assert.equal(again.body.note, `claude ${round}`); assert.equal(again.body.price_thb, 100 + round);
  }
  const audits = (await db.pool.query(`select count(*)::int n from public.audit_log where record_id = $1 and tool = 'update_entry'`, [e.id])).rows[0].n;
  assert.equal(audits, 10, 'every applied update is audited, refused ones are not');
});

test('rate limits answer 429', skip, async () => {
  await clearLimits();
  const results = [];
  for (let i = 0; i < 22; i++) results.push((await api('toggle_fav', { dish_id: 'n1' }, T.gpt)).status);
  assert.deepEqual([...new Set(results.slice(0, 20))], [200]); assert.deepEqual(results.slice(20), [429, 429]);
  assert.equal((await api('get_stats', {}, T.gpt)).status, 200, 'reads still pass while writes are limited');
  assert.equal((await api('toggle_fav', { dish_id: 'n1' }, T.claude)).status, 200, 'limits are per client');
  await clearLimits();
});

test('MCP: initialize, tools/list, tools/call, errors', skip, async () => {
  await clearLimits();
  const init = await (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.ok(init.result.capabilities.tools); assert.match(init.result.instructions, /rate_entry/);
  assert.equal((await (await rpc('initialize', { protocolVersion: '2099-01-01' })).json()).result.protocolVersion, '2025-11-25');
  const note = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${T.claude}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const list = await (await rpc('tools/list')).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.equal(list.result.tools.find((t) => t.name === 'get_stats').annotations.readOnlyHint, true);
  assert.equal(list.result.tools.find((t) => t.name === 'add_entry').annotations.readOnlyHint, false);
  const added = await (await rpc('tools/call', { name: 'add_entry', arguments: { dish_name: 'Mystery curry', spice: 7 } }, T.gpt)).json();
  assert.equal(added.result.isError, false); assert.equal(added.result.structuredContent.author, 'chatgpt');
  assert.deepEqual(JSON.parse(added.result.content[0].text), added.result.structuredContent);
  const viaRest = await call('get_entry', { id: added.result.structuredContent.id });
  assert.deepEqual(viaRest.body, added.result.structuredContent, 'REST and MCP return the same record');
  const bad = await (await rpc('tools/call', { name: 'rate_entry', arguments: { id: 'x', person: 'bob', rating: 9 } })).json();
  assert.equal(bad.result.isError, true); assert.match(bad.result.content[0].text, /person must be one of/);
  assert.equal((await (await rpc('tools/call', { name: 'nope', arguments: {} })).json()).error.code, -32602);
  assert.equal((await (await rpc('nope/nope')).json()).error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'get_context', arguments: {} }, T.revoked)).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${T.claude}` } })).status, 405);
  const batch = await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${T.claude}` },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_latest_location', arguments: {} } }]) })).json();
  assert.equal(batch.length, 2); assert.deepEqual(batch[1].result.structuredContent.locations, []);
});

test('the official MCP client connects with a static token', skip, async () => {
  await clearLimits();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${T.claude}` } } }));
  assert.equal(client.getServerVersion().name, 'thaitastes');
  assert.equal((await client.listTools()).tools.length, 15);
  const res = await client.callTool({ name: 'list_dishes', arguments: { query: 'khao' } });
  assert.equal(res.structuredContent.dishes[0].thai, 'ข้าวซอย');
  await client.close();
});

// What the app does on the consent page, done here through the same database functions.
async function consent(location, { approve = true, author = 'claude', user = GREG } = {}) {
  const u = new URL(location);
  assert.equal(u.origin + u.pathname, APP, 'authorize sends the browser to the app');
  const id = u.searchParams.get('authorize');
  const as = db.asUser(user);
  const info = await as('oauth_request_info', { p_id: id });
  if (!approve) return { info, ...(await as('deny_oauth_request', { p_id: id })) };
  return { info, ...(await as('approve_oauth_request', { p_id: id, p_author: author })) };
}

test('the official MCP client completes the OAuth flow (discovery, registration, PKCE, consent, token)', skip, async () => {
  await clearLimits();
  let saved = {}, authUrl = null;
  const provider = {
    get redirectUrl() { return 'http://localhost:43111/callback'; },
    get clientMetadata() { return { client_name: 'Test MCP client', redirect_uris: ['http://localhost:43111/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
    clientInformation: () => saved.client, saveClientInformation: (c) => { saved.client = c; },
    tokens: () => saved.tokens, saveTokens: (t) => { saved.tokens = t; },
    redirectToAuthorization: (url) => { authUrl = url; },
    saveCodeVerifier: (v) => { saved.verifier = v; }, codeVerifier: () => saved.verifier,
  };
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { authProvider: provider });
  await assert.rejects(client.connect(transport), /Unauthorized/);
  assert.ok(authUrl, 'the client was sent to /authorize');
  assert.equal(authUrl.origin + authUrl.pathname, base + '/authorize');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  const r = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const c = await consent(r.headers.get('location'));
  assert.equal(c.info.client_name, 'Test MCP client'); assert.equal(c.redirect_uri, 'http://localhost:43111/callback');
  await transport.finishAuth(c.code);
  assert.match(saved.tokens.access_token, /^tt_[0-9a-f]{64}$/); assert.equal(saved.tokens.expires_in, 3600); assert.ok(saved.tokens.refresh_token);

  const client2 = new Client({ name: 'test', version: '1.0.0' });
  await client2.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { authProvider: provider }));
  const added = await client2.callTool({ name: 'add_entry', arguments: { dish_id: 'n1', note: 'via oauth' } });
  assert.equal(added.structuredContent.author, 'claude');
  assert.equal(added.structuredContent.source_client, 'Test MCP client (approved by greg)');
  await client2.close();
  const row = (await db.pool.query(`select household_id, token_hash, expires_at > now() as live from public.ai_clients where name like 'Test MCP client%'`)).rows[0];
  assert.equal(row.household_id, HOME); assert.equal(row.token_hash, sha(saved.tokens.access_token)); assert.equal(row.live, true);
});

test('OAuth: refusals', skip, async () => {
  await clearLimits();
  const reg = async (body) => fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await reg({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] })).status, 400);
  assert.equal((await reg({ client_name: 'x' })).status, 400);
  const client = await (await reg({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] })).json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authz = (over = {}) => {
    const u = new URL(base + '/authorize');
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], state: 'S1', code_challenge: challenge, code_challenge_method: 'S256', resource: base + '/mcp', ...over })) if (v != null) u.searchParams.set(k, v);
    return fetch(u, { redirect: 'manual' });
  };
  const tok = (params) => fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });

  // A redirect address that was not registered is never redirected to.
  const evil = await authz({ redirect_uri: 'https://evil.example/cb' });
  assert.equal(evil.status, 400); assert.equal(evil.headers.get('location'), null);
  assert.equal((await authz({ client_id: 'oc_nope' })).status, 400);
  const noPkce = await authz({ code_challenge: null });
  assert.equal(noPkce.status, 302); assert.match(noPkce.headers.get('location'), /^https:\/\/chatgpt\.com\/.*error=invalid_request.*state=S1/);
  assert.match((await authz({ code_challenge_method: 'plain' })).headers.get('location'), /error=invalid_request/);

  // Denied in the app.
  const denied = await consent((await authz()).headers.get('location'), { approve: false });
  assert.equal(denied.state, 'S1'); assert.equal('code' in denied, false);

  // A signed-in user who is not in any household cannot approve.
  await db.pool.query(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'nobody@example.test') on conflict do nothing`);
  await assert.rejects(consent((await authz()).headers.get('location'), { user: '00000000-0000-0000-0000-0000000000c1' }), /not a household member/);

  // Approved by the other household's member: the token belongs to THAT household, never to ours.
  const ok = await consent((await authz()).headers.get('location'), { author: 'chatgpt', user: STRANGER });
  assert.equal(ok.state, 'S1');
  const grant = { grant_type: 'authorization_code', code: ok.code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier };
  assert.equal((await tok({ ...grant, code_verifier: 'wrong-verifier' })).status, 400);
  assert.equal((await tok({ ...grant, redirect_uri: 'https://chatgpt.com/other' })).status, 400);
  assert.equal((await tok({ ...grant, client_id: 'oc_nope' })).status, 400);
  assert.equal((await tok({ ...grant, grant_type: 'password' })).status, 400);
  const first = await tok(grant);
  assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
  const t1 = await first.json();
  assert.deepEqual((await call('search_entries', {}, t1.access_token)).body.entries.map((e) => e.id), ['x1']);
  assert.equal((await call('add_entry', { dish_id: 'n1' }, t1.access_token)).body.author, 'chatgpt');

  // Refresh rotates both tokens; the old ones stop working.
  const second = await tok({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id });
  assert.equal(second.status, 200); const t2 = await second.json();
  assert.notEqual(t2.access_token, t1.access_token);
  assert.equal((await api('get_context', {}, t1.access_token)).status, 401);
  assert.equal((await api('get_context', {}, t2.access_token)).status, 200);
  const stale = await tok({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id });
  assert.equal(stale.status, 400); assert.equal((await stale.json()).error, 'invalid_grant');

  // An expired access token is refused.
  await db.pool.query(`update public.ai_clients set expires_at = now() - interval '1 second' where token_hash = $1`, [sha(t2.access_token)]);
  assert.equal((await api('get_context', {}, t2.access_token)).status, 401);
  await db.pool.query(`update public.ai_clients set expires_at = now() + interval '1 hour' where token_hash = $1`, [sha(t2.access_token)]);

  // Replaying the authorization code revokes the token it produced.
  const replay = await tok(grant);
  assert.equal(replay.status, 400); assert.equal((await replay.json()).error, 'invalid_grant');
  assert.equal((await api('get_context', {}, t2.access_token)).status, 401);

  // Revoking in Settings kills an OAuth token and its refresh token.
  const live = await consent((await authz()).headers.get('location'));
  const t3 = await (await tok({ ...grant, code: live.code })).json();
  assert.equal((await api('get_context', {}, t3.access_token)).status, 200);
  const cid = (await db.pool.query('select id from public.ai_clients where token_hash = $1', [sha(t3.access_token)])).rows[0].id;
  await db.asUser(GREG)('revoke_ai_client', { p_id: cid });
  assert.equal((await api('get_context', {}, t3.access_token)).status, 401);
  assert.equal((await tok({ grant_type: 'refresh_token', refresh_token: t3.refresh_token, client_id: client.client_id })).status, 400);
});
