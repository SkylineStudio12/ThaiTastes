import { renderSettings } from "./settings.js";
import { renderSuggestions } from "./suggestions.js";
/* ---------- Catalogue, from mancare-thailanda.md ---------- */
const REGIONS = [
  { k: "nord", n: "North", s: "Chiang Mai, Chiang Rai, Pai" },
  { k: "centru", n: "Central", s: "Bangkok" },
  { k: "sud", n: "South", s: "Khao Lak, Phuket, Krabi, Lanta" },
  { k: "est", n: "East", s: "Koh Chang and Trat" },
  { k: "isaan", n: "Isaan", s: "found everywhere" },
  { k: "dulci", n: "Sweets and drinks", s: "" }
];
let DISHES = [];

/* ---------- Stages and places, from locuri-thailanda-2026.md ---------- */
const STAGES = [
  { k: "bkk", n: "Bangkok" }, { k: "cnx", n: "Chiang Mai" }, { k: "khl", n: "Khao Lak" }, { k: "hkt", n: "Phuket" },
  { k: "pp", n: "Phi Phi" }, { k: "kbv", n: "Krabi" }, { k: "lanta", n: "Koh Lanta" }, { k: "chang", n: "Koh Chang" }
];
// Start dates; a travel day counts toward the stage you arrive at. April: back in Bangkok for the flight home.
const STAGE_STARTS = [["2026-11-03", "bkk"], ["2026-11-07", "cnx"], ["2026-12-20", "khl"], ["2026-12-30", "hkt"],
  ["2027-01-02", "pp"], ["2027-01-04", "kbv"], ["2027-02-01", "lanta"], ["2027-03-01", "chang"], ["2027-04-01", "bkk"]];
const STAGE_REGION = { bkk: "centru", cnx: "nord", khl: "sud", hkt: "sud", pp: "sud", kbv: "sud", lanta: "sud", chang: "est" };

// c = verified (V) coordinates only; places marked A or without coordinates carry none.
let PLACES = [];

let DISH_BY_ID = {}, PLACE_BY_ID = {};
const STAGE_NAME = Object.fromEntries(STAGES.map(s => [s.k, s.n]));

