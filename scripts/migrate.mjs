#!/usr/bin/env node
// Imports the ThaiTastes export bundle into Supabase. Repeatable: rows that already exist are left alone
// (never overwritten, so re-running cannot clobber edits made in the app). Run locally only.
//
//   cd scripts && npm install
//   node migrate.mjs --bundle ../../thaitastes-export --dry-run     # no env file needed, no network
//   node migrate.mjs --bundle ../../thaitastes-export               # real run, reads ../.env.migrate
//   node migrate.mjs --bundle ... --verify-only                     # only run the final checks
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { EXPECTED, PLACE_REMAP, loadBundle, buildPlan, planCounts, compareCounts } from './lib/transform.mjs';

const { values: opt } = parseArgs({
  options: {
    bundle: { type: 'string', default: process.env.BUNDLE_DIR ?? '../../thaitastes-export' },
    env: { type: 'string', default: '../.env.migrate' },
    'dry-run': { type: 'boolean', default: false },
    'verify-only': { type: 'boolean', default: false },
    'skip-photos': { type: 'boolean', default: false },
  },
});

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`\nERROR: ${msg}`); process.exit(1); };
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const unwrap = ({ data, error }, what) => { if (error) fail(`${what}: ${error.message}`); return data; };

// ------------------------------------------------------------------ 1. read and validate the bundle
const bundleDir = resolve(opt.bundle);
let bundle;
try { bundle = loadBundle(bundleDir); } catch (e) { fail(e.message); }

const bucket = 'photos';
// Household id is not known in a dry run, so the path uses a placeholder there.
let householdId = '<household>';
const makePlan = () => buildPlan(bundle, { photoPath: (id) => `${householdId}/${id}.jpg` });
let plan = makePlan();
const counts = planCounts(plan);

log(`Bundle: ${bundleDir}`);
log('Counts found in the bundle:');
for (const [k, v] of Object.entries(counts)) log(`  ${k.padEnd(14)} ${String(v).padStart(3)}   (expected ${EXPECTED[k]})`);
const refs = plan.entries.filter((e) => e.place_id && Object.values(PLACE_REMAP).includes(e.place_id)).length;
log(`Remapped placeId cnx-sanpakoi -> ${PLACE_REMAP['cnx-sanpakoi']} on ${refs} entries`);
log(`Entries with free-text place only: ${plan.entries.filter((e) => !e.place_id && e.place_free).length}; with no place at all: ${plan.entries.filter((e) => !e.place_id && !e.place_free).length}`);
log(`Entries sharing a photo with another entry: ${plan.entries.filter((e) => e.photo_path).length - new Set(plan.entries.filter((e) => e.photo_path).map((e) => e.photo_path)).size}`);

if (plan.problems.length) { plan.problems.forEach((p) => console.error('  problem:', p)); fail('bundle has referential problems; nothing was written'); }
const bundleMismatch = compareCounts(counts);
if (bundleMismatch.length) fail(`bundle counts differ from the known export: ${bundleMismatch.join('; ')}`);
log('Bundle OK: no dangling references, counts match.');
if (opt['dry-run']) { log('\nDry run: nothing was sent to Supabase.'); process.exit(0); }

// ------------------------------------------------------------------ 2. connect
try { process.loadEnvFile(resolve(opt.env)); } catch { fail(`cannot read env file ${resolve(opt.env)} (copy .env.migrate.example and fill it in)`); }
const need = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GREG_EMAIL', 'ANDRA_EMAIL'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) fail(`missing in env file: ${missing.join(', ')}`);
const householdName = process.env.HOUSEHOLD_NAME || 'Greg and Andra';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ------------------------------------------------------------------ 3. household, users, membership
async function ensureHousehold() {
  const found = unwrap(await sb.from('households').select('id').eq('name', householdName).maybeSingle(), 'find household');
  if (found) return found.id;
  return unwrap(await sb.from('households').insert({ name: householdName }).select('id').single(), 'create household').id;
}

