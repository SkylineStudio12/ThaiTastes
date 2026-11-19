// Boot: configuration, sign-in (email link or code), then the app with its data store.
import { SUPABASE_URL, SUPABASE_ANON_KEY, BUILD } from './config.js';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { init as initApp } from './app.js';
import * as loc from './location.js';
import { applyTheme, resetSettings } from './settings.js';
import { el, toast } from './dom.js';
import * as authz from './authorize.js';

applyTheme();
authz.capture();
// The AI layer (Edge Function). Its /mcp address is what goes into Claude; it is also the OAuth issuer.
const AI_BASE = SUPABASE_URL ? SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/tt' : '';
const MEMBER_KEY = 'tt-member';
const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const $ = (s) => document.querySelector(s);
let booted = false, booting = false, sb = null, store = null;

function showLogin(msg) {
  $('#app').hidden = true; $('#tabs').hidden = true; $('#login').hidden = false;
  const box = $('#login-card'); box.replaceChildren();
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    box.append(el('h1', { text: 'ThaiTastes' }), el('p', { class: 'err', text: 'Not configured yet. Set SUPABASE_URL and SUPABASE_ANON_KEY (see the README, "Deploy").' }));
    return;
  }
  const status = el('p', { class: 'status', role: 'status', text: msg || (authz.pending() ? 'Sign in to connect the assistant.' : '') });
  const email = el('input', { id: 'login-email', class: 'inp', type: 'email', autocomplete: 'email', inputmode: 'email', required: '', placeholder: 'you@example.com', 'aria-label': 'Email' });
  const code = el('input', { id: 'login-code', class: 'inp', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '8', placeholder: '6-digit code', 'aria-label': 'Code from the email' });
  const send = el('button', { type: 'submit', class: 'primary' }, 'Email me a sign-in link');
  const codeBox = el('div', { class: 'login-code', hidden: '' }, el('label', { class: 'lbl', for: 'login-code' }, 'Or type the code from the same email'), code,
    el('div', { class: 'inline-actions' }, el('button', { type: 'button', id: 'login-verify', class: 'secondary' }, 'Sign in with the code')));
  const form = el('form', { onsubmit: async (e) => {
    e.preventDefault(); send.disabled = true; status.textContent = 'Sending…'; status.classList.remove('err');
    const { error } = await sb.auth.signInWithOtp({ email: email.value.trim(), options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
    send.disabled = false;
    if (error) { status.classList.add('err'); status.textContent = /signups? not allowed|not found/i.test(error.message) ? 'That email is not part of this journal.' : 'Could not send: ' + error.message; return; }
    status.textContent = 'Check your email. Open the link on this phone, or type the code below.';
    codeBox.hidden = false;
  } }, el('label', { class: 'lbl', for: 'login-email' }, 'Email'), email, el('div', { class: 'inline-actions' }, send));
  box.append(el('h1', { text: 'ThaiTastes' }), el('p', { class: 'desc', text: 'Greg and Andra\'s food journal.' }), form, status, codeBox);
  codeBox.querySelector('#login-verify').addEventListener('click', async () => {
    const { data, error } = await sb.auth.verifyOtp({ email: email.value.trim(), token: code.value.trim(), type: 'email' });
    if (error) { status.classList.add('err'); status.textContent = 'That code did not work. Ask for a new one.'; return; }
    await boot(data.session);
  });
}

async function resolveMember(session) {
  const cached = read(MEMBER_KEY);
  let member = cached && cached.uid === session.user.id ? cached : null;
  if (navigator.onLine !== false) {
    const { data, error } = await sb.from('household_members').select('household_id, name, households(location_retention_days)').eq('user_id', session.user.id).maybeSingle();
    if (data) { member = { uid: session.user.id, hid: data.household_id, name: data.name, retention: data.households?.location_retention_days ?? 30, email: session.user.email }; write(MEMBER_KEY, member); }
    else if (!error) return { denied: true };
  }
  return { member };
}

async function boot(session) {
  if (booted || booting) return;
  booting = true;
  const { member, denied } = await resolveMember(session);
  if (denied) {
    booting = false;
    showLogin('This account is not part of the household. Sign in with the email Greg or Andra registered.');
    await sb.auth.signOut(); return;
  }
  if (!member) { booting = false; showLogin('First sign-in needs an internet connection.'); return; }
  // Arrived from Claude or ChatGPT to connect it: answer that first, then open the journal.
  if (authz.pending() && navigator.onLine !== false) {
    $('#app').hidden = true; $('#tabs').hidden = true; $('#login').hidden = false;
    await new Promise((done) => authz.show({ sb, box: $('#login-card'), issuer: AI_BASE, who: member.name === 'andra' ? 'Andra' : 'Greg', done }));
  }
  booted = true;
  const db = await openDb();
  store = await createStore({ sb, householdId: member.hid, me: member.name, db });
  $('#login').hidden = true; $('#app').hidden = false; $('#tabs').hidden = false;
  const ctx = {
    store, sb, me: member.name, householdId: member.hid, email: member.email, build: BUILD, retentionDays: member.retention, mcpUrl: AI_BASE ? AI_BASE + '/mcp' : '',
    async signOut() {
      const n = store.pending();
      if (n && !confirm(`${n} change${n === 1 ? ' is' : 's are'} not sent yet and would be lost. Sign out anyway?`)) return;
      loc.setOn(false);
      await store.stop({ wipe: true });
      try { localStorage.removeItem(MEMBER_KEY); } catch {}
      await sb.auth.signOut();
      location.reload();
    },
  };
  initApp(ctx);
  loc.start(ctx);
  store.start();
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Local development: no service worker unless asked for with ?sw=1 (it would cache old files).
  if (/^(localhost|127\.|\[::1\])/.test(location.hostname) && !/[?&]sw=1/.test(location.search)) return;
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('ThaiTastes was updated', { label: 'Reload', fn: () => location.reload() }); });
}

async function main() {
  registerWorker();
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { showLogin(); return; }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  window.__tt = { get sb() { return sb; } };
  const { data: { session } } = await sb.auth.getSession();
  if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + location.search);
  sb.auth.onAuthStateChange((event, s) => {
    if (event === 'SIGNED_OUT' && booted) location.reload();
    if (event === 'SIGNED_IN' && s && !booted) boot(s);
  });
  if (session) { await boot(session); return; }
  // Offline with a remembered account: open the app from the data kept on the phone.
  const cached = read(MEMBER_KEY);
  if (cached && navigator.onLine === false) { await boot({ user: { id: cached.uid, email: cached.email } }); return; }
  showLogin();
}
main();
