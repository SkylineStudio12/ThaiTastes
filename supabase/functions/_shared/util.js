// Small helpers shared by the routes. Web-standard APIs only, so the same code runs on Deno (Supabase) and Node (tests).
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export const randomHex = (bytes = 32) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

// PKCE S256: base64url(sha256(verifier)), no padding.
export async function s256(verifier) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'Access-Control-Expose-Headers': 'www-authenticate',
  'Access-Control-Max-Age': '86400',
};

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...headers } });

export const MAX_BODY = 100_000;

// Reads the body as text, refusing anything over MAX_BODY bytes.
export async function readBody(req) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return { tooLarge: true };
  const text = await req.text();
  if (enc.encode(text).length > MAX_BODY) return { tooLarge: true };
  return { text };
}

export function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '');
  return m ? m[1] : null;
}

// The address the platform saw. Only used as a rate-limit key for the open OAuth routes.
export const callerIp = (req) => (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
