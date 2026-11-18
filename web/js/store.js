// Data layer: a local copy of the household's rows, an outbox of changes made while offline, and live updates.
//
// - Reads come from the local copy (IndexedDB), so the app opens and works without a connection.
// - Writes are applied to the view at once and queued in the outbox; they are sent in order whenever we are online.
// - Updates to an entry send only the fields that changed, guarded by updated_at, so an edit made elsewhere (for example
//   by Claude or ChatGPT) to other fields is merged instead of overwritten. If the same field changed on both sides,
//   the person's edit is applied last and wins.
// - Realtime changes from the server are merged into the local copy as they arrive.
import * as M from './mapping.js';
import { DISH_ORDER, PLACE_ORDER } from './catalog-order.js';

const TABLES = ['entries', 'dishes', 'places', 'favs', 'suggestions'];
const PK = { entries: 'id', dishes: 'id', places: 'id', favs: 'dish_id', suggestions: 'id' };
const BUCKET = 'photos';
const SIGN_SECONDS = 12 * 3600;

export async function createStore({ sb, householdId: hid, me, db }) {
  const server = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
  let outbox = [], seq = 0;
  const objUrls = new Map();            // photo path -> blob: URL (works offline)
  const signed = new Map();             // photo path -> { url, exp } until the blob is cached
  const listeners = new Set(), errorListeners = new Set();
  const status = { online: typeof navigator === 'undefined' || navigator.onLine !== false, syncing: false, lastSync: null, lastError: null, realtime: 'off' };
  let snap = null, emitQueued = false, flushing = null, pulling = null, channel = null, stopped = false;
  const timers = {};

  // ------------------------------------------------------------------ persistence
  const rowsKey = (t) => `rows:${hid}:${t}`;
  const outKey = `outbox:${hid}`;
  const later = (k, fn, ms = 250) => { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); };
  const persistRows = (t) => later(t, () => db.set(rowsKey(t), [...server[t].values()]).catch(() => {}));
  const persistOutbox = () => db.set(outKey, outbox).catch(() => {});

  // ------------------------------------------------------------------ view
  function emit() {
    snap = null;
    if (emitQueued) return;
    emitQueued = true;
    queueMicrotask(() => { emitQueued = false; for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } });
  }
  const urlFor = (path) => objUrls.get(path) || (signed.get(path)?.exp > Date.now() ? signed.get(path).url : '');

  function overlay() {
    const t = Object.fromEntries(TABLES.map((n) => [n, new Map(server[n])]));
    const now = new Date().toISOString();
    for (const op of outbox) {
      if (op.t === 'put') t[op.table].set(op.row[PK[op.table]], { created_at: now, updated_at: now, ...op.row });
      else if (op.t === 'patch') { const cur = t[op.table].get(op.id); if (cur) t[op.table].set(op.id, { ...cur, ...op.patch }); }
      else if (op.t === 'del') t[op.table].delete(op.id);
    }
    return t;
  }

  function snapshot() {
    if (snap) return snap;
    const t = overlay();
    const order = (ids) => new Map(ids.map((id, i) => [id, i]));
    const dOrder = order(DISH_ORDER), pOrder = order(PLACE_ORDER);
    const split = (rows, from, ord) => {
      const all = [...rows.values()].map(from);
      const builtin = all.filter((x) => !x.custom).sort((a, b) => (ord.get(a.id) ?? 1e6) - (ord.get(b.id) ?? 1e6));
      const custom = all.filter((x) => x.custom).sort((a, b) => a.createdAt - b.createdAt);
      return { builtin, custom };
    };
    snap = {
      entries: [...t.entries.values()].map((r) => M.entryFromRow(r, urlFor(r.photo_path))),
      dishes: split(t.dishes, M.dishFromRow, dOrder),
      places: split(t.places, M.placeFromRow, pOrder),
      favs: new Set(t.favs.keys()),
      suggestions: [...t.suggestions.values()].map(M.suggestionFromRow).sort((a, b) => b.createdAt - a.createdAt),
      status: { ...status, pending: outbox.length },
    };
    return snap;
  }

  // ------------------------------------------------------------------ outbox
  function enqueue(op) {
    op.seq = ++seq; outbox.push(op); persistOutbox(); emit(); kick();
  }
  const dropOps = (pred) => { const n = outbox.length; outbox = outbox.filter((o) => !pred(o)); if (outbox.length !== n) persistOutbox(); return n - outbox.length; };
  const kick = () => { if (status.online && !stopped) flush().catch(() => {}); };
  const currentRow = (table, id) => overlay()[table].get(id);

  function reportError(msg) { status.lastError = msg; for (const fn of errorListeners) fn(msg); emit(); }

  // Network failures and 5xx are retried later; everything else (permission, constraint) is reported and dropped.
  function classify(error, httpStatus) {
    if (!error) return 'ok';
    const net = !error.code && (httpStatus === 0 || httpStatus === undefined || /fetch|network|load failed|abort/i.test(error.message || ''));
    if (net || httpStatus >= 500 || httpStatus === 401) return 'retry';
    return 'drop';
  }

  async function runOp(op) {
    const done = (r) => {
      const c = classify(r.error, r.status);
      if (c === 'drop') reportError(`A change could not be saved (${r.error.message}).`);
      return c;
    };
    if (op.t === 'upload') {
      const blob = await db.getPhoto(op.path);
      if (!blob) return 'drop';
      const { error } = await sb.storage.from(BUCKET).upload(op.path, blob, { contentType: blob.type || 'image/jpeg', upsert: true });
      return done({ error, status: error?.statusCode ? Number(error.statusCode) : error ? 0 : 200 });
    }
    if (op.t === 'rmphoto') {
      const { error } = await sb.storage.from(BUCKET).remove([op.path]);
      return done({ error, status: error ? 0 : 200 });
    }
    const q = sb.from(op.table);
    if (op.t === 'put') {
      const r = await q.insert(op.row);
      if (r.error?.code === '23505') return 'ok';           // already there: the earlier attempt got through
      return done(r);
    }
    if (op.t === 'del') return done(await q.delete().eq('household_id', hid).eq(PK[op.table], op.id));
    if (op.t === 'patch' && op.table !== 'entries') return done(await q.update(op.patch).eq('household_id', hid).eq(PK[op.table], op.id));
    if (op.t === 'patch') {
      for (let attempt = 0; attempt < 5; attempt++) {
        const cur = await q.select('*').eq('household_id', hid).eq('id', op.id).maybeSingle();
        if (cur.error) return done(cur);
        if (!cur.data) return 'drop';                         // deleted elsewhere: nothing to update
        const patch = M.diff(cur.data, op.patch);
        if (!Object.keys(patch).length) return 'ok';
        const r = await sb.from('entries').update(patch).eq('household_id', hid).eq('id', op.id).eq('updated_at', cur.data.updated_at).select();
        if (r.error) return done(r);
        if (r.data?.length) { server.entries.set(op.id, r.data[0]); persistRows('entries'); return 'ok'; }
      }
      reportError('An edit could not be saved because the entry kept changing. Open it and try again.');
      return 'drop';
    }
    return 'drop';
  }

  // One run at a time; later callers share it. (The slot is cleared by the promise itself, never from inside it,
  // so a run that finishes without awaiting cannot leave a stale promise behind.)
  function once(get, set, run) {
    if (get()) return get();
    const p = run(); set(p);
    p.then(() => { if (get() === p) set(null); }, () => { if (get() === p) set(null); });
    return p;
  }

  function flush() { return once(() => flushing, (v) => { flushing = v; }, runFlush); }
  function runFlush() {
    return (async () => {
      let ran = 0;
      status.syncing = true; emit();
      try {
        while (outbox.length && status.online) {
          const op = outbox[0];
          let r;
          try { r = await runOp(op); } catch (e) { r = 'retry'; status.lastError = String(e?.message || e); }
          if (r === 'retry') break;
          if (outbox[0] === op) outbox.shift(); else outbox = outbox.filter((o) => o !== op);
          ran++; persistOutbox();
        }
      } finally { status.syncing = false; emit(); }
      if (ran) await pull().catch(() => {});
    })();
  }

  // ------------------------------------------------------------------ pull
  async function fetchAll(table) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select('*').eq('household_id', hid).order(PK[table]).range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }

  function pull() { return once(() => pulling, (v) => { pulling = v; }, runPull); }
  function runPull() {
    return (async () => {
      try {
        for (const t of TABLES) {
          const rows = await fetchAll(t);
          server[t] = new Map(rows.map((r) => [r[PK[t]], r]));
          persistRows(t);
        }
        status.lastSync = Date.now(); status.lastError = null;
        emit();
        await ensurePhotos();
      } catch (e) {
        status.lastError = e?.message || String(e);
        if (!e?.code) status.online = status.online && typeof navigator !== 'undefined' ? navigator.onLine !== false : status.online;
        emit();
        throw e;
      }
    })();
  }
  const sync = async () => { await flush(); await pull(); };

  // ------------------------------------------------------------------ photos
  const photoPaths = () => new Set([...overlay().entries.values()].map((r) => r.photo_path).filter(Boolean));

  async function ensurePhotos() {
    const missing = [...photoPaths()].filter((p) => !objUrls.has(p));
    if (!missing.length) return;
    const need = missing.filter((p) => !(signed.get(p)?.exp > Date.now() + 60000));
    if (need.length) {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(need, SIGN_SECONDS);
      if (!error) for (const s of data) if (s.signedUrl) signed.set(s.path, { url: s.signedUrl, exp: Date.now() + SIGN_SECONDS * 1000 });
      emit();
    }
    // Keep a copy on the device so photos also show offline.
    const queue = missing.filter((p) => signed.get(p));
    const worker = async () => {
      for (let p; (p = queue.shift()); ) {
        try {
          const res = await fetch(signed.get(p).url);
          if (!res.ok) continue;
          const blob = await res.blob();
          await db.setPhoto(p, blob);
          objUrls.set(p, URL.createObjectURL(blob));
          emit();
        } catch { /* offline: try again on the next sync */ }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // ------------------------------------------------------------------ realtime
  function subscribe() {
    if (!sb.channel) return;
    channel = sb.channel(`tt-${hid}`);
    for (const t of TABLES) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: `household_id=eq.${hid}` }, (p) => {
        if (p.eventType === 'DELETE') { const k = p.old?.[PK[t]]; if (k != null) server[t].delete(k); }
        else if (p.new && p.new[PK[t]] != null) server[t].set(p.new[PK[t]], p.new);
        persistRows(t);
        if (t === 'entries') ensurePhotos().catch(() => {});
        emit();
      });
    }
    channel.subscribe((s) => {
      const was = status.realtime;
      status.realtime = s === 'SUBSCRIBED' ? 'live' : s === 'CLOSED' ? 'off' : 'connecting';
      emit();
      if (s === 'SUBSCRIBED' && was !== 'live' && !stopped) sync().catch(() => {});   // catch up on anything missed
    });
  }

  // ------------------------------------------------------------------ public mutations (all optimistic)
  const editableDish = (d) => ({ rom: d.rom, th: d.th ?? null, d: d.d ?? null, region: d.r });
  const editablePlace = (p) => ({ name: p.n, th: p.th ?? null, address: p.a ?? null, stage: p.st, ig: p.ig ?? null, note: p.note ?? null });

  const api = {
    me, householdId: hid,
    snapshot,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onError(fn) { errorListeners.add(fn); return () => errorListeners.delete(fn); },
    sync, flush, pull,
    pending: () => outbox.length,

    saveEntry(app, id) {
      const cur = id && currentRow('entries', id);
      if (cur) {
        const patch = M.diff(cur, M.entryEditable(app));
        if (Object.keys(patch).length) enqueue({ t: 'patch', table: 'entries', id, patch });
        return id;
      }
      id = id || M.newId();
      enqueue({ t: 'put', table: 'entries', row: M.entryToRow(hid, { ...app, id, updatedAt: undefined }, { author: me, sourceClient: 'pwa' }) });
      return id;
    },
    updateEntry(id, appPatch) {
      const cur = currentRow('entries', id); if (!cur) return;
      const patch = M.diff(cur, M.entryEditable({ ...M.entryFromRow(cur), ...appPatch, photo: appPatch.photo === undefined ? (cur.photo_path ? { id: cur.photo_path } : null) : appPatch.photo }));
      if (Object.keys(patch).length) enqueue({ t: 'patch', table: 'entries', id, patch });
    },
    deleteEntry(id) {
      const pending = outbox.some((o) => o.t === 'put' && o.table === 'entries' && o.row.id === id);
      dropOps((o) => o.table === 'entries' && (o.row?.id === id || o.id === id));
      if (!pending) enqueue({ t: 'del', table: 'entries', id }); else { emit(); }
    },
    restoreEntry(entry) {
      if (dropOps((o) => o.t === 'del' && o.table === 'entries' && o.id === entry.id)) { emit(); return; }
      enqueue({ t: 'put', table: 'entries', row: M.entryToRow(hid, entry, { author: me, sourceClient: 'pwa' }) });
    },

    saveDish(app, id) {
      const cur = id && currentRow('dishes', id);
      if (cur) { const patch = M.diff(cur, editableDish(app)); if (Object.keys(patch).length) enqueue({ t: 'patch', table: 'dishes', id, patch }); return id; }
      id = id || M.newId();
      enqueue({ t: 'put', table: 'dishes', row: M.dishToRow(hid, { ...app, id, createdAt: app.createdAt || Date.now() }) });
      return id;
    },
    savePlace(app, id) {
      const cur = id && currentRow('places', id);
      if (cur) { const patch = M.diff(cur, editablePlace(app)); if (Object.keys(patch).length) enqueue({ t: 'patch', table: 'places', id, patch }); return id; }
      id = id || M.newId();
      enqueue({ t: 'put', table: 'places', row: M.placeToRow(hid, { ...app, id, createdAt: app.createdAt || Date.now() }) });
      return id;
    },
    /** Instagram link and note: the only things you can change on a catalogue place. */
    savePlaceInfo(id, { ig, note }) { enqueue({ t: 'patch', table: 'places', id, patch: { ig: ig ?? null, note: note ?? null } }); },
    deleteDish(id) { dropOps((o) => o.table === 'dishes' && o.row?.id === id); enqueue({ t: 'del', table: 'dishes', id }); },
    deletePlace(id) { dropOps((o) => o.table === 'places' && o.row?.id === id); enqueue({ t: 'del', table: 'places', id }); },

    setFav(dishId, on) {
      if (on) enqueue({ t: 'put', table: 'favs', row: { household_id: hid, dish_id: dishId } });
      else enqueue({ t: 'del', table: 'favs', id: dishId });
    },

    setSuggestionStatus(id, status) { enqueue({ t: 'patch', table: 'suggestions', id, patch: { status, resolved_at: new Date().toISOString() } }); },

    /** Stores the photo on the device and queues the upload. Returns what an entry stores in `photo`. */
    async addPhoto(blob) {
      const path = `${hid}/${M.newId()}.jpg`;
      await db.setPhoto(path, blob);
      objUrls.set(path, URL.createObjectURL(blob));
      enqueue({ t: 'upload', path });
      return { id: path, url: objUrls.get(path) };
    },
    /** Removes the file unless another entry still uses it. */
    async removePhoto(path) {
      if (!path || photoPaths().has(path)) return;
      dropOps((o) => o.t === 'upload' && o.path === path);
      const url = objUrls.get(path); if (url) URL.revokeObjectURL(url);
      objUrls.delete(path); signed.delete(path);
      await db.delPhoto(path).catch(() => {});
      enqueue({ t: 'rmphoto', path });
    },

    async recordLocation({ lat, lng, accuracy }) {
      if (!status.online) return false;
      const { error } = await sb.from('locations').insert({ household_id: hid, user_name: me, lat, lng, accuracy: accuracy ?? null, source: 'pwa' });
      return !error;
    },

    async stop({ wipe = false } = {}) {
      stopped = true;
      for (const k of Object.keys(timers)) clearTimeout(timers[k]);
      if (channel) await sb.removeChannel(channel).catch(() => {});
      if (typeof window !== 'undefined') { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); document.removeEventListener('visibilitychange', onVisible); }
      if (wipe) await db.clear();
    },
  };

  // ------------------------------------------------------------------ boot
  for (const t of TABLES) { const rows = await db.get(rowsKey(t)); if (rows) server[t] = new Map(rows.map((r) => [r[PK[t]], r])); }
  outbox = (await db.get(outKey)) || [];
  seq = outbox.reduce((m, o) => Math.max(m, o.seq || 0), 0);
  if (typeof URL.createObjectURL === 'function') for (const { path, blob } of await db.allPhotos()) objUrls.set(path, URL.createObjectURL(blob));

  const onOnline = () => { status.online = true; emit(); sync().catch(() => {}); };
  const onOffline = () => { status.online = false; emit(); };
  const onVisible = () => { if (document.visibilityState === 'visible' && status.online) sync().catch(() => {}); };
  if (typeof window !== 'undefined') { window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline); document.addEventListener('visibilitychange', onVisible); }

  api.start = async () => { subscribe(); if (status.online) await sync().catch(() => {}); emit(); };
  return api;
}
