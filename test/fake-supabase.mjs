// An in-memory stand-in for the parts of Supabase the app uses (PostgREST subset, Auth, Storage, RPC).
// Good enough to exercise the store and the UI end to end. It is NOT Supabase: real behaviour is covered by the
// SQL tests (supabase/tests) and by the manual checklist in the README.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PK = { households: ['id'], household_members: ['user_id'], dishes: ['household_id', 'id'], places: ['household_id', 'id'],
  entries: ['household_id', 'id'], favs: ['household_id', 'dish_id'], suggestions: ['id'], locations: ['id'], ai_clients: ['id'], audit_log: ['id'], latest_locations: ['id'] };

export async function startFake({ port = 0 } = {}) {
  const db = Object.fromEntries(Object.keys(PK).map((t) => [t, []]));
  const objects = new Map();
  const state = { down: false, otpEmails: [], log: [], rpc: {}, tokenSeq: 0 };
  let lastMs = 0;
  const nowIso = () => { lastMs = Math.max(Date.now(), lastMs + 1); return new Date(lastMs).toISOString(); };

  const matches = (row, params) => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
      if (v.startsWith('eq.')) { if (String(row[k]) !== v.slice(3)) return false; }
      else if (v.startsWith('in.(')) { const s = new Set(v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, ''))); if (!s.has(String(row[k]))) return false; }
      else if (v === 'is.null') { if (row[k] != null) return false; }
    }
    return true;
  };
  const project = (rows, sel) => (sel && sel !== '*' ? rows.map((r) => Object.fromEntries(sel.split(',').map((c) => [c.trim(), r[c.trim()]]))) : rows);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (state.down) return req.socket.destroy();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...cors, ...headers }); res.end(body === undefined ? '' : Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    const json = () => JSON.parse(raw.toString() || 'null');
    const p = url.pathname;
    const prefer = req.headers.prefer ?? '';
    const wantsObject = (req.headers.accept ?? '').includes('vnd.pgrst.object');
    state.log.push(`${req.method} ${p}${url.search}`);
    try {
      if (p.startsWith('/rest/v1/rpc/')) {
        const fn = p.slice(13); const h = state.rpc[fn];
        return h ? send(200, h(json(), db)) : send(404, { message: `no rpc ${fn}` });
      }
      if (p.startsWith('/rest/v1/')) {
        const t = p.slice(9);
        if (!db[t]) return send(404, { message: `no table ${t}` });
        const key = PK[t];
        if (req.method === 'GET' || req.method === 'HEAD') {
          let rows = db[t].filter((r) => matches(r, url.searchParams));
          const ord = url.searchParams.get('order');
          if (ord) { const [c, dir] = ord.split('.'); rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (dir === 'desc' ? -1 : 1)); }
          const total = rows.length;
          const off = +(url.searchParams.get('offset') ?? 0), lim = +(url.searchParams.get('limit') ?? 1e9);
          rows = project(rows.slice(off, off + lim), url.searchParams.get('select'));
          const hdr = { 'content-range': `0-${Math.max(total - 1, 0)}/${total}` };
          if (req.method === 'HEAD') return send(200, undefined, hdr);
          if (wantsObject) return rows.length === 1 ? send(200, rows[0], hdr) : send(406, { code: 'PGRST116', message: 'no single row' });
          return send(200, rows, hdr);
        }
        if (req.method === 'POST') {
          if (state.reject?.includes(t)) return send(403, { code: '42501', message: 'permission denied' });
          const out = [];
          for (const it of [].concat(json())) {
            const row = { ...it };
            if (t === 'entries' || t === 'dishes' || t === 'places' || t === 'favs' || t === 'suggestions' || t === 'locations') row.created_at ??= nowIso();
            if (t === 'entries') { row.updated_at ??= nowIso(); row.again ??= null; }
            if (t === 'locations') { row.id ??= db.locations.length + 1; row.recorded_at ??= nowIso(); }
            if (t === 'households' || t === 'suggestions' || t === 'ai_clients') row.id ??= randomUUID();
            if (db[t].some((r) => key.every((k) => r[k] === row[k]))) return send(409, { code: '23505', message: `duplicate key value violates unique constraint "${t}_pkey"` });
            db[t].push(row); out.push(row);
          }
          return prefer.includes('return=representation') ? send(201, wantsObject ? out[0] : out) : send(201);
        }
        if (req.method === 'PATCH') {
          state.beforePatch?.(t);
          const rows = db[t].filter((r) => matches(r, url.searchParams));
          for (const r of rows) { Object.assign(r, json()); if (t === 'entries') r.updated_at = nowIso(); }
          return prefer.includes('return=representation') ? send(200, rows) : send(204);
        }
        if (req.method === 'DELETE') {
          const keep = db[t].filter((r) => !matches(r, url.searchParams));
          const gone = db[t].length - keep.length; db[t] = keep;
          if (t === 'dishes' || t === 'places') { /* FK checks omitted */ }
          return send(204);
        }
      }
      if (p === '/auth/v1/otp') { state.otpEmails.push(json().email); return send(200, {}); }
      if (p === '/auth/v1/user') return send(200, state.user ?? { id: 'u', email: 'x@example.test' });
      if (p === '/auth/v1/token') return send(200, state.session ?? { error: 'no session' });
      if (p === '/auth/v1/logout') return send(204);
      if (p.startsWith('/realtime/')) return send(404, {});
      if (p === '/storage/v1/object/sign/photos' && req.method === 'POST') {
        return send(200, json().paths.map((x) => (objects.has(x) ? { error: null, path: x, signedURL: `/object/sign/photos/${x}?token=t` } : { error: 'Object not found', path: x, signedURL: null })));
      }
      if (p.startsWith('/storage/v1/object/sign/photos/')) { const o = objects.get(decodeURIComponent(p.slice(31))); return o ? send(200, o, { 'content-type': 'image/jpeg' }) : send(404, { error: 'nf' }); }
      if (p === '/storage/v1/object/photos' && req.method === 'DELETE') { for (const x of json().prefixes) objects.delete(x); return send(200, []); }
      if (p.startsWith('/storage/v1/object/photos/') && req.method === 'POST') {
        const path = decodeURIComponent(p.slice(26));
        if (objects.has(path) && req.headers['x-upsert'] !== 'true') return send(400, { statusCode: '409', error: 'Duplicate', message: 'exists' });
        objects.set(path, raw); return send(200, { Key: 'photos/' + path });
      }
      send(404, { message: `unhandled ${req.method} ${p}` });
    } catch (e) { send(500, { message: String(e) }); }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  return { server, db, objects, state, port: addr.port, url: `http://127.0.0.1:${addr.port}`, nowIso, close: () => { server.closeAllConnections?.(); server.close(); } };
}
