// Pure transformation of the export bundle into rows for Postgres. No network, no Supabase.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// The numbers the bundle is known to contain (export of 18 Nov 2026). Used for the final count check.
export const EXPECTED = Object.freeze({
  entries: 85,
  customDishes: 62,
  customPlaces: 28,
  favs: 16,
  photos: 35,
  builtinDishes: 47,
  builtinPlaces: 56,
});

// README quirk: entries use placeId "cnx-sanpakoi"; the owner asked for it to map to the custom place below.
export const PLACE_REMAP = Object.freeze({ 'cnx-sanpakoi': 'o0vflgkc8hbdyc43p7m0' });

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const listDir = (dir, ext) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : []);
const iso = (ms) => (ms == null ? undefined : new Date(ms).toISOString());
const nn = (v) => (v === undefined || v === '' ? null : v); // empty/undefined -> null, keep 0 and false

export function loadBundle(dir) {
  if (!existsSync(join(dir, 'README.md')) || !existsSync(join(dir, 'builtin'))) {
    throw new Error(`${dir} does not look like the export bundle (README.md / builtin/ missing)`);
  }
  const docs = (sub) =>
    listDir(join(dir, sub), '.json').map((f) => ({ id: basename(f, '.json'), ...readJson(join(dir, sub, f)) }));
  return {
    dir,
    builtinDishes: readJson(join(dir, 'builtin/dishes.json')),
    builtinPlaces: readJson(join(dir, 'builtin/places.json')),
    dishes: docs('dishes'),
    places: docs('places'),
    entries: docs('entries'),
    favs: docs('favs'),
    photoFiles: listDir(join(dir, 'photos'), '.jpg').map((f) => basename(f, '.jpg')),
  };
}

/**
 * Builds rows. Household id is injected later (`household_id` is not set here) and photo_path is built
 * from `photoPath(assetId)`, so the same plan works in dry-run (no household yet) and in a real run.
 */
export function buildPlan(bundle, { photoPath = (id) => `photos/${id}.jpg` } = {}) {
  const problems = [];

  // The original app stored the romanised name as `rom`, except for two builtin dishes that used `ro`.
  const dish = (d, builtin) => ({
    id: d.id,
    rom: d.rom ?? d.ro ?? null,
    th: nn(d.th),
    d: nn(d.d),
    region: d.r,
    sublabel: nn(d.sub),
    builtin,
    ...(builtin ? {} : { created_at: iso(d.createdAt) }),
  });
  const place = (p, builtin) => ({
    id: p.id,
    name: p.n,
    th: nn(p.th),
    address: nn(p.a),
    stage: p.st,
    lat: p.c ? p.c[0] : null,
    lng: p.c ? p.c[1] : null,
    note: nn(p.note),
    builtin,
    ...(builtin ? {} : { created_at: iso(p.createdAt) }),
  });

  const dishes = [...bundle.builtinDishes.map((d) => dish(d, true)), ...bundle.dishes.map((d) => dish(d, false))];
  const places = [...bundle.builtinPlaces.map((p) => place(p, true)), ...bundle.places.map((p) => place(p, false))];

  const dishIds = new Set(dishes.map((d) => d.id));
  const placeIds = new Set(places.map((p) => p.id));
  const photoIds = new Set(bundle.photoFiles);

  for (const [what, rows] of [['dish', dishes], ['place', places]]) {
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.id)) problems.push(`duplicate ${what} id ${r.id}`);
      seen.add(r.id);
    }
  }
  for (const d of dishes) if (!d.rom) problems.push(`dish ${d.id} has no romanised name`);

  const entries = bundle.entries.map((e) => {
    const placeId = e.placeId == null ? null : (PLACE_REMAP[e.placeId] ?? e.placeId);
    if (placeId && !placeIds.has(placeId)) problems.push(`entry ${e.id}: unknown place ${e.placeId}`);
    if (e.dishId && !dishIds.has(e.dishId)) problems.push(`entry ${e.id}: unknown dish ${e.dishId}`);
    if (!e.dishId && !e.dishFree) problems.push(`entry ${e.id}: no dish and no dishFree`);
    const assetId = e.photo?.id ?? null;
    if (assetId && !photoIds.has(assetId)) problems.push(`entry ${e.id}: photo ${assetId}.jpg is not in the bundle`);
    return {
      id: e.id,
      dish_id: nn(e.dishId),
      dish_free: nn(e.dishFree),
      place_id: placeId,
      place_free: nn(e.placeFree),
      date: e.date,
      stage: e.stage,
      rating_greg: nn(e.g),
      rating_andra: nn(e.a),
      price_thb: nn(e.price),
      spice: nn(e.spice),
      again: nn(e.again),
      note: nn(e.note),
      photo_path: assetId ? photoPath(assetId) : null,
      // The artifact never recorded who wrote an entry. See README "Migrated entries".
      author: 'greg',
      source_client: 'migration',
      created_at: iso(e.createdAt),
      updated_at: iso(e.updatedAt ?? e.createdAt),
    };
  });

  const favs = bundle.favs.map((f) => {
    if (!dishIds.has(f.id)) problems.push(`fav ${f.id}: unknown dish`);
    return { dish_id: f.id, created_at: iso(f.at) };
  });

  const referenced = new Set(entries.filter((e) => e.photo_path).map((e) => e.photo_path));
  const photos = bundle.photoFiles.map((id) => ({ assetId: id, path: photoPath(id), file: join(bundle.dir, 'photos', `${id}.jpg`) }));
  for (const p of photos) if (!statSync(p.file).size) problems.push(`photo ${p.assetId} is empty`);
  for (const p of photos) if (!referenced.has(p.path)) problems.push(`photo ${p.assetId} is not referenced by any entry`);

  return { dishes, places, entries, favs, photos, problems };
}

export function planCounts(plan) {
  return {
    entries: plan.entries.length,
    customDishes: plan.dishes.filter((d) => !d.builtin).length,
    customPlaces: plan.places.filter((p) => !p.builtin).length,
    favs: plan.favs.length,
    photos: plan.photos.length,
    builtinDishes: plan.dishes.filter((d) => d.builtin).length,
    builtinPlaces: plan.places.filter((p) => p.builtin).length,
  };
}

/** Returns an array of "name: got X, expected Y" strings; empty means everything matches. */
export function compareCounts(got, expected = EXPECTED) {
  return Object.keys(expected)
    .filter((k) => got[k] !== expected[k])
    .map((k) => `${k}: got ${got[k]}, expected ${expected[k]}`);
}