/* ---------- Custom dishes and places come from the store ---------- */
let customDishes = [], customPlaces = [];
const REGION_KEYS = new Set(REGIONS.map(r => r.k)), STAGE_KEYS = new Set(STAGES.map(s => s.k));
const str = (v, max) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
/* Only plain web links are kept, so a shared row can never smuggle in a script URL. */
function webUrl(v) {
  const raw = str(v, 300); if (!raw) return null;
  try { const u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; }
  catch (_) { return null; }
}
/* Instagram link and note live on the place row, for catalogue places and your own alike. */
const placeExtra = p => ({ ig: p.ig || null, note: p.note || null });
const allDishes = () => DISHES.concat(customDishes);
const allPlaces = () => PLACES.concat(customPlaces);
const dishById = id => DISH_BY_ID[id] || customDishes.find(d => d.id === id);
const placeById = id => PLACE_BY_ID[id] || customPlaces.find(p => p.id === id);

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}
// Strip Latin diacritics only; Thai combining marks are outside this range.
const norm = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const compact = s => s.replace(/[\s\-'.,]/g, "");
function todayStr() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function stageFor(date) { let s = "bkk"; for (const [start, k] of STAGE_STARTS) if (date >= start) s = k; return s; }
const fmtNum = n => n.toLocaleString("en-GB", { maximumFractionDigits: 1 });
function fmtDate(s) { const d = new Date(s + "T12:00:00"); return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }

function dishOf(e) { return (e.dishId && dishById(e.dishId)) || { ro: e.dishFree || "removed dish" }; }
function dishKey(e) { return e.dishId || ("free:" + norm(e.dishFree)); }
function placeName(e) { const p = e.placeId && placeById(e.placeId); return (p && p.n) || e.placeFree || ""; }
const noThai = s => (s || "").replace(/[\u0E00-\u0E7F]+\s*/g, "").replace(/\s+([,.])/g, "$1").replace(/^[\s,.;:·()-]+/, "").trim();
const cap = s => s ? s.charAt(0).toLocaleUpperCase("en-GB") + s.slice(1) : s;
function capInput(input) {
  const v = input.value, c = cap(v);
  if (c === v) return;
  const a = input.selectionStart, b = input.selectionEnd;
  input.value = c;
  try { input.setSelectionRange(a, b); } catch (_) { /* type=search may not support selection */ }
}
function dishLabel(d) {
  const latin = cap(noThai(d.rom || d.ro));
  return el("span", { class: "dish" }, latin
    ? el("span", { class: "rom", text: latin })
    : el("span", { class: "rom th", lang: "th", text: d.th || d.ro || d.rom || "" }));
}
function toast(msg) {
  const t = el("div", { class: "toast", role: "status", text: msg });
  document.body.append(t); setTimeout(() => t.remove(), 2200);
}
const byNewest = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);

/* ---------- state ---------- */
let store = null, entries = [], loaded = false;
const me = () => (store ? store.me : null);
let favs = new Set();
let view = "sum";
let hStage = "all";
let form = blankForm();
let busy = false;

function blankForm() {
  const d = todayStr();
  return { id: null, createdAt: null, dishId: null, dishFree: null, placeId: null, placeFree: null,
    date: d, stage: stageFor(d), stageManual: false, g: null, a: null, price: "", note: "", spice: null, fav: false, photo: null, photoOrig: null };
}

/* ---------- search ---------- */
function dishIndex() {
  return allDishes().map(d => {
    const rom = norm(d.rom || d.ro); const hay = norm([d.th, d.rom, d.ro, d.d].join(" "));
    return { d, rom, hay, hayC: compact(hay) };
  });
}
function searchDishes(q, limit = 8) {
  const n = norm(q); if (!n) return [];
  const raw = q.trim(), nc = compact(n), tokens = n.split(/\s+/);
  const out = [];
  for (const x of dishIndex()) {
    let rank = -1;
    if (x.rom.startsWith(n) || (x.d.th && x.d.th.startsWith(raw))) rank = 0;
    else if (x.rom.includes(n) || compact(x.rom).includes(nc) || (x.d.th && x.d.th.includes(raw))) rank = 1;
    else if (tokens.every(t => x.hay.includes(t)) || x.hayC.includes(nc)) rank = 2;
    if (rank >= 0) out.push({ rank, d: x.d });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, limit).map(o => o.d);
}
function uniqueFree(field) {
  const seen = new Set(), out = [];
  for (const e of [...entries].sort(byNewest)) {
    const v = e[field]; if (!v) continue; const k = norm(v);
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}
function recentDishes(limit) {
  const seen = new Set(), out = [];
  for (const e of [...entries].sort(byNewest)) {
    const k = dishKey(e); if (seen.has(k)) continue; seen.add(k);
    out.push(e.dishId ? { id: e.dishId } : { free: e.dishFree }); if (out.length >= limit) break;
  }
  return out;
}

/* ---------- Log form ---------- */
const resItem = (node, onclick) => el("li", null, el("button", { type: "button", onclick }, node));

let dishOpen = false;
function pickDish(id, free) { dishOpen = false; form.dishId = id || null; form.dishFree = free ? cap(free) : null; form.fav = favs.has(form.dishId || ""); $("#dish-q").value = ""; renderDishField(); renderFav(); updateSave(); }
/* Existing list dish with this name, or a new one in the current region. */
async function dishIdForName(name) {
  const hit = allDishes().find(d => norm(d.rom || d.ro) === norm(name));
  if (hit) return hit.id;
  const id = store.saveDish({ rom: cap(name).slice(0, 80), th: null, d: null, r: STAGE_REGION[form.stage], createdAt: Date.now() });
  refresh();
  return id;
}
async function quickAddDish(name) {
  if (!store || busy || !name) return;
  busy = true; updateSave();
  try { pickDish(await dishIdForName(name)); } catch (e) { $("#form-err").textContent = writeError(e); }
  finally { busy = false; updateSave(); }
}
function renderDishField() {
  const picked = form.dishId || form.dishFree;
  const q = $("#dish-q"), res = $("#dish-res");
  res.replaceChildren();
  if (picked) {
    const d = form.dishId ? (dishById(form.dishId) || { ro: "…" }) : { ro: form.dishFree };
    $("#dish-name").replaceChildren(dishLabel(d));
    $("#dish-tile").replaceChildren(svgIcon(FOOD_ICONS[foodKind(form)], "ic"));
    renderHero();
    return;
  }
  const pick = pickDish;
  const text = q.value, n = norm(text);
  if (!dishOpen) return;
  if (!n) {
    const rec = recentDishes(3);
    if (rec.length) {
      res.append(el("li", { class: "grp", text: "Recent" }));
      for (const r of rec) res.append(resItem(dishLabel(r.id ? (dishById(r.id) || { ro: "removed dish" }) : { ro: r.free }), () => pick(r.id, r.free)));
    }
    const tried = new Set(entries.map(e => e.dishId));
    const local = allDishes().filter(d => d.r === STAGE_REGION[form.stage] && !tried.has(d.id)).slice(0, 3);
    if (local.length) {
      res.append(el("li", { class: "grp", text: "To try in " + STAGE_NAME[form.stage] }));
      for (const d of local) res.append(resItem(dishLabel(d), () => pick(d.id)));
    }
    return;
  }
  const hits = searchDishes(text);
  for (const d of hits) res.append(resItem(el("div", null, dishLabel(d), noThai(d.d) ? el("div", { class: "desc", text: noThai(d.d) }) : null), () => pick(d.id)));
  const frees = uniqueFree("dishFree").filter(f => norm(f).includes(n)).slice(0, 3);
  for (const f of frees) res.append(resItem(dishLabel({ ro: f }), () => pick(null, f)));
  const exact = hits.some(d => norm(d.rom || d.ro) === n) || frees.some(f => norm(f) === n);
  if (!exact) res.append(resItem(el("span", { class: "new" }, "New dish: ", el("strong", { text: cap(text.trim()) })), () => quickAddDish(cap(text.trim()))));
}

let placeOpen = false;
function pickPlace(id, free) { form.placeId = id || null; form.placeFree = free || null; $("#place-q").value = ""; renderPlaceField(false); }
function placeLabel() {
  if (form.placeId) { const p = placeById(form.placeId); return p ? p.n : "…"; }
  return form.placeFree || "";
}
/* Existing place with this name, or a new one at the current stop. */
async function placeIdForName(name) {
  const hit = allPlaces().find(p => norm(p.n) === norm(name));
  if (hit) return hit.id;
  const id = store.savePlace({ n: name.trim().slice(0, 80), th: null, a: null, st: form.stage, createdAt: Date.now() });
  refresh();
  return id;
}
async function quickAddPlace(name) {
  if (!store || busy || !name) return;
  busy = true; updateSave();
  try { pickPlace(await placeIdForName(name)); } catch (e) { $("#form-err").textContent = writeError(e); }
  finally { busy = false; updateSave(); }
}
function renderPlaceField(showList) {
  placeOpen = !!showList;
  const picked = form.placeId || form.placeFree;
  const q = $("#place-q"), res = $("#place-res");
  res.replaceChildren();
  const label = placeLabel();
  $("#t-place-v").textContent = label || "Choose";
  $("#t-place-v").classList.toggle("empty-v", !label);
  $("#place-panel").hidden = !placeOpen;
  $("#place-clear").hidden = !picked;
  if (!showList) return;
  const pick = pickPlace;
  const n = norm(q.value);
  const list = !n ? allPlaces().filter(p => p.st === form.stage).slice(0, 8)
    : allPlaces().filter(p => norm([p.n, p.th, p.a].join(" ")).includes(n)).sort((a, b) => (b.st === form.stage) - (a.st === form.stage)).slice(0, 8);
  const frees = uniqueFree("placeFree").filter(f => !n || norm(f).includes(n)).slice(0, 3);
  for (const f of frees) res.append(resItem(el("div", { class: "rom", text: f }), () => pick(null, f)));
  for (const p of list) res.append(resItem(el("div", null, el("div", { class: "rom", text: p.n }),
    el("div", { class: "desc", text: [p.st !== form.stage ? STAGE_NAME[p.st] : null, p.a].filter(Boolean).join(" · ") })), () => pick(p.id)));
  if (n && !list.some(p => norm(p.n) === n) && !frees.some(f => norm(f) === n))
    res.append(resItem(el("span", { class: "new" }, "New place: ", el("strong", { text: q.value.trim() })), () => quickAddPlace(q.value.trim())));
}

function buildScores() {
  for (const row of document.querySelectorAll(".score")) {
    const p = row.dataset.p;
    for (let i = 1; i <= 5; i++) row.append(el("button", { type: "button", "aria-pressed": "false", "aria-label": (p === "g" ? "Greg " : "Andra ") + i, text: String(i),
      onclick: () => { form[p] = form[p] === i ? null : i; renderScores(); updateSave(); } }));
  }
}
function renderScores() {
  for (const row of document.querySelectorAll(".score")) {
    const p = row.dataset.p;
    row.querySelectorAll("button").forEach((b, idx) => b.setAttribute("aria-pressed", String(form[p] === idx + 1)));
  }
}
function stageOptions(sel, current) {
  sel.replaceChildren(...STAGES.map(s => el("option", { value: s.k, text: s.n })));
  sel.value = current;
}
function renderStageChips() { stageOptions($("#f-stage"), form.stage); }
const SPICE_MAX = 10;
const CHILI_PATH = '<path d="M14 8c3.2 0 6 2.2 6 5.2C20 18 14.5 21 7.5 21 5.8 21 4 20.4 4 19.5c4.5 0 8.5-3.6 8.5-8.6 0-1.6.4-2.9 1.5-2.9Z"/><path d="M14 8c0-2.1.9-3.6 2.6-4.5"/>';
const HEART_PATH = '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>';
function spiceWord(v) { return v <= 0 ? "None" : v <= 3 ? "Mild" : v <= 6 ? "Medium" : v <= 8 ? "Hot" : "Extreme"; }
/* Spice stays "not rated" (null) until the slider is touched, so 0 always means a real "not spicy". */
function renderSpice() {
  const v = form.spice, set = Number.isFinite(v), inp = $("#f-spice");
  inp.value = String(set ? v : 0); inp.style.setProperty("--p", (set ? v / SPICE_MAX * 100 : 0) + "%");
  inp.setAttribute("aria-valuetext", set ? v + " of " + SPICE_MAX + ", " + spiceWord(v) : "Not rated");
  const out = $("#spice-v"); out.textContent = set ? v + " / " + SPICE_MAX + " · " + spiceWord(v) : "Not rated"; out.classList.toggle("zero", !set || v === 0);
}
function renderFav() {
  const b = $("#f-fav");
  b.setAttribute("aria-pressed", String(form.fav));
  b.setAttribute("aria-label", form.fav ? "Remove from favorites" : "Add to favorites");
}
/* Favorites belong to a dish, not to one meal: one doc per dish id in "favs". */
async function setFav(id, on) {
  store.setFav(id, on);
}
/* The heart on the meal form saves straight away. A typed-in dish first becomes a list dish, since a favorite needs a dish id;
   when editing a saved meal, that meal is pointed at the new dish too so the two never drift apart. */
async function toggleFormFav() {
  if (!store || busy || !(form.dishId || form.dishFree)) return;
  const on = !form.fav;
  form.fav = on; renderFav();
  busy = true; updateSave();
  try {
    if (!form.dishId) {
      const id = await dishIdForName(form.dishFree);
      if (form.id) store.updateEntry(form.id, { dishId: id, dishFree: null });
      form.dishId = id; form.dishFree = null; renderDishField();
    }
    favs = withFav(form.dishId, on);
    await setFav(form.dishId, on);
    toast(on ? "Added to favorites" : "Removed from favorites");
  } catch (e) {
    form.fav = !on; renderFav(); toast(writeError(e));
  } finally { busy = false; updateSave(); }
}
function withFav(id, on) { const next = new Set(favs); if (on) next.add(id); else next.delete(id); return next; }
async function toggleFavDish(id) {
  if (!store) return;
  const on = !favs.has(id);
  favs = withFav(id, on); renderView();
  try { await setFav(id, on); toast(on ? "Added to favorites" : "Removed from favorites"); }
  catch (e) { favs = withFav(id, !on); renderView(); toast(writeError(e)); }
}
function renderPhoto() {
  $("#hero-photo").hidden = !store;
  $("#hero-photo").setAttribute("aria-label", form.photo ? "Change photo" : "Add photo");
  $("#hero-photo-x").hidden = !(store && form.photo);
  renderHero();
}
function removePhoto() { discardUnsavedPhoto(); form.photo = null; renderPhoto(); }
/* Hero: the meal's photo when there is one, otherwise a drawn tile for drinks, sweets or bowls. */
const STAGE_LONG = d => { const x = new Date(d + "T12:00:00"); return isNaN(x) ? "" : x.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
function renderHero() {
  const box = $("#hero-img"); box.replaceChildren();
  const kind = foodKind(form);
  const dishImg = !form.photo && form.dishId ? dishPhoto(form.dishId, true) : null;
  if (form.photo) box.append(el("img", { src: form.photo.url, alt: "" }));
  else if (dishImg) box.append(el("img", { src: dishImg, alt: "" }));
  else box.append(el("div", { class: "gen gen-" + kind }, svgIcon(FOOD_ICONS[kind], "gen-ic")));
  $("#hero").classList.toggle("has-photo", !!form.photo);
  $("#hero-stage").textContent = STAGE_NAME[form.stage] || "";
  $("#hero-date").textContent = fmtDate(form.date);
}
function fillForm() {
  $("#dish-q").value = ""; $("#place-q").value = "";
  $("#f-date").value = form.date; $("#f-price").value = form.price; $("#f-note").value = form.note;
  renderStageChips(); renderDishField(); renderPlaceField(false); renderScores(); renderSpice(); renderFav(); renderPhoto();
  const editing = !!form.id;
  $("#del-zone").hidden = !editing; $("#when-panel").hidden = true; $("#when-btn").setAttribute("aria-expanded", "false");
  $("#save-txt").textContent = editing ? "Save changes" : "Save dish";
  $("#form-err").textContent = "";
  updateSave();
}
function updateSave() {
  const hasDish = !!(form.dishId || form.dishFree), hasScore = !!(form.g || form.a), editing = !!form.id;
  const showDish = hasDish || editing;
  $("#dish-search").hidden = showDish;
  $("#hero").hidden = $("#dish-card").hidden = $("#step-score").hidden = $("#log-actions").hidden = !showDish;
  $("#step-more").hidden = !((hasDish && hasScore) || editing);
  $("#save").disabled = !store || busy || !(hasDish && hasScore);
}

function discardUnsavedPhoto() {
  if (store && form.photo && (!form.photoOrig || form.photo.id !== form.photoOrig.id)) store.removePhoto(form.photo.id);
}
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || file), "image/jpeg", 0.82));
  } catch { return file; }
}
async function onPhoto(ev) {
  const file = ev.target.files && ev.target.files[0]; ev.target.value = "";
  if (!file || !store) return;
  toast("Uploading photo…");
  try {
    const up = await store.addPhoto(await shrink(file));
    discardUnsavedPhoto();
    form.photo = { id: up.id, url: up.url };
    $("#form-err").textContent = "";
  } catch (e) {
    $("#form-err").textContent = "The photo couldn't be added. Try again or save without it.";
  }
  renderPhoto();
}

async function save() {
  if (!store || busy) return;
  if (!(form.dishId || form.dishFree)) { $("#form-err").textContent = "Pick a dish."; return; }
  if (!(form.g || form.a)) { $("#form-err").textContent = "Add at least one score."; return; }
  busy = true; updateSave();
  try {
    // A typed dish or place becomes a list record, so it counts everywhere (Food, Places, favorites).
    if (!form.dishId && form.dishFree) { form.dishId = await dishIdForName(form.dishFree); form.dishFree = null; }
    if (!form.placeId && form.placeFree) { form.placeId = await placeIdForName(form.placeFree); form.placeFree = null; }
  } catch (e) { $("#form-err").textContent = writeError(e); busy = false; updateSave(); return; }
  const priceNum = String(form.price).trim() === "" ? null : Math.round(Number(form.price));
  const now = Date.now();
  const data = {
    dishId: form.dishId, dishFree: form.dishId ? null : form.dishFree,
    placeId: form.placeId, placeFree: form.placeId ? null : (form.placeFree || null),
    date: form.date || todayStr(), stage: form.stage,
    g: form.g, a: form.a, price: Number.isFinite(priceNum) && priceNum >= 0 ? priceNum : null,
    note: form.note.trim() || null, spice: form.spice, photo: form.photo,
    createdAt: form.createdAt || now, updatedAt: now
  };
  try {
    store.saveEntry(data, form.id);
    refresh();
    if (store && form.photoOrig && (!form.photo || form.photo.id !== form.photoOrig.id)) store.removePhoto(form.photoOrig.id);
    const wasEdit = !!form.id;
    form = blankForm(); fillForm();
    toast(wasEdit ? "Updated" : "Saved");
    if (navStack.length) goBack("hist");
  } catch (e) {
    $("#form-err").textContent = writeError(e);
  } finally { busy = false; updateSave(); }
}
const NOTE_PLACEHOLDER = /\s*\.?\s*Notele de completat\.?\s*/gi;
function writeError(e) {
  return "Not saved. " + ((e && e.message) || "Try again.");
}
function editEntry(e) {
  discardUnsavedPhoto();
  form = { id: e.id, createdAt: e.createdAt || null, dishId: e.dishId || null, dishFree: e.dishFree || null,
    placeId: e.placeId || null, placeFree: e.placeFree || null, date: e.date || todayStr(), stage: e.stage || stageFor(e.date || todayStr()),
    stageManual: true, g: e.g || null, a: e.a || null, price: e.price == null ? "" : String(e.price), note: e.note || "",
    spice: Number.isFinite(e.spice) ? e.spice : null, fav: !!e.dishId && favs.has(e.dishId),
    photo: e.photo ? { ...e.photo } : null, photoOrig: e.photo ? { ...e.photo } : null };
  fillForm(); go("log");
}
/* Delete straight away and offer Undo for a few seconds; the photo file is only removed once Undo has passed. */
const UNDO_MS = 6000;
async function deleteEntry() {
  if (!store || !form.id || busy) return;
  const id = form.id, saved = entries.find(e => e.id === id);
  const photo = form.photoOrig;
  busy = true; updateSave();
  try {
    store.deleteEntry(id); refresh();
    discardUnsavedPhoto();
    form = blankForm(); fillForm(); goBack("hist");
    let undone = false;
    const restore = async () => {
      undone = true;
      try { store.restoreEntry(saved); refresh(); toast("Restored"); } catch (e) { toast(writeError(e)); }
    };
    if (saved) toastAction("Deleted", "Undo", restore); else toast("Deleted");
    setTimeout(() => { if (!undone && store && photo) store.removePhoto(photo.id); }, UNDO_MS + 500);
  } catch (e) { $("#form-err").textContent = writeError(e); }
  finally { busy = false; updateSave(); }
}
function toastAction(msg, label, fn) {
  const btn = el("button", { type: "button", class: "toast-act", text: label });
  const t = el("div", { class: "toast", role: "status" }, el("span", { text: msg }), btn);
  btn.addEventListener("click", () => { t.remove(); fn(); });
  document.body.append(t); setTimeout(() => t.remove(), UNDO_MS);
}