async function ensureUser(email) {
  const want = email.trim().toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail(`list users: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === want);
    if (hit) return { id: hit.id, created: false };
    if (data.users.length < 200) break;
  }
  const { data, error } = await sb.auth.admin.createUser({ email: want, email_confirm: true });
  if (error) fail(`create user: ${error.message}`);
  return { id: data.user.id, created: true };
}

async function existingIds(table, col = 'id') {
  const out = new Set();
  for (let from = 0; ; from += 1000) {
    const rows = unwrap(await sb.from(table).select(col).eq('household_id', householdId).order(col).range(from, from + 999), `read ${table}`);
    rows.forEach((r) => out.add(r[col]));
    if (rows.length < 1000) return out;
  }
}

async function insertMissing(table, rows, key = 'id') {
  const have = await existingIds(table, key);
  const todo = rows.filter((r) => !have.has(r[key])).map((r) => ({ household_id: householdId, ...r }));
  for (const c of chunks(todo, 100)) unwrap(await sb.from(table).insert(c), `insert ${table}`);
  log(`  ${table.padEnd(8)} inserted ${String(todo.length).padStart(3)}, already present ${rows.length - todo.length}`);
}

async function listPhotoObjects() {
  const names = new Set();
  for (let offset = 0; ; offset += 100) {
    const items = unwrap(await sb.storage.from(bucket).list(householdId, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }), 'list photos');
    items.forEach((o) => names.add(`${householdId}/${o.name}`));
    if (items.length < 100) return names;
  }
}

async function main() {
  log('\nConnecting to Supabase...');
  householdId = await ensureHousehold();
  plan = makePlan(); // now with the real household folder in photo_path
  log(`Household "${householdName}" ready.`);

  if (!opt['verify-only']) {
    const greg = await ensureUser(process.env.GREG_EMAIL);
    const andra = await ensureUser(process.env.ANDRA_EMAIL);
    log(`Auth users: greg ${greg.created ? 'created' : 'exists'}, andra ${andra.created ? 'created' : 'exists'}`);
    for (const [name, u] of [['greg', greg], ['andra', andra]]) {
      unwrap(await sb.from('household_members').upsert({ household_id: householdId, user_id: u.id, name }, { onConflict: 'user_id' }), 'membership');
    }

    log('\nRows (existing rows are never overwritten):');
    await insertMissing('dishes', plan.dishes);
    await insertMissing('places', plan.places);
    await insertMissing('entries', plan.entries);
    await insertMissing('favs', plan.favs, 'dish_id');

    if (!opt['skip-photos']) {
      const have = await listPhotoObjects();
      const todo = plan.photos.filter((p) => !have.has(p.path));
      for (const p of todo) {
        const { error } = await sb.storage.from(bucket).upload(p.path, readFileSync(p.file), { contentType: 'image/jpeg', upsert: false });
        if (error && !/already exists|Duplicate/i.test(error.message)) fail(`upload ${p.assetId}: ${error.message}`);
      }
      log(`  photos   uploaded ${String(todo.length).padStart(3)}, already present ${plan.photos.length - todo.length}`);
    }
  }

  return verify();
}

// ------------------------------------------------------------------ 4. final check against the bundle
async function verify() {
  log('\nVerification (bundle rows present in the database, by id):');
  const present = async (table, ids, key = 'id') => {
    const have = await existingIds(table, key);
    return ids.filter((i) => have.has(i)).length;
  };
  const got = {
    entries: await present('entries', plan.entries.map((e) => e.id)),
    customDishes: await present('dishes', plan.dishes.filter((d) => !d.builtin).map((d) => d.id)),
    customPlaces: await present('places', plan.places.filter((p) => !p.builtin).map((p) => p.id)),
    favs: await present('favs', plan.favs.map((f) => f.dish_id), 'dish_id'),
    builtinDishes: await present('dishes', plan.dishes.filter((d) => d.builtin).map((d) => d.id)),
    builtinPlaces: await present('places', plan.places.filter((p) => p.builtin).map((p) => p.id)),
  };

  // Photos: every object exists, and every one opens through a signed URL and is byte-identical in size.
  const objects = await listPhotoObjects();
  got.photos = plan.photos.filter((p) => objects.has(p.path)).length;
  const problems = [];
  const signed = unwrap(await sb.storage.from(bucket).createSignedUrls(plan.photos.map((p) => p.path), 300), 'sign urls');
  const byPath = new Map(plan.photos.map((p) => [p.path, p]));
  let opened = 0;
  for (const s of signed) {
    if (s.error || !s.signedUrl) { problems.push(`photo ${s.path}: ${s.error ?? 'no signed url'}`); continue; }
    const res = await fetch(s.signedUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    const want = readFileSync(byPath.get(s.path).file);
    if (!res.ok) problems.push(`photo ${s.path}: HTTP ${res.status}`);
    else if (buf[0] !== 0xff || buf[1] !== 0xd8) problems.push(`photo ${s.path}: not a JPEG`);
    else if (buf.length !== want.length) problems.push(`photo ${s.path}: ${buf.length} bytes, expected ${want.length}`);
    else opened++;
  }
  log(`  photos that open via signed URL: ${opened}/${plan.photos.length}`);

  // Entries must point at photos that exist, and the remapped place must be in use.
  const dbEntries = unwrap(await sb.from('entries').select('id, photo_path, place_id').eq('household_id', householdId).in('id', plan.entries.map((e) => e.id)), 'read entries');
  for (const e of dbEntries) if (e.photo_path && !objects.has(e.photo_path)) problems.push(`entry ${e.id}: photo_path ${e.photo_path} has no object`);
  const planById = new Map(plan.entries.map((e) => [e.id, e]));
  for (const e of dbEntries) {
    const want = planById.get(e.id);
    if (want.place_id !== e.place_id) problems.push(`entry ${e.id}: place_id ${e.place_id}, expected ${want.place_id}`);
  }

  log('  counts:');
  for (const [k, v] of Object.entries(got)) log(`    ${k.padEnd(14)} ${String(v).padStart(3)} / expected ${EXPECTED[k]}`);
  const totals = {};
  for (const t of ['entries', 'dishes', 'places', 'favs']) {
    const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('household_id', householdId);
    if (error) fail(`count ${t}: ${error.message}`);
    totals[t] = count;
  }
  log(`  database totals now (include anything added since the import): ${JSON.stringify(totals)}`);

  const bad = [...compareCounts(got), ...problems];
  if (bad.length) { bad.forEach((b) => console.error('  MISMATCH:', b)); fail('verification failed'); }
  log('\nAll counts match the bundle and every photo opens. Migration verified.');
}

main().catch((e) => fail(e.stack ?? String(e)));
