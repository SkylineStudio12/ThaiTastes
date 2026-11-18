#!/usr/bin/env node
// Downloads the catalogue photos (dishes, places, region banners) from Wikimedia Commons into web/images/.
// The artifact stored its own copies, which were not part of the export bundle, so they are fetched again from the
// source pages listed in web/credits.json. Run once locally, then commit web/images/ (the photos are CC-licensed and
// the credits are shown in the app).
//
//   node scripts/fetch-stock-images.mjs            # fetch what is missing
//   node scripts/fetch-stock-images.mjs --force    # fetch everything again
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const credits = JSON.parse(readFileSync(join(root, 'credits.json'), 'utf8'));
const force = process.argv.includes('--force');
const UA = 'ThaiTastesPersonalApp/1.0 (personal food journal; fetches the CC-licensed photos it credits)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const titleOf = (page) => decodeURIComponent(new URL(page).pathname.replace(/^\/wiki\//, ''));

async function get(url, as) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * attempt); continue; }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`gave up on ${url}`);
}

async function thumbUrl(title, width) {
  const q = new URLSearchParams({ action: 'query', titles: title, prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: String(width), format: 'json' });
  const j = await get(`https://commons.wikimedia.org/w/api.php?${q}`, 'json');
  const page = Object.values(j.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info) throw new Error(`no image info for ${title}`);
  return info.thumburl || info.url;
}

const manifestPath = join(root, 'images', 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { s: {}, l: {} };
let failed = 0;
for (const c of credits) {
  for (const [dir, width] of [['s', 480], ...(c.large ? [['l', 960]] : [])]) {
    if (!force && manifest[dir][c.key] && existsSync(join(root, manifest[dir][c.key]))) continue;
    try {
      const url = await thumbUrl(titleOf(c.page), width);
      const ext = (url.match(/\.(jpe?g|png|webp)(?:\?|$)/i)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
      const rel = `images/${dir}/${c.key}.${ext}`;
      mkdirSync(join(root, 'images', dir), { recursive: true });
      writeFileSync(join(root, rel), await get(url, 'buf'));
      manifest[dir][c.key] = rel;
      console.log('ok  ', rel);
    } catch (e) { failed++; console.error('FAIL', c.key, dir, e.message); }
    await sleep(400);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(failed ? `${failed} downloads failed; run again to retry them.` : 'All catalogue photos present.');
process.exit(failed ? 1 : 0);
