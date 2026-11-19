// The consent screen for "Connect ThaiTastes" in Claude or ChatGPT (OAuth). The assistant sends the browser to the
// AI layer, which sends it here with ?authorize=<request id>. A signed-in household member allows or denies, and
// the browser goes back to the assistant with a one-time code. The id is remembered across the sign-in step.
import { el, fill } from './dom.js';

const KEY = 'tt-authz', MAX_AGE = 10 * 60 * 1000;
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const clear = () => { try { localStorage.removeItem(KEY); } catch {} };

// Call once at start: moves ?authorize= out of the address bar into storage.
export function capture() {
  const u = new URL(location.href);
  const id = u.searchParams.get('authorize');
  if (!id) return;
  if (/^[0-9a-f-]{36}$/i.test(id)) { try { localStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() })); } catch {} }
  u.searchParams.delete('authorize');
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}

export function pending() {
  const p = read();
  if (p && Date.now() - p.at < MAX_AGE) return p.id;
  if (p) clear();
  return null;
}

const KNOWN = [[/(^|\.)claude\.(ai|com)$/, 'claude', 'Claude'], [/(^|\.)(chatgpt|openai)\.com$/, 'chatgpt', 'ChatGPT'], [/^(localhost|127\.0\.0\.1)$/, 'claude', 'an app on this computer']];

function back(redirectUri, params, issuer) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  u.searchParams.set('iss', issuer);
  location.assign(u.toString());
}

// Draws the screen into `box`. `done()` is called when the user stays in the app (expired request, or "Open the journal").
export async function show({ sb, box, issuer, who, done }) {
  const id = pending();
  const finish = () => { clear(); done(); };
  const fail = (msg) => fill(box, el('h1', { text: 'ThaiTastes' }), el('p', { class: 'status err', text: msg }),
    el('div', { class: 'inline-actions' }, el('button', { type: 'button', class: 'primary', onclick: finish }, 'Open the journal')));
  fill(box, el('h1', { text: 'ThaiTastes' }), el('p', { class: 'status', role: 'status', text: 'Checking the request…' }));
  const { data: info, error } = await sb.rpc('oauth_request_info', { p_id: id });
  if (error) return fail('Could not check the request (' + error.message + '). Start again from the assistant.');
  if (!info) return fail('This connection request has expired or was already answered. Start again from the assistant.');

  let host = ''; try { host = new URL(info.redirect_uri).hostname; } catch {}
  const known = KNOWN.find(([re]) => re.test(host));
  const status = el('p', { class: 'status', role: 'status' });
  const author = el('select', { id: 'authz-author', class: 'inp' },
    el('option', { value: 'claude', text: 'Claude', selected: !known || known[1] === 'claude' ? '' : null }),
    el('option', { value: 'chatgpt', text: 'ChatGPT', selected: known && known[1] === 'chatgpt' ? '' : null }));
  const allow = el('button', { type: 'button', class: 'primary' }, 'Allow');
  const deny = el('button', { type: 'button', class: 'secondary' }, 'Deny');
  const answer = async (fn, args, toParams) => {
    allow.disabled = deny.disabled = true; status.classList.remove('err'); status.textContent = 'One moment…';
    const { data, error: e } = await sb.rpc(fn, args);
    if (e) { allow.disabled = deny.disabled = false; status.classList.add('err'); status.textContent = /expired|answered/.test(e.message) ? 'This request has expired. Start again from the assistant.' : 'That did not work: ' + e.message; return; }
    clear();
    status.textContent = 'Returning to the assistant…';
    back(data.redirect_uri, toParams(data), issuer);
  };
  allow.addEventListener('click', () => answer('approve_oauth_request', { p_id: id, p_author: author.value }, (d) => ({ code: d.code, state: d.state })));
  deny.addEventListener('click', () => answer('deny_oauth_request', { p_id: id }, (d) => ({ error: 'access_denied', state: d.state })));

  fill(box,
    el('h1', { text: 'Connect an assistant' }),
    el('p', null, el('b', { text: info.client_name }), ' wants to read your food journal, add entries and ratings you dictate, and send suggestions to your inbox.'),
    el('p', { class: 'desc' }, 'After you answer, you go back to ', el('b', { text: host || info.redirect_uri }), known ? ' (' + known[2] + ').' : '.',
      known ? '' : ' This is not an address ThaiTastes recognises: allow it only if you are sure.'),
    el('p', { class: 'desc', text: 'Allow only if you just started connecting ThaiTastes in Claude or ChatGPT yourself. You are signed in as ' + who + '. You can disconnect it at any time in Settings.' }),
    el('label', { class: 'lbl', for: 'authz-author' }, 'Entries it adds are signed as'), author,
    el('div', { class: 'inline-actions' }, deny, allow),
    status);
}
