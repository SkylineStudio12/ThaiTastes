import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundle, buildPlan, planCounts, compareCounts } from './lib/transform.mjs';

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'tt-'));
  for (const s of ['builtin', 'dishes', 'places', 'entries', 'favs', 'photos']) mkdirSync(join(d, s));
  writeFileSync(join(d, 'README.md'), 'x');
  const j = (p, o) => writeFileSync(join(d, p), JSON.stringify(o));
  j('builtin/dishes.json', [{ id: 'n1', r: 'nord', th: 'ข', rom: 'khao soi', d: 'x' }, { id: 'e2', r: 'est', ro: 'Chanthaburi noodles' }]);
  j('builtin/places.json', [{ id: 'cnx-sanpakoi', st: 'cnx', n: 'Kanomjeen Sanpakoi', c: [18.7, 99.0] }]);
  j('dishes/m-a.json', { r: 'dulci', rom: 'mango', createdAt: 1793935029013 });
  j('places/o0vflgkc8hbdyc43p7m0.json', { n: 'Kanomjeen Sanpakoi ขนม', st: 'cnx', a: 'addr', createdAt: 1794068088787 });
  j('favs/n1.json', { at: 1793970907663 });
  writeFileSync(join(d, 'photos/abc.jpg'), 'jpegdata');
  const base = { date: '2026-11-07', stage: 'cnx', g: 4, a: null, price: 0, spice: 0, again: false, note: '', photo: null, placeId: null, placeFree: null, dishFree: null, createdAt: 1793935029013, updatedAt: 1794000000000 };
  j('entries/e-a.json', { ...base, dishId: 'n1', placeId: 'cnx-sanpakoi', photo: { id: 'abc', url: '/_blob/abc' } });
  j('entries/e-b.json', { ...base, dishId: 'm-a', placeFree: 'a market' });
  return d;
}

test('maps quirks and keeps falsy values', () => {
  const plan = buildPlan(loadBundle(fixture()), { photoPath: (id) => `H/${id}.jpg` });
  assert.deepEqual(plan.problems, []);
  const e = Object.fromEntries(plan.entries.map((x) => [x.id, x]));
  assert.equal(e['e-a'].place_id, 'o0vflgkc8hbdyc43p7m0');           // remap
  assert.equal(e['e-a'].photo_path, 'H/abc.jpg');
  assert.equal(e['e-b'].place_free, 'a market');                     // free text kept
  assert.equal(e['e-b'].place_id, null);
  assert.equal(e['e-b'].price_thb, 0);                               // 0 is not null
  assert.equal(e['e-b'].spice, 0);
  assert.equal(e['e-b'].again, false);
  assert.equal(e['e-b'].note, null);                                 // '' -> null
  assert.equal(e['e-b'].updated_at, new Date(1794000000000).toISOString());
  assert.equal(plan.dishes.find((d) => d.id === 'e2').rom, 'Chanthaburi noodles'); // ro -> rom
  assert.equal(plan.places[0].lat, 18.7);
  assert.equal(plan.favs[0].created_at, new Date(1793970907663).toISOString());
  assert.deepEqual(planCounts(plan), { entries: 2, customDishes: 1, customPlaces: 1, favs: 1, photos: 1, builtinDishes: 2, builtinPlaces: 1 });
});

test('reports dangling references instead of dropping data', () => {
  const d = fixture();
  writeFileSync(join(d, 'entries/e-c.json'), JSON.stringify({ date: '2026-11-07', stage: 'cnx', dishId: 'nope', placeId: 'nowhere', photo: { id: 'missing' } }));
  const plan = buildPlan(loadBundle(d));
  assert.equal(plan.entries.length, 3);
  assert.equal(plan.problems.length, 3);
});

test('compareCounts', () => {
  assert.deepEqual(compareCounts({ entries: 85, customDishes: 62, customPlaces: 28, favs: 16, photos: 35, builtinDishes: 47, builtinPlaces: 56 }), []);
  assert.equal(compareCounts({ entries: 84, customDishes: 62, customPlaces: 28, favs: 16, photos: 35, builtinDishes: 47, builtinPlaces: 56 }).length, 1);
});
