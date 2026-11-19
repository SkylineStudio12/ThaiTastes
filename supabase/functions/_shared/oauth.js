// Minimal OAuth 2.1 authorization server for MCP clients (authorization code + PKCE, dynamic client registration,
// rotating refresh tokens). It issues the same hashed tokens as Settings > AI tokens: an OAuth token is just an
// ai_clients row with an expiry and a refresh token. Consent happens in the app, where the user is signed in.
import { json, CORS, s256, sha256hex, randomHex, readBody, callerIp } from './util.js';

export const ACCESS_TTL = 3600;
const SCOPE = 'journal';

export function protectedResourceMetadata(cfg) {
  return {
    resource: cfg.base + '/mcp',
    authorization_servers: [cfg.base],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'ThaiTastes',
  };
}

// Served at <issuer>/.well-known/openid-configuration and .../oauth-authorization-server. An Edge Function cannot
// serve /.well-known at the host root, so clients find this through the path-appended OpenID form. Strict OpenID
// parsers require the last three fields; no ID tokens are issued, the "openid" scope is not offered, and the key
// set is empty.
export function authServerMetadata(cfg) {
  return {
    issuer: cfg.base,
    authorization_endpoint: cfg.base + '/authorize',
    token_endpoint: cfg.base + '/token',
    registration_endpoint: cfg.base + '/register',
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE, 'offline_access'],
    authorization_response_iss_parameter_supported: true,
    jwks_uri: cfg.base + '/jwks',
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  };
}

const oauthError = (error, description, status = 400) => json({ error, ...(description ? { error_description: description } : {}) }, status);

async function limited(cfg, req, bucket, limit, seconds) {
  return !(await cfg.rpc('rate_limit_hit', { p_key: `ip:${bucket}:${callerIp(req)}`, p_limit: limit, p_window_seconds: seconds }));
}

export async function register(cfg, req) {
  if (await limited(cfg, req, 'register', 20, 3600)) return oauthError('temporarily_unavailable', 'Too many registrations. Try again later.', 429);
  const { text, tooLarge } = await readBody(req);
  if (tooLarge) return oauthError('invalid_client_metadata', 'Request too large', 413);
  let body; try { body = JSON.parse(text); } catch { return oauthError('invalid_client_metadata', 'Body must be JSON'); }
  const uris = body && body.redirect_uris;
  if (!Array.isArray(uris) || !uris.every((u) => typeof u === 'string')) return oauthError('invalid_redirect_uri', 'redirect_uris must be a list of strings');
  const res = await cfg.rpc('oauth_register', { p_name: typeof body.client_name === 'string' ? body.client_name : '', p_redirect_uris: uris });
  if (res.error) return oauthError(res.error, res.error_description);
  return json({ ...res, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
}

const page = (title, text, status) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:16px system-ui;margin:3rem auto;max-width:30rem;padding:0 1rem"><h1 style="font-size:1.3rem">${title}</h1><p>${text}</p>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

function redirectBack(cfg, uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  u.searchParams.set('iss', cfg.base);
  return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
}

export async function authorize(cfg, req, url) {
  if (await limited(cfg, req, 'authorize', 60, 3600)) return page('Too many requests', 'Try again in a while.', 429);
  const q = url.searchParams;
  const begin = await cfg.rpc('oauth_begin', {
    p_client_id: q.get('client_id') || '', p_redirect_uri: q.get('redirect_uri'), p_state: q.get('state'),
    p_code_challenge: q.get('code_challenge_method') === 'S256' ? q.get('code_challenge') : null, p_resource: q.get('resource'),
  });
  // Never redirect to an address that is not registered for this client: show the problem here instead.
  if (begin.error === 'invalid_client') return page('Unknown app', 'This app is not registered with ThaiTastes. Remove the connector and add it again.', 400);
  if (begin.error === 'invalid_redirect_uri') return page('Request refused', 'The return address does not match the one this app registered.', 400);
  if (begin.error) return redirectBack(cfg, q.get('redirect_uri'), { error: 'invalid_request', error_description: 'PKCE with S256 is required', state: q.get('state') });
  if (q.get('response_type') !== 'code') return redirectBack(cfg, q.get('redirect_uri'), { error: 'unsupported_response_type', state: q.get('state') });
  const app = new URL(cfg.appUrl);
  app.searchParams.set('authorize', begin.request_id);
  return new Response(null, { status: 302, headers: { location: app.toString(), 'cache-control': 'no-store' } });
}

export async function token(cfg, req) {
  if (await limited(cfg, req, 'token', 120, 3600)) return oauthError('temporarily_unavailable', 'Too many requests. Try again later.', 429);
  const { text, tooLarge } = await readBody(req);
  if (tooLarge) return oauthError('invalid_request', 'Request too large', 413);
  let p;
  if ((req.headers.get('content-type') || '').includes('application/json')) { try { p = new Map(Object.entries(JSON.parse(text))); } catch { return oauthError('invalid_request', 'Bad JSON'); } }
  else p = new URLSearchParams(text);
  const get = (k) => { const v = p.get(k); return typeof v === 'string' && v ? v : null; };
  const access = 'tt_' + randomHex(32), refresh = 'ttr_' + randomHex(32);
  const fresh = { p_token_hash: await sha256hex(access), p_token_prefix: access.slice(0, 9), p_ttl_seconds: ACCESS_TTL };
  let res;
  if (get('grant_type') === 'authorization_code') {
    if (!get('code') || !get('client_id') || !get('redirect_uri') || !get('code_verifier')) return oauthError('invalid_request', 'code, client_id, redirect_uri and code_verifier are required');
    res = await cfg.rpc('oauth_exchange', {
      p_code_hash: await sha256hex(get('code')), p_client_id: get('client_id'), p_redirect_uri: get('redirect_uri'),
      p_code_challenge: await s256(get('code_verifier')), p_refresh_hash: await sha256hex(refresh), ...fresh });
  } else if (get('grant_type') === 'refresh_token') {
    if (!get('refresh_token') || !get('client_id')) return oauthError('invalid_request', 'refresh_token and client_id are required');
    res = await cfg.rpc('oauth_refresh', {
      p_refresh_hash: await sha256hex(get('refresh_token')), p_client_id: get('client_id'), p_new_refresh_hash: await sha256hex(refresh), ...fresh });
  } else return oauthError('unsupported_grant_type');
  if (res.error) return oauthError(res.error, 'The code or refresh token is invalid, expired or already used');
  return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE }, 200, { pragma: 'no-cache' });
}

export const preflight = () => new Response(null, { status: 204, headers: CORS });