/* ---------- entry rows ---------- */
function sortedEntries() {
  return [...entries].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
}
/* A food row: name, the two scores in fixed columns, then only the optional details that exist. */
const PERSON_PATH = '<circle cx="12" cy="8" r="4"/><path d="M5 20a7 7 0 0 1 14 0"/>';
function svgIcon(paths, cls) {
  const t = document.createElement("template");
  t.innerHTML = '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + paths + "</svg>";
  return t.content.firstChild;
}
/* Greg above Andra, always in the same two slots so every row lines up. */
function scoreStack(e) {
  const badge = (v, cls, who) => v
    ? el("span", { class: cls, title: who, "aria-label": who + " " + v }, svgIcon(PERSON_PATH, "pi"), who[0] + " " + v)
    : el("span", { class: "sc-empty" });
  return el("span", { class: "scores" }, badge(e.g, "pg", "Greg"), badge(e.a, "pa", "Andra"));
}
/* A History card: your photo first, then the dish's catalogue photo, then the drawn icon. */
function histCard(e) {
  const meta = [e.price != null ? e.price + " ฿" : null, e.note].filter(Boolean).join(" · ");
  const d = dishOf(e);
  return gridCard({ onclick: () => e.dishId && dishById(e.dishId) ? openDish(e.dishId, e.id) : editEntry(e), label: cap(noThai(d.rom || d.ro)) || d.th || "Dish",
    img: e.photo && e.photo.url ? e.photo.url : e.dishId ? IMG_L[e.dishId] || IMG[e.dishId] : null, gen: genArt(foodKind(e)),
    scores: personScores(e.g || null, e.a || null), title: cap(noThai(d.rom || d.ro)) || d.th || d.ro || "Dish", sub: meta });
}

/* ---------- aggregates ---------- */
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
function stats() {
  const by = new Map();
  for (const e of entries) {
    const k = dishKey(e);
    if (!by.has(k)) by.set(k, { k, dish: dishOf(e), n: 0, gs: [], as: [], both: [] });
    const s = by.get(k); s.n++;
    if (e.g) s.gs.push(e.g);
    if (e.a) s.as.push(e.a);
    if (e.g && e.a) s.both.push([e.g, e.a]);
  }
  for (const s of by.values()) {
    s.all = avg([...s.gs, ...s.as]);
    s.bg = avg(s.both.map(p => p[0])); s.ba = avg(s.both.map(p => p[1]));
  }
  return by;
}
/* ---------- Checklist ---------- */
let listKind = "dishes";
/* Catalogue photos: Wikimedia Commons, fetched into images/ by scripts/fetch-stock-images.mjs (credits under the list). */
let IMG = {};
let CREDITS = [];
const REGION_TITLE = { nord: "Chiang Mai, Chiang Rai, Pai", centru: "Bangkok", sud: "Khao Lak, Phuket, Krabi, Lanta", est: "Koh Chang and Trat", isaan: "All over the country", dulci: "Sweets and drinks" };
/* A dish's picture: your newest meal photo of it first, then the catalogue photo (large or small). */
function dishPhoto(id, large) {
  const own = sortedEntries().find(e => e.dishId === id && e.photo && e.photo.url);
  if (own) return own.photo.url;
  return (large && IMG_L[id]) || IMG[id] || null;
}
function dishThumb(d) {
  const url = dishPhoto(d.id);
  if (url) return el("img", { class: "thumb", src: url, alt: "", loading: "lazy", decoding: "async" });
  return foodThumb({ dishId: d.id });
}
function banner(regionKey, chip, title, done, total, verb = "tried") {
  const url = IMG["R_" + regionKey];
  const pct = total ? Math.round(done / total * 100) : 0;
  return el("div", { class: "banner gen-bowl", style: "--rc:var(--c-" + regionKey + ", var(--ok))" },
    url ? el("img", { src: url, alt: "", loading: "lazy", decoding: "async" }) : null,
    el("div", { class: "banner-body" },
      el("span", { class: "hero-chip" }, svgIcon('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>', "ic"), chip),
      el("h2", { text: title }),
      el("span", { class: "banner-cnt", text: done + " / " + total + " " + verb }),
      el("span", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done) },
        el("span", { style: "width:" + pct + "%" }))));
}
function triedBadge() { return el("span", { class: "tried", "aria-label": "tried" }, svgIcon('<path d="M20 6 9 17l-5-5"/>', "ic")); }
function renderCheck() {
  if (listKind === "places") renderPlaceList(); else if (listKind === "favs") renderFavPage(); else renderDishList();
  renderCredits();
}
function creditLabel(key) {
  if (key.startsWith("R_")) { const r = REGIONS.find(x => x.k === key.slice(2)); return r ? r.n : key; }
  if (PLACE_BY_ID[key]) return PLACE_BY_ID[key].n;
  const d = dishById(key); return d ? cap(noThai(d.rom || d.ro)) : key;
}
function renderCredits() {
  const used = CREDITS.filter(c => IMG[c.key] && (listKind === "places" ? c.key.startsWith("R_") || !!PLACE_BY_ID[c.key] : !PLACE_BY_ID[c.key]));
  $("#credits").hidden = !used.length;
  $("#credits-list").replaceChildren(...used.map(c => el("li", null,
    el("a", { href: c.page, target: "_blank", rel: "noopener", text: creditLabel(c.key) }), " · " + c.author + " · ",
    c.license_url ? el("a", { href: c.license_url, target: "_blank", rel: "noopener", text: c.license }) : c.license)));
}
/* ---------- Food and Places pages: search, filter chips, a banner that picks the region or stop, one list ---------- */
const BOOKMARK_PATH = '<path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1Z"/>';
const SEARCH_PATH = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>';
const STAR_FILL = '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>';
const STORE_PATH = '<path d="M4 9.5 5.5 4h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5.5 12v8h13v-8"/><path d="M10 20v-4h4v4"/>';
const LIST_ICON = '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>';
const CHECK_PATH = '<path d="M20 6 9 17l-5-5"/>';
const CHEVRON_DOWN = '<path d="m6 9 6 6 6-6"/>';
const food = { region: null, query: "", searchOpen: false, pickOpen: false };
const plc = { stage: null, query: "", searchOpen: false, pickOpen: false };
const foodRegion = () => food.region || STAGE_REGION[stageFor(todayStr())] || "centru";
const plcStage = () => plc.stage || stageFor(todayStr());
const typingIn = state => state.searchOpen && document.activeElement && document.activeElement.id === "list-q" && $("#list-body");

