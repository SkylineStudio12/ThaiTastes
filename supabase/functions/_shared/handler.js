// The whole AI layer as one Request -> Response function.
//   cfg.rpc(name, params)  calls a Postgres function as the service role and returns its JSON (throws on failure)
//   cfg.base               public URL of this function, no trailing slash (https://<ref>.supabase.co/functions/v1/tt)
//   cfg.appUrl             URL of the PWA, where consent happens
// Open routes (no token): the OAuth metadata, /register, /authorize, /token. Everything else needs a Bearer token.
import { json, CORS, bearer, sha256hex, readBody } from './util.js';
import { mcp, runTool } from './mcp.js';
import * as oauth from './oauth.js';

const STATUS = { invalid: 400, unauthorized: 401, not_found: 404, rate_limited: 429 };

// Supabase hands the function a path that starts with its name; locally and in tests there may be other prefixes.
function route(url, name) {
  const marker = '/' + name;
  const i = url.pathname.indexOf(marker + '/');
  if (i >= 0) return url.pathname.slice(i + marker.length);
  return url.pathname.endsWith(marker) ? '/' : url.pathname;
}

export function createHandler(cfg) {
  cfg = { name: 'tt', ...cfg, base: cfg.base.replace(/\/+$/, '') };
  const unauthorized = (hadToken) => () => json(
    { error: { code: 'unauthorized', message: hadToken ? 'Unknown, expired or revoked token' : 'Send a Bearer token' } }, 401,
    { 'www-authenticate': `Bearer resource_metadata="${cfg.base}/.well-known/oauth-protected-resource"` + (hadToken ? ', error="invalid_token"' : '') });

  async function handle(req) {
    const url = new URL(req.url);
    const path = route(url, cfg.name).replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return oauth.preflight();

    if (req.method === 'GET') {
      if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') return json(oauth.protectedResourceMetadata(cfg), 200, { 'cache-control': 'public, max-age=300' });
      if (path === '/.well-known/openid-configuration' || path === '/.well-known/oauth-authorization-server') return json(oauth.authServerMetadata(cfg), 200, { 'cache-control': 'public, max-age=300' });
      if (path === '/jwks') return json({ keys: [] }, 200, { 'cache-control': 'public, max-age=300' });
      if (path === '/authorize') return oauth.authorize(cfg, req, url);
    }
    if (req.method === 'POST') {
      if (path === '/register') return oauth.register(cfg, req);
      if (path === '/token') return oauth.token(cfg, req);
    }

    const token = bearer(req);
    const deny = unauthorized(!!token);
    if (!token) return deny();
    const hash = await sha256hex(token);

    // A wrong method is only reported to a caller with a valid token; strangers always get 401.
    if (req.method !== 'POST') {
      const a = await cfg.rpc('ai_authenticate', { p_token_hash: hash });
      if (!a.ok) return deny();
      if (path === '/mcp' || path.startsWith('/api/')) return json({ error: { code: 'invalid', message: 'Use POST' } }, 405, { allow: 'POST, OPTIONS' });
      return json({ error: { code: 'not_found', message: 'No such route' } }, 404);
    }

    if (path === '/mcp') return mcp(cfg, req, hash, deny);

    if (path.startsWith('/api/')) {
      const { text, tooLarge } = await readBody(req);
      if (tooLarge) return json({ error: { code: 'invalid', message: 'Request too large' } }, 413);
      let args = {};
      if (text.trim()) { try { args = JSON.parse(text); } catch { return json({ error: { code: 'invalid', message: 'Body must be JSON' } }, 400); } }
      const out = await runTool(cfg, hash, path.slice(5), args);
      if (out.ok) return json(out.result);
      if (out.error.code === 'unauthorized') return deny();
      return json({ error: out.error }, STATUS[out.error.code] || 400);
    }

    // Unknown path, but with a token: still check it, so that nothing here tells a stranger what exists.
    const a = await cfg.rpc('ai_authenticate', { p_token_hash: hash });
    if (!a.ok) return deny();
    return json({ error: { code: 'not_found', message: 'No such route' } }, 404);
  }

  return async (req) => {
    try { return await handle(req); }
    catch (e) {
      console.error('tt:', e && e.message ? e.message : e);
      return json({ error: { code: 'server_error', message: 'Something went wrong on the server' } }, 500);
    }
  };
}
export { CORS };
