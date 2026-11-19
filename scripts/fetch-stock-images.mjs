#!/usr/bin/env node
// Downloads the catalogue photos (dishes, places, region banners) from Wikimedia Commons into web/images/ and stores
// them as WebP (quality 80). Wikimedia already resizes them: 480 px wide in images/s/, 960 px banners in images/l/.
// The artifact stored its own copies, which were not part of the export bundle, so they are fetched again from the
// source pages listed in web/credits.json. Run once locally, then commit web/images/ (the photos are CC-licensed and
// the credits are shown in the app).
//
// Needs sharp:  cd scripts && npm install
//   node scripts/fetch-stock-images.mjs            # fetch what is missing (and convert earlier JPEG downloads)
//   node scripts/fetch-stock-images.mjs --force    # fetch everything again
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let sharp;
try { sharp = (await import('sharp')).default; }
catch { console.error('This script needs sharp to make WebP files. Run first:  cd scripts && npm install'); process.exit(1); }

const root = process.env.TT_WEB_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
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
const toWebp = (buf) => sharp(buf).autoOrient().webp({ quality: 80 }).toBuffer();
for (const c of credits) {
  for (const [dir, width] of [['s', 480], ...(c.large ? [['l', 960]] : [])]) {
    const had = manifest[dir][c.key];
    if (!force && had && had.endsWith('.webp') && existsSync(join(root, had))) continue;
    try {
      const url = await thumbUrl(titleOf(c.page), width);
      const rel = `images/${dir}/${c.key}.webp`;
      mkdirSync(join(root, 'images', dir), { recursive: true });
      writeFileSync(join(root, rel), await toWebp(await get(url, 'buf')));
      manifest[dir][c.key] = rel;
      if (had && had !== rel && existsSync(join(root, had))) rmSync(join(root, had));   // an earlier JPEG download
      console.log('ok  ', rel);
    } catch (e) { failed++; console.error('FAIL', c.key, dir, e.message); }
    await sleep(400);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
const files = [...Object.values(manifest.s), ...Object.values(manifest.l)].filter((r) => existsSync(join(root, r)));
const kb = Math.round(files.reduce((n, r) => n + statSync(join(root, r)).size, 0) / 1024);
console.log(`${files.length} photos, ${kb} KB in total.`);
console.log(failed ? `${failed} downloads failed; run again to retry them.` : 'All catalogue photos present.');
process.exit(failed ? 1 : 0);
