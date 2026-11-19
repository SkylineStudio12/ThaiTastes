// Static file server for web/ (local development and tests). Optional env: PORT, SUPABASE_URL, SUPABASE_ANON_KEY
// (they replace js/config.js on the fly, so the real file stays untouched).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

export function serve({ port = Number(process.env.PORT) || 8080, url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY } = {}) {
  const server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    try {
      let body = await readFile(file);
      if (p === '/js/config.js' && url) body = Buffer.from(`export const SUPABASE_URL = ${JSON.stringify(url)};\nexport const SUPABASE_ANON_KEY = ${JSON.stringify(anon || 'anon')};\nexport const BUILD = 'dev';\n`);
      if (p === '/sw.js') body = Buffer.from(body.toString().replace('__BUILD__', 'dev'));
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, port: server.address().port, close: () => { server.closeAllConnections?.(); server.close(); } })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await serve();
  console.log(`http://127.0.0.1:${s.port}/`);
}
