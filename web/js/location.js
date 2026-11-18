// Location sharing. Runs only while the app is open and visible: browsers (iOS in particular) do not let a web app
// read the position in the background. The AI assistants see the last point and how old it is.
// Off by default; turning it on asks for consent first (see settings.js).
import { toast } from './dom.js';

const KEY = 'tt-loc', LAST = 'tt-loc-last';
export const MIN_INTERVAL_MS = 5 * 60 * 1000;
const store = (fn, d) => { try { return fn(); } catch { return d; } };

let timer = null, busy = false, ctxRef = null;

export const isOn = () => store(() => localStorage.getItem(KEY) === 'on', false);
export const lastSent = () => store(() => Number(localStorage.getItem(LAST)) || 0, 0);
export const supported = () => typeof navigator !== 'undefined' && 'geolocation' in navigator;

async function tick(force = false) {
  if (!ctxRef || busy || !isOn() || !supported()) return;
  if (!force && (document.visibilityState !== 'visible' || Date.now() - lastSent() < MIN_INTERVAL_MS)) return;
  if (navigator.onLine === false) return;
  busy = true;
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: false, maximumAge: 120000, timeout: 20000 }));
    const ok = await ctxRef.store.recordLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
    if (ok) { store(() => localStorage.setItem(LAST, String(Date.now()))); ctxRef.onLocation?.(); }
  } catch (e) {
    if (e && e.code === 1) { setOn(false); toast('Location is blocked for this site, so sharing was turned off.'); }
  } finally { busy = false; }
}

export function start(ctx) {
  ctxRef = ctx;
  clearInterval(timer);
  timer = setInterval(() => tick(), 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  tick();
}

export function setOn(on) {
  store(() => localStorage.setItem(KEY, on ? 'on' : 'off'));
  if (on) tick(true);
  ctxRef?.onLocation?.();
}
