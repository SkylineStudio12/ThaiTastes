// Pure conversions between database rows and the shapes the UI works with (the original app's field names).
const ms = (iso) => (iso ? Date.parse(iso) : 0);
const iso = (n) => (n ? new Date(n).toISOString() : undefined);
const nn = (v) => (v === undefined || v === '' ? null : v);

export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(b, (x) => '0123456789abcdefghijklmnopqrstuvwxyz'[x % 36]).join('');
}

export const dishFromRow = (r) => ({
  id: r.id, r: r.region, rom: r.rom, th: r.th || undefined, d: r.d || undefined, sub: r.sublabel || undefined,
  custom: !r.builtin, createdAt: ms(r.created_at),
});
export const dishToRow = (hid, d) => ({
  household_id: hid, id: d.id, rom: d.rom, th: nn(d.th), d: nn(d.d), region: d.r, sublabel: nn(d.sub), builtin: false,
  ...(d.createdAt ? { created_at: iso(d.createdAt) } : {}),
});

export const placeFromRow = (r) => ({
  id: r.id, st: r.stage, n: r.name, th: r.th || undefined, a: r.address || undefined,
  c: r.lat != null && r.lng != null ? [r.lat, r.lng] : undefined, ig: r.ig || null, note: r.note || null,
  custom: !r.builtin, createdAt: ms(r.created_at),
});
export const placeToRow = (hid, p) => ({
  household_id: hid, id: p.id, name: p.n, th: nn(p.th), address: nn(p.a), stage: p.st, ig: nn(p.ig), note: nn(p.note), builtin: false,
  ...(p.c ? { lat: p.c[0], lng: p.c[1] } : {}),
  ...(p.createdAt ? { created_at: iso(p.createdAt) } : {}),
});

export const entryFromRow = (r, photoUrl) => ({
  id: r.id, dishId: r.dish_id, dishFree: r.dish_free, placeId: r.place_id, placeFree: r.place_free,
  date: r.date, stage: r.stage, g: r.rating_greg, a: r.rating_andra, price: r.price_thb, spice: r.spice,
  again: r.again, note: r.note, photo: r.photo_path ? { id: r.photo_path, url: photoUrl || '' } : null,
  author: r.author, sourceClient: r.source_client, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at),
});

/** The fields the entry form edits. Anything else on the row (again, author, source_client) is left alone. */
export const entryEditable = (e) => ({
  dish_id: nn(e.dishId), dish_free: nn(e.dishFree), place_id: nn(e.placeId), place_free: nn(e.placeFree),
  date: e.date, stage: e.stage, rating_greg: nn(e.g), rating_andra: nn(e.a), price_thb: e.price ?? null,
  spice: e.spice ?? null, note: nn(e.note), photo_path: e.photo ? e.photo.id : null,
});

/** A full row for inserting an entry (new or restored after Undo). */
export const entryToRow = (hid, e, defaults) => ({
  household_id: hid, id: e.id, ...entryEditable(e),
  again: e.again ?? null, author: e.author ?? defaults.author, source_client: e.sourceClient ?? defaults.sourceClient,
  ...(e.createdAt ? { created_at: iso(e.createdAt) } : {}),
  ...(e.createdAt && e.updatedAt ? { updated_at: iso(e.updatedAt) } : {}),
});

/** Keys whose values differ, as a patch. */
export function diff(base, next) {
  const out = {};
  for (const k of Object.keys(next)) if ((base[k] ?? null) !== (next[k] ?? null)) out[k] = next[k];
  return out;
}

export const suggestionFromRow = (r) => ({
  id: r.id, author: r.author, kind: r.kind, payload: r.payload || {}, status: r.status, createdAt: ms(r.created_at),
});