/* Shared top: back (when opened from another page), title, subtitle, search, optional extra button. */
function listHeader(state, cfg) {
  const back = navStack.length ? el("button", { type: "button", class: "backbtn", "aria-label": "Back", onclick: backFromView }, svgIcon('<path d="m15 18-6-6 6-6"/>', "ic")) : null;
  const searchBtn = el("button", { type: "button", class: "iconbtn", "aria-label": cfg.searchLabel, "aria-pressed": String(state.searchOpen),
    onclick: () => { state.searchOpen = !state.searchOpen; if (!state.searchOpen) state.query = ""; state.pickOpen = false; renderCheck(); if (state.searchOpen) $("#list-q").focus(); } }, svgIcon(SEARCH_PATH, "ic"));
  const head = el("header", { class: "food-top" },
    el("div", { class: "ft-row" }, back, el("h1", { text: cfg.title }), el("span", { class: "ft-acts" }, searchBtn, cfg.extra || null)),
    el("p", { text: cfg.sub }));
  if (state.searchOpen) {
    const q = el("input", { id: "list-q", type: "search", placeholder: cfg.searchLabel, autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": cfg.searchLabel });
    q.value = state.query;
    q.addEventListener("input", () => { state.query = q.value; cfg.body(); });
    head.append(el("div", { class: "fsearch" }, svgIcon(SEARCH_PATH, "ic"), q,
      el("button", { type: "button", class: "iconbtn sm", "aria-label": "Close search", onclick: () => { state.searchOpen = false; state.query = ""; renderCheck(); } }, svgIcon('<path d="M18 6 6 18M6 6l12 12"/>', "ic"))));
  }
  return head;
}
function pickerMenu(title, opts, current, onPick) {
  return el("div", { class: "rpick", id: "rpick", role: "menu", onclick: ev => ev.stopPropagation() },
    el("span", { class: "rpick-h", text: title }),
    ...opts.map(o => el("button", { type: "button", role: "menuitemradio", "aria-checked": String(current === o.k), onclick: () => onPick(o.k) },
      el("span", { class: "sw", style: o.rc ? "--rc:" + o.rc : "" }), el("span", { text: o.n }),
      current === o.k ? svgIcon(CHECK_PATH, "ic") : null)));
}
function filterChips(chips, current, onPick) {
  return el("div", { class: "fchips", role: "group", "aria-label": "Show" }, chips.map(c =>
    el("button", { type: "button", class: "fchip", "aria-pressed": String(current === c.k), style: c.c ? "--cc:" + c.c : "",
      onclick: () => onPick(c.k) }, svgIcon(c.icon, "ic"), c.n)));
}
function sectionRow(iconPath, iconCls, title) {
  return el("div", { class: "fsec-h" }, svgIcon(iconPath, "ic " + iconCls), el("h2", { text: title }));
}
/* The banner is the region or stop chooser: tap it to pick another one. */
function choiceBanner(state, b, label, menu) {
  const chip = b.querySelector(".hero-chip");
  if (chip) chip.append(svgIcon(CHEVRON_DOWN, "ic chev"));
  return el("div", { class: "fbanner" },
    el("button", { type: "button", class: "bpick", "aria-label": label, "aria-haspopup": "menu", "aria-expanded": String(state.pickOpen),
      onclick: ev => { ev.stopPropagation(); state.pickOpen = !state.pickOpen; renderCheck(); } }, b),
    state.pickOpen ? menu() : null);
}

/* ---- Food ---- */
/* One fixed order: not tried yet first (in the research list's order), then tried ones by score. */
function sortDishes(ds, st) {
  const order = new Map(DISHES.map((d, i) => [d.id, i]));
  const pos = d => order.has(d.id) ? order.get(d.id) : DISHES.length + (d.createdAt || 0) / 1e13;
  return [...ds].sort((a, b) => {
    const sa = st.get(a.id), sb = st.get(b.id);
    if (!!sa !== !!sb) return sa ? 1 : -1;
    if (sa && sb) return (sb.all ?? -1) - (sa.all ?? -1) || pos(a) - pos(b);
    return pos(a) - pos(b);
  });
}
function regionPicker() {
  const opts = [{ k: "all", n: "All regions", rc: "var(--fg)" }, ...REGIONS.map(r => ({ k: r.k, n: r.n, rc: "var(--c-" + r.k + ")" }))];
  return pickerMenu("Region", opts, foodRegion(), k => { food.region = k; food.pickOpen = false; renderCheck(); });
}
/* No banner on To try: a small chip names the region and opens the region menu. */
function regionChip(k) {
  const all = k === "all", here = !all && k === STAGE_REGION[stageFor(todayStr())];
  const label = all ? "All regions" : regionOf(k).n + (here ? " · you're here" : "");
  return el("div", { class: "rchip-wrap" },
    el("button", { type: "button", class: "rchip", style: all ? "" : "--rc:var(--c-" + k + ")", "aria-haspopup": "menu", "aria-expanded": String(food.pickOpen),
      onclick: ev => { ev.stopPropagation(); food.pickOpen = !food.pickOpen; renderCheck(); } },
      el("span", { class: "sw" }), el("span", { text: label }), svgIcon(CHEVRON_DOWN, "ic")),
    food.pickOpen ? regionPicker() : null);
}
/* One card shape for every list (History, To try, Favorites, Places): photo on top, score pills on its edge, name and one detail below.
   Corner buttons (heart, pencil) sit beside the card, not inside it, because buttons can't nest. */
function gridCard({ onclick, label, img, gen, scores = [], title, sub, clamp, corners = [] }) {
  const card = el("button", { type: "button", class: "fcard hcard", "aria-label": label, onclick },
    el("span", { class: "fcard-img" }, img ? el("img", { src: img, alt: "", loading: "lazy", decoding: "async" }) : gen,
      scores.length ? el("span", { class: "fscores" }, scores.map(([cls, text, aria]) => el("span", { class: cls, text, "aria-label": aria }))) : null),
    el("span", { class: "fbody" }, el("b", { text: title }), sub ? el("span", { class: "hmeta" + (clamp ? " clamp2" : ""), text: sub }) : null));
  return el("div", { class: "fwrap" }, card, ...corners);
}
const genArt = kind => el("span", { class: "gen gen-" + kind }, svgIcon(FOOD_ICONS[kind], "gen-ic"));
const iconArt = path => el("span", { class: "gen ico-tile" }, svgIcon(path, "ic"));
function personScores(g, a, fmt = String) {
  return [g != null ? ["pg", "G " + fmt(g), "Greg " + fmt(g)] : null, a != null ? ["pa", "A " + fmt(a), "Andra " + fmt(a)] : null].filter(Boolean);
}
/* A dish card: To try shows the description, Favorites the city, and only Favorites lets the heart remove it. */
function dishGridCard(d, st, onFavPage) {
  const s = st.get(d.id), last = sortedEntries().find(e => e.dishId === d.id);
  const fav = favs.has(d.id);
  const heart = !fav ? null : onFavPage
    ? el("button", { type: "button", class: "fheart", "aria-label": "Remove " + dishName(d) + " from favorites", onclick: () => toggleFavDish(d.id) }, svgIcon(HEART_PATH, "favmark"))
    : el("span", { class: "fheart", role: "img", "aria-label": "Favorite" }, svgIcon(HEART_PATH, "favmark"));
  return gridCard({ onclick: () => openDish(d.id), label: dishName(d), img: dishPhoto(d.id, true), gen: genArt(foodKind({ dishId: d.id })),
    scores: s ? personScores(avg(s.gs), avg(s.as), fmt1) : [],
    title: dishName(d), sub: onFavPage ? (last ? STAGE_NAME[last.stage] : regionOf(d.r).n) : noThai(d.d), clamp: !onFavPage, corners: [heart] });
}
/* A list split in two: still to try (or visit) first, then the ones already done. */
function splitLists(box, todo, done, todoTitle, doneTitle, row, emptyText) {
  if (!todo.length && !done.length) { box.append(el("p", { class: "empty", text: emptyText })); return; }
  if (todo.length) box.append(sectionRow(LIST_ICON, "", todoTitle + " (" + todo.length + ")"), el("div", { class: "hgrid" }, todo.map(row)));
  if (done.length) box.append(sectionRow(CHECK_PATH, "done", doneTitle + " (" + done.length + ")"), el("div", { class: "hgrid" }, done.map(row)));
}
function renderFoodBody() {
  const box = $("#list-body"); if (!box) return;
  box.replaceChildren();
  const st = stats(), k = foodRegion(), q = food.query.trim();
  const inRegion = allDishes().filter(d => k === "all" || d.r === k);
  if (!q) box.append(regionChip(k));
  const pool = q ? searchDishes(q, 200) : inRegion;
  const ds = sortDishes(pool, st);
  splitLists(box, ds.filter(d => !st.has(d.id)), ds.filter(d => st.has(d.id)), "To try", "Already tried", d => dishGridCard(d, st, false),
    q ? "No dish matches. Tap + below to log it as a new dish." : "Nothing here for this filter yet.");
}
function renderDishList() {
  // While typing in search, only the results change so the field keeps focus.
  if (typingIn(food)) { renderFoodBody(); return; }
  $("#check").replaceChildren(listHeader(food, { title: "To try", sub: "Thailand's dishes, region by region.", searchLabel: "Search all dishes", body: renderFoodBody }),
    el("div", { id: "list-body" }));
  renderFoodBody();
}

/* ---- Favorites ---- */
const favState = { query: "", searchOpen: false, pickOpen: false };
function renderFavBody() {
  const box = $("#list-body"); if (!box) return;
  box.replaceChildren();
  const st = stats(), q = favState.query.trim();
  const pool = (q ? searchDishes(q, 200) : allDishes()).filter(d => favs.has(d.id));
  const ds = [...pool].sort((a, b) => ((st.get(b.id) || {}).all ?? -1) - ((st.get(a.id) || {}).all ?? -1));
  if (!ds.length) { box.append(el("p", { class: "empty", text: q ? "No favorite matches." : "No favorites yet. Tap the heart on a dish, and it shows up here." })); return; }
  box.append(el("div", { class: "hgrid" }, ds.map(d => dishGridCard(d, st, true))));
}
function renderFavPage() {
  if (typingIn(favState)) { renderFavBody(); return; }
  $("#check").replaceChildren(listHeader(favState, { title: "Favorites", sub: "The dishes worth having again.", searchLabel: "Search favorites", body: renderFavBody }),
    el("div", { id: "list-body" }));
  renderFavBody();
}

/* ---- Places ---- */
/* Per place: dishes logged there, the average of every score given there, last visit, newest photo. */
function placeStats() {
  const m = new Map();
  for (const e of sortedEntries()) {
    if (!e.placeId) continue;
    if (!m.has(e.placeId)) m.set(e.placeId, { n: 0, scores: [], last: e.date || "", photo: null });
    const x = m.get(e.placeId); x.n++;
    if (e.g) x.scores.push(e.g);
    if (e.a) x.scores.push(e.a);
    if (!x.photo && e.photo && e.photo.url) x.photo = e.photo.url;
  }
  for (const x of m.values()) x.all = avg(x.scores);
  return m;
}
/* Places you have been come first, best rated first; then the ones still to visit, in the research list's order. */
function sortPlaces(list, ps) {
  const order = new Map(PLACES.map((p, i) => [p.id, i]));
  const pos = p => order.has(p.id) ? order.get(p.id) : PLACES.length + (p.createdAt || 0) / 1e13;
  return [...list].sort((a, b) => {
    const xa = ps.get(a.id), xb = ps.get(b.id);
    if (!!xa !== !!xb) return xa ? -1 : 1;
    if (xa && xb) return (xb.all ?? -1) - (xa.all ?? -1) || (xb.last || "").localeCompare(xa.last || "");
    return pos(a) - pos(b);
  });
}
function searchPlaces(q) {
  const n = norm(q); if (!n) return [];
  return allPlaces().filter(p => norm([p.n, p.th, p.a].join(" ")).includes(n));
}
function stagePicker() {
  const opts = [{ k: "all", n: "All stops", rc: "var(--fg)" }, ...STAGES.map(x => ({ k: x.k, n: x.n, rc: "var(--c-" + STAGE_REGION[x.k] + ")" }))];
  return pickerMenu("Stop", opts, plcStage(), k => { plc.stage = k; plc.pickOpen = false; renderCheck(); });
}
/* A place's picture: your newest meal photo there first, then the catalogue photo of the place. */
let PLACE_IMG = {};
const placePhoto = (p, x) => (x && x.photo) || PLACE_IMG[p.id] || null;
function placeThumb(url, cls) {
  return url ? el("img", { class: cls, src: url, alt: "", loading: "lazy", decoding: "async" })
    : el("span", { class: cls + " ico-tile" }, svgIcon(STORE_PATH, "ic"));
}
function placeBanner(k, list, ps) {
  const done = list.filter(p => ps.has(p.id)).length, pct = pctOf(done, list.length), all = k === "all";
  const here = !all && k === stageFor(todayStr());
  const b = banner(all ? "nord" : STAGE_REGION[k], all ? "All stops" : (here ? "You're here" : regionOf(STAGE_REGION[k]).n),
    all ? "Thailand" : STAGE_NAME[k], done, list.length, "visited · " + pct + "%");
  return choiceBanner(plc, b, "Choose stop, now " + (all ? "all stops" : STAGE_NAME[k]), stagePicker);
}
/* Google Maps search for a catalogue place: name, then address and stop, so the right listing comes up. */
function mapsUrl(p) {
  const q = [p.n, p.a, STAGE_NAME[p.st], "Thailand"].filter(Boolean).join(", ");
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
}
function placeCard(p, x) {
  return el("button", { type: "button", class: "mtcard", onclick: () => openPlace(p.id) },
    el("span", { class: "mtcard-img" }, placeThumb(placePhoto(p, x), "gen-ph"), x ? triedBadge() : null),
    el("span", { class: "mtcard-b" }, el("b", { text: p.n }),
      x && x.all != null ? el("span", { class: "starb" }, svgIcon(STAR_FILL, "ic"), fmt1(x.all)) : null));
}
function placeGridCard(p, x) {
  const edit = p.custom ? el("button", { type: "button", class: "fcorner", "aria-label": "Edit " + p.n, onclick: () => openEditor("place", p) }, svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', "ic")) : null;
  return gridCard({ onclick: () => openPlace(p.id), label: p.n, img: placePhoto(p, x), gen: iconArt(STORE_PATH),
    scores: x && x.all != null ? [["pall", fmt1(x.all), "Average " + fmt1(x.all)]] : [], title: p.n, sub: p.a, corners: [edit] });
}
/* Log a dish with this place already filled in. */
function startMealAt(id) {
  discardUnsavedPhoto(); form = blankForm(); form.placeId = id; fillForm();
  go("log"); $("#dish-q").focus();
}
function renderPlaceBody() {
  const box = $("#list-body"); if (!box) return;
  box.replaceChildren();
  const ps = placeStats(), k = plcStage(), q = plc.query.trim();
  const inStop = allPlaces().filter(p => k === "all" || p.st === k);
  if (!q) box.append(placeBanner(k, inStop, ps));
  const pool = q ? searchPlaces(q) : inStop;
  const list = sortPlaces(pool, ps);
  splitLists(box, list.filter(p => !ps.has(p.id)), list.filter(p => ps.has(p.id)), "To visit", "Already visited", p => placeGridCard(p, ps.get(p.id)),
    q ? "No place matches. Tap + at the top to add it." : "Nothing here for this filter yet.");
}
function renderPlaceList() {
  if (typingIn(plc)) { renderPlaceBody(); return; }
  const add = el("button", { type: "button", class: "iconbtn", "aria-label": "Add a place", onclick: () => openEditor("place") }, svgIcon('<path d="M12 5v14M5 12h14"/>', "ic"));
  $("#check").replaceChildren(listHeader(plc, { title: "Places", sub: "Restaurants, cafés, and food spots we've visited.", searchLabel: "Search all places", body: renderPlaceBody, extra: add }),
    el("div", { id: "list-body" }));
  renderPlaceBody();
}
document.addEventListener("click", () => {
  if (view !== "check") return;
  const st = listKind === "places" ? plc : food;
  if (st.pickOpen) { st.pickOpen = false; renderCheck(); }
});
/* ---------- Dish page: photo hero, our numbers, our notes. Only data we hold, nothing invented. ---------- */
let IMG_L = {};
/* curEntry: the meal the page was opened for (from History); null when opened for the dish in general. */
/* Back and edit buttons over a page photo: they stay at the top while scrolling and turn solid once the photo is gone. */
function pageBar(onBack, ...right) {
  return el("div", { class: "pbar" },
    el("button", { type: "button", class: "glass", "aria-label": "Back", onclick: onBack }, svgIcon('<path d="m15 18-6-6 6-6"/>', "ic")),
    el("span", { class: "pbar-r" }, ...right));
}
function syncPageBar() {
  const page = view === "dish" ? "#dish-page" : view === "place" ? "#place-page" : null;
  const bar = page && $(page + " .pbar"), hero = page && $(page + " .dhero");
  if (bar && hero) bar.classList.toggle("solid", window.scrollY > hero.offsetHeight - bar.offsetHeight - 24);
}
window.addEventListener("scroll", syncPageBar, { passive: true });
let curDish = null, curEntry = null;
function openDish(id, entryId) { curDish = id; curEntry = entryId || null; go("dish"); }
function closeDish() { goBack("check"); }
function statTile(cls, iconPath, value, label, extra) {
  return el("div", { class: "stat " + cls }, el("span", { class: "stat-ic" }, svgIcon(iconPath, "ic")),
    el("span", { class: "stat-b" }, el("b", { text: value }), el("span", { text: label }), extra || null));
}
function spiceTile(v) {
  const meter = el("span", { class: "meter", role: "img", "aria-label": v + " of " + SPICE_MAX },
    Array.from({ length: SPICE_MAX }, (_, i) => el("i", { class: i < v ? "on" : "" })));
  return statTile("st-chili", CHILI_PATH, spiceWord(v), "How spicy", meter);
}
function personCard(who, cls, scores) {
  const a = avg(scores);
  return el("div", { class: "pcard " + cls },
    el("div", { class: "pcard-h" }, el("span", { class: "pcard-ic" }, svgIcon(PERSON_PATH, "ic")), el("b", { text: who })),
    el("span", { class: "pscore", text: a != null ? fmtNum(a) + " / 5" : "–" }),
    el("p", { class: "desc", text: scores.length ? (scores.length === 1 ? "from 1 score" : "average of " + scores.length + " scores") : "No score yet" }));
}
function renderDishPage() {
  const box = $("#dish-page"); box.replaceChildren();
  const d = dishById(curDish);
  if (!d) { closeDish(); return; }
  const r = REGIONS.find(x => x.k === d.r) || { n: "" };
  const s = stats().get(d.id);
  const mine = sortedEntries().filter(e => e.dishId === d.id);
  const ctx = curEntry ? mine.find(e => e.id === curEntry) || null : null;
  const big = ctx && ctx.photo && ctx.photo.url ? ctx.photo.url : dishPhoto(d.id, true);
  const kind = foodKind({ dishId: d.id });
  const heroSub = ctx ? [fmtDate(ctx.date), placeName(ctx)].filter(Boolean).join(" · ") : REGION_TITLE[d.r];
  const bar = pageBar(closeDish,
    store && d.custom ? el("button", { type: "button", class: "glass edit-btn", "aria-label": "Edit dish", onclick: () => openEditor("dish", d) },
      svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', "ic")) : null,
    store ? el("button", { type: "button", class: "glass fav-btn", "aria-pressed": String(favs.has(d.id)),
      "aria-label": favs.has(d.id) ? "Remove from favorites" : "Add to favorites", onclick: () => toggleFavDish(d.id) }, svgIcon(HEART_PATH, "ic")) : null);
  const hero = el("div", { class: "dhero" },
    big ? el("img", { src: big, alt: "" }) : el("div", { class: "gen gen-" + kind }, svgIcon(FOOD_ICONS[kind], "gen-ic")),
    el("div", { class: "dhero-body" },
      el("span", { class: "hero-chip" }, svgIcon('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>', "ic"), d.sub || r.n),
      el("h1", { text: cap(noThai(d.rom || d.ro || "")) || "Dish" }),
      heroSub ? el("p", { text: heroSub }) : null));
  const sheet = el("div", { class: "dsheet" });
  if (s) {
    const last = mine[0];
    const spices = mine.map(e => e.spice).filter(Number.isFinite);
    const sp = spices.length ? Math.round(avg(spices)) : null;
    sheet.append(el("div", { class: "stats" },
      statTile("st-ok", '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>', s.all != null ? fmtNum(s.all) + " / 5" : "–", "How good"),
      sp != null ? spiceTile(sp) : null,
      statTile("st-rose", '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>', "×" + s.n, s.n === 1 ? "once" : s.n + " times"),
      sp == null ? statTile("st-amber", '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>', fmtShort(last.date), "Last time") : null));
  } else {
    sheet.append(el("div", { class: "stats one" }, statTile("st-amber", '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', "To try", "Not logged yet")));
  }
  if (noThai(d.d)) sheet.append(el("p", { class: "dlead", text: noThai(d.d) }));
  if (s) {
    sheet.append(el("h2", { class: "dsec", text: "Our experience" }),
      el("div", { class: "pcards" }, personCard("Greg", "pc-g", s.gs), personCard("Andra", "pc-a", s.as)));
    const list = el("ul", { class: "dnotes" }, mine.map(e => el("li", null, el("button", { type: "button", class: "dnote" + (e === ctx ? " on" : ""), "aria-current": e === ctx ? "true" : null, onclick: () => editEntry(e) },
      el("span", { class: "dnote-b" },
        el("b", { text: [e === ctx ? "This meal" : null, fmtDate(e.date), placeName(e)].filter(Boolean).join(" · ") }),
        e.note ? el("span", { class: "desc", text: e.note }) : null),
      scoreStack(e), svgIcon('<path d="m9 6 6 6-6 6"/>', "go")))));
    sheet.append(el("h2", { class: "dsec", text: mine.length === 1 ? "Your note" : "Your notes" }), list);
  }
  const c = IMG[d.id] && CREDITS.find(x => x.key === d.id);
  if (c) sheet.append(el("p", { class: "dcredit" }, "Photo: ", el("a", { href: c.page, target: "_blank", rel: "noopener", text: c.author }), " · " + c.license + " · Wikimedia Commons"));
  const logBtn = ctx
    ? el("button", { type: "button", class: "secondary", onclick: () => logDish(d.id) }, "Log again")
    : el("button", { type: "button", class: "primary", onclick: () => logDish(d.id) }, svgIcon('<path d="M12 5v14M5 12h14"/>', "ic"), "Log this dish");
  const editBtn = ctx ? el("button", { type: "button", class: "primary", onclick: () => editEntry(ctx) },
    svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', "ic"), "Edit this meal") : null;
  sheet.append(el("div", { class: "actions" }, logBtn, editBtn));
  box.append(bar, hero, sheet); syncPageBar();
}
/* ---------- Place page: same layout as the dish page ---------- */
let curPlace = null;
function openPlace(id) { curPlace = id; go("place"); }
const IG_PATH = '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6" fill="currentColor"/>';
function placeStatsRow(x, mine) {
  if (!x) return el("div", { class: "stats one" }, statTile("st-amber", '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', "To visit", "No meal here yet"));
  return el("div", { class: "stats" },
    statTile("st-ok", '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>', x.all != null ? fmtNum(x.all) + " / 5" : "–", "How good"),
    statTile("st-rose", '<path d="M3 11h18M5 11a7 7 0 0 0 14 0"/><path d="M12 4v3"/>', String(x.n), x.n === 1 ? "dish" : "dishes"),
    statTile("st-amber", '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>', fmtShort(mine[0].date), "Last time"));
}
function placeMealRow(e) {
  const d = dishOf(e), name = cap(noThai(d.rom || d.ro)) || d.th || "Dish";
  return el("li", null, el("button", { type: "button", class: "dnote", onclick: () => e.dishId && dishById(e.dishId) ? openDish(e.dishId, e.id) : editEntry(e) },
    el("span", { class: "dnote-b" }, el("b", { text: name + " · " + fmtDate(e.date) }), e.note ? el("span", { class: "desc", text: e.note }) : null),
    scoreStack(e), svgIcon('<path d="m9 6 6 6-6 6"/>', "go")));
}
function renderPlacePage() {
  const box = $("#place-page"); box.replaceChildren();
  const p = placeById(curPlace);
  if (!p) { goBack("check"); return; }
  const x = placeStats().get(p.id), extra = placeExtra(p);
  const mine = sortedEntries().filter(e => e.placeId === p.id);
  const big = placePhoto(p, x);
  const bar = pageBar(() => goBack("check"),
    store ? el("button", { type: "button", class: "glass", "aria-label": "Edit place", onclick: () => openEditor("place", p) }, svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', "ic")) : null);
  const hero = el("div", { class: "dhero" },
    big ? el("img", { src: big, alt: "" }) : el("div", { class: "gen ico-tile" }, svgIcon(STORE_PATH, "gen-ic")),
    el("div", { class: "dhero-body" },
      el("span", { class: "hero-chip" }, svgIcon(PIN_PATH, "ic"), STAGE_NAME[p.st] || ""),
      el("h1", { text: p.n }),
      p.a ? el("p", { text: p.a }) : null));
  const sheet = el("div", { class: "dsheet" }, placeStatsRow(x, mine));
  sheet.append(el("div", { class: "plinks" },
    el("a", { class: "secondary", href: mapsUrl(p), target: "_blank", rel: "noopener" }, svgIcon(PIN_PATH, "ic"), "Google Maps"),
    extra.ig ? el("a", { class: "secondary", href: extra.ig, target: "_blank", rel: "noopener" }, svgIcon(IG_PATH, "ic"), "Instagram") : null));
  sheet.append(el("h2", { class: "dsec", text: "Our note" }),
    extra.note ? el("p", { class: "pnote", text: extra.note })
      : store ? el("button", { type: "button", class: "addnote", onclick: () => openEditor("place", p) }, svgIcon('<path d="M12 5v14M5 12h14"/>', "ic"), "Add a note or Instagram link")
      : el("p", { class: "desc", text: "No note yet." }));
  if (mine.length) sheet.append(el("h2", { class: "dsec", text: "What we ate here" }), el("ul", { class: "dnotes" }, mine.map(placeMealRow)));
  const c = !(x && x.photo) && PLACE_IMG[p.id] && CREDITS.find(y => y.key === p.id);
  if (c) sheet.append(el("p", { class: "dcredit" }, "Photo: ", el("a", { href: c.page, target: "_blank", rel: "noopener", text: c.author }), " · " + c.license + " · Wikimedia Commons"));
  sheet.append(el("div", { class: "actions" }, el("button", { type: "button", class: "primary", onclick: () => startMealAt(p.id) }, svgIcon('<path d="M12 5v14M5 12h14"/>', "ic"), "Log a dish here")));
  box.append(bar, hero, sheet); syncPageBar();
}
function logDish(id) {
  discardUnsavedPhoto();
  form = blankForm(); fillForm(); pickDish(id);
  go("log");
}

/* ---------- History ---------- */
function renderHistFilters() {
  const sb = $("#h-stage"); sb.replaceChildren();
  const used = new Set(entries.map(e => e.stage));
  const stages = STAGES.filter(s => used.has(s.k) || s.k === hStage);
  sb.hidden = stages.length < 2;
  if (sb.hidden) hStage = "all";
  for (const s of [{ k: "all", n: "All" }, ...stages]) sb.append(el("button", { type: "button", class: "chip", "aria-pressed": String(hStage === s.k), text: s.n, onclick: () => { hStage = s.k; renderHist(); } }));
}
const dishesWord = n => n === 1 ? "1 dish" : n + " dishes";
const fmtShort = s => { const d = new Date(s + "T12:00:00"); return isNaN(d) ? s : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
/* Fallback tile when a meal has no photo: a drink, a sweet, or a bowl for everything else. */
const DRINK_IDS = new Set(["d6", "d7"]);
const FOOD_ICONS = {
  drink: '<path d="M6 8h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5Z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M9.5 3.5v2M13.5 3.5v2"/>',
  sweet: '<path d="M4 13h16l-1.6 6.2a1 1 0 0 1-1 .8H6.6a1 1 0 0 1-1-.8Z"/><path d="M6.5 13a5.5 5.5 0 0 1 11 0"/><path d="M12 7.5V5"/>',
  bowl: '<path d="M3 11h18a9 9 0 0 1-18 0Z"/><path d="M8 20h8"/><path d="M9 3.5c-.9 1.3.9 2.2 0 3.5M13 3.5c-.9 1.3.9 2.2 0 3.5"/>'
};
function foodKind(e) {
  if (DRINK_IDS.has(e.dishId)) return "drink";
  const d = e.dishId && dishById(e.dishId);
  return d && d.r === "dulci" ? "sweet" : "bowl";
}
function foodThumb(e) {
  if (e.photo && e.photo.url) return el("img", { class: "thumb", src: e.photo.url, alt: "", loading: "lazy" });
  if (e.dishId && IMG[e.dishId]) return el("img", { class: "thumb", src: IMG[e.dishId], alt: "", loading: "lazy", decoding: "async" });
  const t = document.createElement("template");
  t.innerHTML = '<span class="thumb ico-tile" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">' + FOOD_ICONS[foodKind(e)] + "</svg></span>";
  return t.content.firstChild;
}
const fmtDay = s => { const d = new Date(s + "T12:00:00"); return isNaN(d) ? s : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }); };
const placeKey = e => e.placeId || (e.placeFree ? "free:" + norm(e.placeFree) : "");
/* City -> day -> restaurant -> food. Entries arrive newest first, so each level is built in that order. */
function groupHistory(list) {
  const cities = [];
  for (const e of list) {
    let city = cities[cities.length - 1];
    if (!city || city.stage !== e.stage) { city = { stage: e.stage, days: [] }; cities.push(city); }
    let day = city.days.find(d => d.date === e.date);
    if (!day) { day = { date: e.date, rests: [] }; city.days.push(day); }
    const k = placeKey(e);
    let rest = day.rests.find(r => r.k === k);
    if (!rest) { rest = { k, name: placeName(e), foods: [] }; day.rests.push(rest); }
    rest.foods.push(e);
  }
  return cities;
}
function restGroup(day, rest) {
  const list = el("div", { class: "hgrid" }, rest.foods.map(histCard));
  if (!rest.k) return list;
  const head = el("h4", { class: "rplace" },
    svgIcon('<path d="M7 3v8a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V3"/><path d="M9 13v8"/><path d="M17 21V3c-2 1-3 3.5-3 6.5V13h3"/>', "ri"),
    el("span", { class: "rname", text: rest.name }), el("span", { class: "desc", text: dishesWord(rest.foods.length) }));
  const frag = document.createDocumentFragment();
  frag.append(head, list);
  return frag;
}
function renderHist() {
  renderHistFilters();
  const box = $("#hist"); box.replaceChildren();
  const list = sortedEntries().filter(e => (hStage === "all" || e.stage === hStage) );
  if (!list.length) { box.append(el("p", { class: "empty", text: entries.length ? "No dishes for this filter." : "Nothing logged yet." })); return; }
  for (const city of groupHistory(list)) {
    const meals = city.days.reduce((n, d) => n + d.rests.reduce((m, r) => m + r.foods.length, 0), 0);
    const first = city.days[city.days.length - 1].date, last = city.days[0].date;
    const span = first === last ? fmtShort(first) : fmtShort(first) + " – " + fmtShort(last);
    const sec = el("section", { class: "hcity" },
      el("header", { class: "hhead" }, el("h2", { text: STAGE_NAME[city.stage] || "Elsewhere" }),
        el("p", { class: "desc", text: [span, city.days.length === 1 ? "1 day" : city.days.length + " days", dishesWord(meals)].join(" · ") })));
    for (const day of city.days) {
      const places = day.rests.filter(r => r.k).length;
      const n = day.rests.reduce((m, r) => m + r.foods.length, 0);
      sec.append(el("header", { class: "hday" }, el("h3", { text: fmtDay(day.date) }),
          el("p", { class: "desc", text: [places ? (places === 1 ? "1 place" : places + " places") : null, dishesWord(n)].filter(Boolean).join(" · ") })),
        ...day.rests.map(r => restGroup(day, r)));
    }
    box.append(sec);
  }
}

/* ---------- Summary: the home screen ---------- */
const PIN_PATH = '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>';
const ARROW_R = '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>';
const regionOf = k => REGIONS.find(r => r.k === k) || { k, n: k };
const pctOf = (a, b) => b ? Math.round(a / b * 100) : 0;
const fmt1 = n => n.toFixed(1);
const dishName = d => cap(noThai(d.rom || d.ro || "")) || "Dish";
function progress(p, cls) {
  return el("span", { class: "prog" + (cls ? " " + cls : ""), role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(p) },
    el("span", { style: "width:" + p + "%" }));
}
function openFavList() { listKind = "favs"; Object.assign(favState, { query: "", searchOpen: false }); go("check"); }
/* Page dots under a horizontal scroller; hidden when everything fits. */
function withDots(scroller) {
  const dots = el("div", { class: "dots", "aria-hidden": "true" });
  const paint = () => {
    const span = scroller.scrollWidth - scroller.clientWidth;
    const kids = scroller.children.length;
    const pages = span > 4 ? Math.min(kids, Math.ceil(scroller.scrollWidth / scroller.clientWidth)) : 1;
    const on = pages > 1 ? Math.round(scroller.scrollLeft / span * (pages - 1)) : 0;
    dots.replaceChildren(...(pages > 1 ? Array.from({ length: pages }, (_, i) => el("i", { class: i === on ? "on" : "" })) : []));
  };
  scroller.addEventListener("scroll", paint, { passive: true });
  setTimeout(paint, 0); setTimeout(paint, 400);
  return [scroller, dots];
}
function sectionHead(title, onAll) {
  return el("div", { class: "shead" }, el("h2", { text: title }),
    onAll ? el("button", { type: "button", class: "seeall", onclick: onAll }, "See all", svgIcon(ARROW_R, "ic")) : null);
}
function favCard(d, st) {
  const s = st.get(d.id);
  const last = sortedEntries().find(e => e.dishId === d.id);
  const big = dishPhoto(d.id, true), kind = foodKind({ dishId: d.id });
  const ga = avg(s ? s.gs : []), aa = avg(s ? s.as : []);
  /* The heart is its own button beside the card (buttons can't nest); tapping it removes the favorite. */
  const card = el("button", { type: "button", class: "fcard", onclick: () => openDish(d.id) },
    el("span", { class: "fcard-img" },
      big ? el("img", { src: big, alt: "", loading: "lazy", decoding: "async" }) : el("span", { class: "gen gen-" + kind }, svgIcon(FOOD_ICONS[kind], "gen-ic")),
      ga != null || aa != null ? el("span", { class: "fscores" },
        ga != null ? el("span", { class: "pg", text: "G " + fmt1(ga) }) : null,
        aa != null ? el("span", { class: "pa", text: "A " + fmt1(aa) }) : null) : null),
    el("span", { class: "fbody" }, el("b", { text: dishName(d) }),
      el("span", { class: "fcity" }, svgIcon(PIN_PATH, "ic"), last ? STAGE_NAME[last.stage] || "" : regionOf(d.r).n)));
  const heart = el("button", { type: "button", class: "fheart", "aria-label": "Remove " + dishName(d) + " from favorites", onclick: () => toggleFavDish(d.id) },
    svgIcon(HEART_PATH, "favmark"));
  return el("div", { class: "fwrap" }, card, heart);
}
/* The one fact Home keeps: the hottest dish you rated; on a tie the most recent wins (sortedEntries is newest first). */
function highlights() {
  const hot = sortedEntries().filter(e => Number.isFinite(e.spice) && e.spice > 0 && dishById(e.dishId))
    .reduce((best, e) => (!best || e.spice > best.spice ? e : best), null);
  if (!hot) return null;
  const d = dishById(hot.dishId);
  return el("button", { type: "button", class: "hlt hl-chili hl-one", onclick: () => openDish(d.id) }, svgIcon(CHILI_PATH, "ic"),
    el("span", { class: "t", text: "Spiciest" }), el("span", { class: "v name", text: dishName(d) }), el("span", { class: "heat", text: hot.spice + " / 10" }));
}
function renderSum() {
  const box = $("#sum"); box.replaceChildren();
  const st = stats();
  const t = todayStr();
  const all = allDishes(), tried = all.filter(d => st.has(d.id)).length, p = pctOf(tried, all.length);
  const year = new Date(t + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  box.append(
    el("header", { class: "sum-top" },
      el("div", null, el("div", { class: "sum-title" }, el("h1", { text: "Home" }),
        el("button", { type: "button", class: "iconbtn", "aria-label": "Settings", onclick: () => go("settings") },
          svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>', "ic"))),
        el("p", { text: "Our food journal from Thailand" })),
      el("div", { class: "sum-where" }, svgIcon(PIN_PATH, "ic"), el("b", { text: STAGE_NAME[stageFor(t)] }), el("span", { text: year }))),
    inboxCard(),
    stickyRiceCounter(t),
    el("button", { type: "button", class: "trip", "aria-label": "All dishes in Thailand", onclick: openFood }, IMG.R_nord ? el("img", { src: IMG.R_nord, alt: "" }) : null,
      el("div", { class: "trip-body" }, el("h2", { text: "Thailand" }),
        el("span", { class: "trip-cnt", text: tried + " / " + all.length + " dishes tried" }),
        el("div", { class: "pctrow" }, progress(p), el("b", { text: p + "%" })))));
  const favList = all.filter(d => favs.has(d.id)).sort((a, b) => ((st.get(b.id) || {}).all || 0) - ((st.get(a.id) || {}).all || 0));
  box.append(sectionHead("Our favorites", favList.length ? openFavList : null));
  if (favList.length) box.append(...withDots(el("div", { class: "hscroll" }, favList.map(d => favCard(d, st)))));
  else box.append(el("div", { class: "fempty" }, svgIcon(HEART_PATH, "ic"), "Tap the heart on a dish, and it shows up here."));
  box.append(...wherePlaces(t));
  const hot = highlights();
  if (hot) box.append(hot);
}
/* Home: suggestions from Claude or ChatGPT waiting for a yes or no. */
function inboxCard() {
  const fresh = suggestions.filter(x => x.status === "new");
  if (!fresh.length) return null;
  const who = [...new Set(fresh.map(x => x.author === "chatgpt" ? "ChatGPT" : "Claude"))].join(" and ");
  return el("button", { type: "button", class: "inbox", onclick: () => go("suggest") },
    svgIcon('<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/>', "ic"),
    el("span", { class: "inbox-t" }, el("b", { text: fresh.length === 1 ? "1 suggestion" : fresh.length + " suggestions" }), el("span", { text: "from " + who })),
    svgIcon('<path d="m9 6 6 6-6 6"/>', "go"));
}
/* Home: days since our last mango sticky rice. Never logged yet: count from the first day of the trip. */
const STICKY_RICE_ID = "d1";
const STICKY_RICE_RE = /mango sticky rice|khao niao mamuang/i;
const DAY_MS = 86400000;
function isStickyRice(e) {
  if (e.dishId === STICKY_RICE_ID) return true;
  const d = e.dishId ? dishById(e.dishId) : null;
  return STICKY_RICE_RE.test(d ? d.rom || "" : e.dishFree || "");
}
function daysWithoutStickyRice(t) {
  const last = entries.filter(e => e.date && e.date <= t && isStickyRice(e)).map(e => e.date).sort().pop();
  const from = last || STAGE_STARTS[0][0];
  return Math.max(0, Math.round((new Date(t + "T12:00:00") - new Date(from + "T12:00:00")) / DAY_MS));
}
function stickyRiceQuip(n) {
  if (n === 0) return "Streak intact. Keep it at zero.";
  if (n === 1) return "One day. Find a mango cart.";
  if (n <= 3) return "This is getting serious.";
  return "Officially an emergency.";
}
function stickyRiceCounter(t) {
  const n = daysWithoutStickyRice(t), img = IMG_L[STICKY_RICE_ID] || IMG[STICKY_RICE_ID];
  return el("button", { type: "button", class: "srice" + (n ? " lapse" : ""), "aria-label": n + " days without mango sticky rice. Open the dish", onclick: () => openDish(STICKY_RICE_ID) },
    img ? el("img", { src: img, alt: "" }) : el("span", { class: "srice-ph" }),
    el("span", { class: "srice-txt" }, el("b", { text: "Days without sticky rice" }), el("span", { text: stickyRiceQuip(n) })),
    el("span", { class: "srice-n", text: String(n) }));
}
/* Home: the places researched for today's stop, best rated first; the full Places page is one tap away. */
function wherePlaces(t) {
  const stop = stageFor(t), ps = placeStats();
  const list = allPlaces().filter(p => p.st === stop);
  if (!list.length) return [];
  // Visited places keep the lead; among the rest, places with a photo come before the ones still showing the icon.
  const rank = p => ps.has(p.id) ? 0 : PLACE_IMG[p.id] ? 1 : 2;
  const shown = sortPlaces(list, ps).sort((a, b) => rank(a) - rank(b)).slice(0, 8);
  return [sectionHead("Where to eat in " + STAGE_NAME[stop], () => openPlaces(stop)),
    ...withDots(el("div", { class: "mtrow" }, shown.map(p => placeCard(p, ps.get(p.id)))))];
}
function openPlaces(stop) { listKind = "places"; Object.assign(plc, { stage: stop || null, query: "", searchOpen: false, pickOpen: false }); go("check"); }

/* ---------- views ---------- */
/* ---------- Editor for custom dishes and places ---------- */
let ed = null;
function openEditor(kind, item) {
  const t = todayStr();
  ed = { kind, item: item || null, r: item && item.r ? item.r : STAGE_REGION[stageFor(t)], st: item && item.st ? item.st : stageFor(t) };
  $("#ed-dish").hidden = kind !== "dish"; $("#ed-place").hidden = kind !== "place";
  $("#edit-title").textContent = kind === "dish" ? (item ? "Edit dish" : "New dish") : (item ? "Edit place" : "New place");
  $("#ed-rom").value = cap((item && item.rom) || ""); $("#ed-desc").value = (item && item.d) || "";
  $("#ed-name").value = (item && item.n) || ""; $("#ed-addr").value = (item && item.a) || "";
  const extra = kind === "place" && item ? placeExtra(item) : {};
  $("#ed-ig").value = extra.ig || ""; $("#ed-note").value = extra.note || "";
  $("#ed-place-core").hidden = kind === "place" && !!item && !item.custom;  // catalogue places: only the link and note are yours to change
  $("#ed-err").textContent = ""; $("#ed-save").disabled = !store;
  $("#ed-del-zone").hidden = !item || (kind === "place" && !item.custom); $("#ed-del").hidden = false; $("#ed-del-ask").hidden = true;
  renderEdChips(); go("edit");
}
function renderEdChips() {
  const rb = $("#ed-region");
  rb.replaceChildren(...REGIONS.map(r => el("option", { value: r.k, text: r.n })));
  rb.value = ed.r;
  stageOptions($("#ed-stage"), ed.st);
}
async function saveEditor() {
  if (!store || !ed || busy) return;
  const val = id => $(id).value.trim();
  let place = null, dish = null;
  if (ed.kind === "dish") {
    const rom = cap(val("#ed-rom")).slice(0, 80), th = (ed.item && ed.item.th) || "";
    if (!rom) { $("#ed-err").textContent = "Write the dish name."; return; }
    dish = { rom, th: th || null, d: val("#ed-desc").slice(0, 300) || null, r: $("#ed-region").value };
  } else {
    const igRaw = val("#ed-ig"), ig = webUrl(igRaw), note = val("#ed-note").slice(0, 1000) || null;
    if (igRaw && !ig) { $("#ed-err").textContent = "That link doesn't look right. Paste the full link from Instagram's Share button."; return; }
    if (ed.item && !ed.item.custom) place = { info: true, ig, note };
    else {
      const n = val("#ed-name").slice(0, 80);
      if (!n) { $("#ed-err").textContent = "Write the place name."; return; }
      place = { n, th: (ed.item && ed.item.th) || null, a: val("#ed-addr").slice(0, 160) || null, st: $("#ed-stage").value, ig, note };
    }
  }
  busy = true; $("#ed-save").disabled = true;
  try {
    if (dish) store.saveDish({ ...dish, createdAt: (ed.item && ed.item.createdAt) || Date.now() }, ed.item && ed.item.id);
    else if (place.info) store.savePlaceInfo(ed.item.id, place);
    else store.savePlace({ ...place, createdAt: (ed.item && ed.item.createdAt) || Date.now() }, ed.item && ed.item.id);
    refresh();
    toast(ed.item ? "Updated" : "Added");
    listKind = ed.kind === "dish" ? "dishes" : "places"; ed = null; goBack("check");
  } catch (e) { $("#ed-err").textContent = writeError(e); }
  finally { busy = false; $("#ed-save").disabled = !store; }
}
async function deleteEditorItem() {
  if (!store || !ed || !ed.item || busy) return;
  const id = ed.item.id, isDish = ed.kind === "dish";
  const used = entries.filter(e => isDish ? e.dishId === id : e.placeId === id).length;
  $("#ed-del").hidden = false; $("#ed-del-ask").hidden = true;
  if (used) {
    $("#ed-err").textContent = (used === 1 ? "Used in 1 logged dish" : "Used in " + used + " logged dishes") + ". Pick another " + (isDish ? "dish" : "place") + " in " + (used === 1 ? "that entry" : "those entries") + ", then delete it.";
    return;
  }
  busy = true;
  try {
    if (isDish) store.deleteDish(id); else store.deletePlace(id);
    refresh(); toast("Removed"); ed = null;
    const under = navStack[navStack.length - 1];  // the page of the item just deleted has nothing left to show
    if (under && under.v === (isDish ? "dish" : "place")) navStack.pop();
    goBack("check");
  }
  catch (e) { $("#ed-err").textContent = writeError(e); }
  finally { busy = false; }
}

/* Pages opened from another page remember where they came from; tabs start fresh. */
const navStack = [];
function go(v) { navStack.push({ v: view, y: window.scrollY }); show(v); window.scrollTo(0, 0); }
function goBack(fallback) {
  const prev = navStack.pop();
  show(prev ? prev.v : fallback);
  window.scrollTo(0, prev ? prev.y : 0);  // views render synchronously, so the old height is already back
}
function leaveForm() { discardUnsavedPhoto(); form = blankForm(); fillForm(); }
function backFromView() {
  if (view === "log") { leaveForm(); goBack("hist"); }
  else if (view === "edit") { ed = null; goBack("check"); }
  else goBack("check");
}
const SCREEN_TITLES = { log: "New dish", hist: "History", sum: "Home", settings: "Settings", suggest: "Suggestions" };
const SCREEN_SUBS = { hist: "Everything we've eaten, day by day." };
const LIST_TITLES = { dishes: "To try", places: "Places", favs: "Favorites" };
/* Which bottom-bar tab a view belongs to; the meal form belongs to the centre +, so no tab lights up. */
function tabOf(v) {
  if (v === "settings" || v === "suggest") return "sum";
  if (v === "check" || v === "edit") return listKind === "places" ? "sum" : listKind === "favs" ? "favs" : "food";
  if (v === "dish" || v === "place") {  // dish and place pages keep the tab they were opened from
    const from = [...navStack].reverse().find(x => !["dish", "place", "log", "edit"].includes(x.v));
    return from ? tabOf(from.v) : v === "dish" ? "food" : "sum";
  }
  return v;
}
/* The centre +: a fresh meal form with the dish search focused (pick from the list or type a new name). */
function startMeal() {
  if (view === "log") {
    if (form.id) { leaveForm(); show("log"); }
    $("#dish-q").focus(); return;
  }
  discardUnsavedPhoto(); form = blankForm(); fillForm();
  go("log");
  $("#dish-q").focus();
}
function openFood() { listKind = "dishes"; Object.assign(food, { region: "all", query: "", searchOpen: false }); go("check"); }
const VIEWS = { log: "#v-log", check: "#v-check", hist: "#v-hist", sum: "#v-sum", edit: "#v-edit", dish: "#v-dish", place: "#v-place", settings: "#v-settings", suggest: "#v-suggest" };
function show(v) {
  view = v;
  for (const [k, id] of Object.entries(VIEWS)) $(id).hidden = k !== v;
  const tab = tabOf(v);
  $("#check-title").textContent = LIST_TITLES[listKind];
  $("header.top").hidden = v === "dish" || v === "place" || v === "sum" || v === "check";
  const editingNow = v === "log" && !!form.id;
  const hasBack = navStack.length > 0 && v !== "dish" && v !== "place";
  $("#screen-title").textContent = editingNow ? "Edit dish" : v === "edit" ? $("#edit-title").textContent : v === "check" ? LIST_TITLES[listKind] : SCREEN_TITLES[v];
  const sub = v === "hist" ? SCREEN_SUBS.hist : "";
  $("#screen-sub").textContent = sub; $("#screen-sub").hidden = !sub;
  $("#back").hidden = !hasBack; $("#today").hidden = hasBack || v === "check";
  $("#edit-title").classList.toggle("vh", v === "edit");
  document.querySelectorAll("nav.tabs button").forEach(b => { if (b.dataset.v === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  renderView();
}
function renderView() {
  if (view === "log") { renderDishField(); renderPlaceField(placeOpen); }
  if (view === "check") renderCheck();
  if (view === "hist") renderHist();
  if (view === "sum") renderSum();
  if (view === "dish") renderDishPage();
  if (view === "place") renderPlacePage();
  if (view === "settings") renderSettings(appCtx);
  if (view === "suggest") renderSuggestions(appCtx);
}

/* ---------- wiring ---------- */
function wire() {
  const t = todayStr();
  $("#today").textContent = STAGE_NAME[stageFor(t)] + " · " + fmtDate(t);
  buildScores();
  const dq = $("#dish-q"); let dishBlurT;
  dq.addEventListener("input", e => { capInput(e.target); dishOpen = true; renderDishField(); });
  dq.addEventListener("focus", () => { clearTimeout(dishBlurT); dishOpen = true; renderDishField(); });
  dq.addEventListener("blur", () => { dishBlurT = setTimeout(() => { dishOpen = false; renderDishField(); }, 250); });
  $("#ed-rom").addEventListener("input", e => capInput(e.target));
  const pq = $("#place-q"); let blurT;
  pq.addEventListener("input", () => renderPlaceField(true));
  pq.addEventListener("focus", () => { clearTimeout(blurT); renderPlaceField(true); });
  pq.addEventListener("blur", () => { blurT = setTimeout(() => { if (!pq.value) renderPlaceField(false); }, 250); });
  $("#t-place").addEventListener("click", () => { renderPlaceField(true); pq.focus(); });
  $("#place-clear").addEventListener("click", () => { pickPlace(null, null); });
  $("#dish-change").addEventListener("click", () => { form.dishId = null; form.dishFree = null; renderDishField(); updateSave(); dq.focus(); });
  $("#back").addEventListener("click", backFromView);
  $("#f-date").addEventListener("change", e => { form.date = e.target.value || todayStr(); if (!form.stageManual) { form.stage = stageFor(form.date); renderStageChips(); } renderDishField(); renderHero(); });
  $("#f-stage").addEventListener("change", e => { form.stage = e.target.value; form.stageManual = true; renderDishField(); renderHero(); });
  $("#f-price").addEventListener("input", e => { form.price = e.target.value; });
  $("#f-note").addEventListener("input", e => {
    // Old imported notes carry a "to be filled in" placeholder; any edit to the note drops it.
    const clean = e.target.value.replace(NOTE_PLACEHOLDER, "");
    if (clean !== e.target.value) e.target.value = clean;
    form.note = clean;
  });
  $("#f-spice").addEventListener("input", e => { form.spice = Math.max(0, Math.min(SPICE_MAX, Number(e.target.value) || 0)); renderSpice(); });
  $("#f-fav").addEventListener("click", toggleFormFav);
  $("#f-photo").addEventListener("change", onPhoto);
  $("#save").addEventListener("click", save);
  $("#del").addEventListener("click", deleteEntry);
  $("#hero-photo-x").addEventListener("click", removePhoto);
  $("#when-btn").addEventListener("click", () => {
    const p = $("#when-panel"); p.hidden = !p.hidden; $("#when-btn").setAttribute("aria-expanded", String(!p.hidden));
  });
  $("#plus").addEventListener("click", startMeal);
  $("#ed-save").addEventListener("click", saveEditor);
  $("#ed-cancel").addEventListener("click", backFromView);
  $("#ed-del").addEventListener("click", () => { $("#ed-del").hidden = true; $("#ed-del-ask").hidden = false; });
  $("#ed-del-no").addEventListener("click", () => { $("#ed-del").hidden = false; $("#ed-del-ask").hidden = true; });
  $("#ed-del-yes").addEventListener("click", deleteEditorItem);
  document.querySelectorAll("nav.tabs button[data-v]").forEach(b => b.addEventListener("click", () => {
    if (view === "log") leaveForm();
    navStack.length = 0; ed = null;
    const v = b.dataset.v;
    if (v === "food" || v === "favs") { listKind = v === "food" ? "dishes" : "favs"; show("check"); } else show(v);
    window.scrollTo(0, 0);
  }));
  fillForm(); show("sum");
}

/* ---------- data from the store ---------- */
let suggestions = [], syncStatus = null, appCtx = null;
function refresh() {
  const v = store.snapshot();
  entries = v.entries; favs = v.favs; suggestions = v.suggestions; syncStatus = v.status;
  DISHES = v.dishes.builtin; customDishes = v.dishes.custom; PLACES = v.places.builtin; customPlaces = v.places.custom;
  DISH_BY_ID = Object.fromEntries(DISHES.map(d => [d.id, d])); PLACE_BY_ID = Object.fromEntries(PLACES.map(p => [p.id, p]));
  loaded = true;
}
function renderSync() {
  const st = syncStatus, box = $("#sync"); if (!st) return;
  const n = st.pending;
  let msg = "";
  if (!st.online) msg = "Offline. Changes are kept on this phone and sent when you're back online" + (n ? " (" + n + " waiting)." : ".");
  else if (n) msg = "Sending " + n + (n === 1 ? " change…" : " changes…");
  else if (st.lastError && !st.lastSync) msg = "Can't reach the journal right now. Showing what is saved on this phone.";
  else if (!st.lastSync && !entries.length) msg = "Loading the journal…";
  box.textContent = msg;
}
async function loadImages() {
  try {
    const [m, c] = await Promise.all([fetch("images/manifest.json").then(r => r.json()), fetch("credits.json").then(r => r.json())]);
    CREDITS = c;
    const placeKeys = new Set(c.filter(x => x.kind === "place").map(x => x.key));
    IMG = m.s || {}; IMG_L = m.l || {};
    PLACE_IMG = Object.fromEntries(Object.entries(IMG).filter(([k]) => placeKeys.has(k)));
    renderView();
  } catch (_) { /* no catalogue photos yet: the drawn icons stand in */ }
}

/* Called once, after sign-in, with the data store and the account helpers (see main.js). */
export function init(context) {
  appCtx = { ...context, REGIONS, STAGES, rerender: () => { refresh(); renderView(); } }; store = context.store;
  wire();
  refresh(); renderSync(); updateSave(); renderPhoto(); renderView();
  store.onChange(() => { refresh(); renderSync(); renderView(); updateSave(); renderPhoto(); });
  store.onError(msg => toast(msg));
  loadImages();
}
export const navigate = { settings: () => go("settings") };
