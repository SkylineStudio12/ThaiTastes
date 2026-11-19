#!/usr/bin/env node
// Builds the app icons in web/icons/ from design/app-icon.png (a square tile with rounded, transparent corners).
//   cd scripts && npm install   (once, for sharp)
//   node scripts/make-icons.mjs
// iOS and Android's "maskable" icons must be opaque squares (the system cuts its own corner shape, and iOS shows
// transparent corners as black), so for those the corners are filled by extending the tile's edge colours. The
// "any" icons and the favicon keep the rounded shape as designed.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let sharp;
try { sharp = (await import('sharp')).default; }
catch { console.error('This script needs sharp. Run first:  cd scripts && npm install'); process.exit(1); }

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2] ?? join(repo, 'design', 'app-icon.png');
const out = join(repo, 'web', 'icons');

const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
if (W !== H) { console.error(`The source must be square (got ${W}x${H}).`); process.exit(1); }
const at = (x, y) => (y * W + x) * 4;

// Background for the corners: per row, the colour of the nearest fully opaque pixel from each side.
const bg = Buffer.alloc(W * H * 4);
const rowFilled = new Array(H).fill(false);
for (let y = 0; y < H; y++) {
  let first = -1, last = -1;
  for (let x = 0; x < W; x++) if (data[at(x, y) + 3] === 255) { if (first < 0) first = x; last = x; }
  if (first < 0) continue;
  rowFilled[y] = true;
  for (let x = 0; x < W; x++) {
    const from = x < first ? first : x > last ? last : x;
    data.copy(bg, at(x, y), at(from, y), at(from, y) + 3); bg[at(x, y) + 3] = 255;
  }
}
// Rows with no opaque pixel at all (the very top or bottom edge) copy the nearest filled row.
for (let y = 0; y < H; y++) if (!rowFilled[y]) {
  let n = -1;
  for (let d = 1; d < H && n < 0; d++) { if (y - d >= 0 && rowFilled[y - d]) n = y - d; else if (y + d < H && rowFilled[y + d]) n = y + d; }
  bg.copy(bg, at(0, y), at(0, n), at(0, n) + W * 4);
}

const rounded = await sharp(src).png().toBuffer();
// The artwork has a light rim along its rounded edge. Cropping a few percent inward takes it off the straight edges;
// the system's own corner mask hides what is left in the corners.
const inset = Math.round(W * 0.04);
const full = await sharp(await sharp(bg, { raw: { width: W, height: H, channels: 4 } })
  .composite([{ input: rounded }]).flatten({ background: '#ff0000' }).removeAlpha().png().toBuffer())
  .extract({ left: inset, top: inset, width: W - 2 * inset, height: H - 2 * inset }).png().toBuffer();

const make = (input, size, name) => sharp(input).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(join(out, name));
await make(full, 180, 'apple-touch-icon.png');
await make(full, 512, 'maskable-512.png');
await make(rounded, 192, 'icon-192.png');
await make(rounded, 512, 'icon-512.png');
await make(rounded, 64, 'favicon-64.png');
console.log('Wrote apple-touch-icon.png, maskable-512.png, icon-192.png, icon-512.png, favicon-64.png to web/icons/.');
