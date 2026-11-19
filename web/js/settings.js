// Settings: account and sync, location sharing, the AI connections (tokens), appearance.
import { el, toast, ago, fill } from './dom.js';
import * as loc from './location.js';

let root = null, state = { clients: null, error: '', fresh: null, busy: false, consent: false };
let parts = {};

const THEME_KEY = 'tt-theme';
export function applyTheme() {
  let t = 'auto'; try { t = localStorage.getItem(THEME_KEY) || 'auto'; } catch {}
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? '#16162a' : '#1b1d3d');
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label + ' copied'); }
  catch { toast('Select the text and copy it by hand'); }
}

async function loadClients(ctx) {
  const { data, error } = await ctx.sb.from('ai_clients').select('id, name, author, token_prefix, created_at, last_used_at, revoked_at, oauth_client_id').order('created_at');
  state.error = error ? 'Could not load the connections (' + error.message + ').' : '';
  if (!error) state.clients = data;
  draw(ctx);
}

async function rpc(ctx, fn, args) {
  if (state.busy) return null;
  state.busy = true; draw(ctx);
  try {
    const { data, error } = await ctx.sb.rpc(fn, args);
    if (error) throw error;
    return data;
  } catch (e) { toast('Failed: ' + (e.message || e)); return null; }
  finally { state.busy = false; await loadClients(ctx); }
}

function build(ctx) {
  root = el('div', { class: 'settings' });
  for (const k of ['account', 'location', 'ai', 'look']) { parts[k] = el('section', { class: 'card set-card' }); root.append(parts[k]); }
  parts.about = el('p', { class: 'desc set-about' });
  root.append(parts.about);
}

function draw(ctx) {
  if (!root) return;
  const v = ctx.store.snapshot(), st = v.status, online = st.online;
  const who = ctx.me === 'andra' ? 'Andra' : 'Greg';

  // ---- account and sync
  fill(parts.account, 
    el('div', { class: 'card-h' }, el('h3', { text: 'Account' })),
    el('p', { class: 'set-row' }, 'Signed in as ', el('b', { text: who }), ctx.email ? el('span', { class: 'desc', text: ' · ' + ctx.email }) : null),
    el('p', { class: 'desc', text: !online ? 'Offline. Changes are kept on this phone and sent when you are back online.' :
      (st.pending ? 'Sending ' + st.pending + ' change' + (st.pending === 1 ? '' : 's') + '…' : 'Everything is saved. Last sync ' + ago(st.lastSync) + '.') +
      (st.realtime === 'live' ? ' Live updates on.' : '') }),
    el('div', { class: 'inline-actions' },
      el('button', { type: 'button', class: 'secondary', onclick: () => ctx.store.sync().then(() => toast('Synced')).catch(() => toast('Could not sync right now')) }, 'Sync now'),
      el('button', { type: 'button', class: 'secondary', onclick: () => ctx.signOut() }, 'Sign out')));

  // ---- location
  const on = loc.isOn();
  const last = loc.lastSent();
  const consent = state.consent && !on;
  fill(parts.location, 
    el('div', { class: 'card-h' }, el('h3', { text: 'Location' })),
    el('p', { class: 'desc', text: 'While the app is open, it can send where you are every few minutes, so Claude and ChatGPT know which town you are in. It cannot do this in the background: iPhones and most browsers stop web apps from reading the location once you leave the app.' }),
    consent
      ? el('div', { class: 'consent' },
          el('p', { text: 'Allow ThaiTastes to read your location while it is open and upload it to your journal? Claude and ChatGPT can read the latest point. You can turn this off at any time.' }),
          el('div', { class: 'inline-actions' },
            el('button', { type: 'button', class: 'secondary', onclick: () => { state.consent = false; draw(ctx); } }, 'Not now'),
            el('button', { type: 'button', class: 'primary', onclick: () => { state.consent = false; loc.setOn(true); draw(ctx); } }, 'Allow')))
      : el('label', { class: 'switch' },
          el('input', { type: 'checkbox', checked: on ? '' : null, disabled: !loc.supported(), onchange: (e) => { if (e.target.checked) { e.target.checked = false; state.consent = true; draw(ctx); } else { loc.setOn(false); draw(ctx); } } }),
          el('span', { text: on ? 'Sharing my location while the app is open' : 'Share my location while the app is open' })),
    on ? el('p', { class: 'desc', text: last ? 'Last point sent ' + ago(last) + '.' : 'Waiting for the first point…' }) : null,
    el('label', { class: 'lbl', for: 'loc-days' }, 'Keep location history for (days)'),
    el('div', { class: 'set-inline' },
      el('input', { id: 'loc-days', class: 'inp', type: 'number', min: '1', max: '3650', step: '1', value: String(ctx.retentionDays ?? 30), disabled: !online }),
      el('button', { type: 'button', class: 'secondary', disabled: !online, onclick: async () => {
        const n = Math.round(Number(document.getElementById('loc-days').value));
        if (!(n >= 1 && n <= 3650)) { toast('Use a number from 1 to 3650'); return; }
        const { error } = await ctx.sb.from('households').update({ location_retention_days: n }).eq('id', ctx.householdId);
        if (error) toast('Not saved: ' + error.message); else { ctx.retentionDays = n; toast('Saved'); }
      } }, 'Save')));

  // ---- AI connections
  const fresh = state.fresh;
  const list = state.clients;
  fill(parts.ai, 
    el('div', { class: 'card-h' }, el('h3', { text: 'AI assistants' })),
    el('p', { class: 'desc', text: 'Claude connects by signing in: add the connector address below in Claude and approve it here. ChatGPT and Claude Code use a secret token you create here; it is shown only once. Steps are in docs/connect-claude.md and docs/connect-chatgpt.md. Revoke a connection and that assistant is locked out at once.' }),
    fresh ? el('div', { class: 'token-box', role: 'status' },
      el('b', { text: 'Token for ' + fresh.name }),
      el('code', { class: 'token', text: fresh.token }),
      el('p', { class: 'desc', text: 'Copy it now. It cannot be shown again, only replaced with a new one.' }),
      el('div', { class: 'inline-actions' },
        el('button', { type: 'button', class: 'secondary', onclick: () => { state.fresh = null; draw(ctx); } }, 'Done'),
        el('button', { type: 'button', class: 'primary', onclick: () => copy(fresh.token, 'Token') }, 'Copy token'))) : null,
    state.error ? el('p', { class: 'err', text: state.error }) : null,
    !online && !list ? el('p', { class: 'desc', text: 'Connect to the internet to manage tokens.' }) : null,
    list && list.length ? el('ul', { class: 'clients' }, list.map((c) => el('li', { class: c.revoked_at ? 'revoked' : '' },
      el('div', null, el('b', { text: c.name }), el('span', { class: 'desc', text: ' · ' + (c.author === 'chatgpt' ? 'ChatGPT' : 'Claude') + ' · ' + (c.oauth_client_id ? 'signed in' : c.token_prefix + '…') }),
        el('div', { class: 'desc', text: c.revoked_at ? 'Revoked ' + ago(Date.parse(c.revoked_at)) : 'Last used ' + (c.last_used_at ? ago(Date.parse(c.last_used_at)) : 'never') })),
      el('div', { class: 'row-btns' },
        c.oauth_client_id ? null : el('button', { type: 'button', class: 'secondary sm', disabled: state.busy || !online, onclick: async () => {
          if (!confirm('Replace the token for ' + c.name + '? The old one stops working immediately.')) return;
          const t = await rpc(ctx, 'rotate_ai_client', { p_id: c.id }); if (t) { state.fresh = { name: c.name, token: t }; draw(ctx); }
        } }, 'Rotate'),
        c.revoked_at ? null : el('button', { type: 'button', class: 'secondary sm', disabled: state.busy || !online, onclick: async () => {
          if (!confirm('Revoke ' + c.name + '? It will stop working immediately.')) return;
          await rpc(ctx, 'revoke_ai_client', { p_id: c.id });
        } }, 'Revoke'))))) : (list ? el('p', { class: 'desc', text: 'No assistants connected yet.' }) : null),
    el('form', { class: 'set-add', onsubmit: async (e) => {
      e.preventDefault();
      const f = e.target, name = f.name.value.trim().slice(0, 60), author = f.author.value;
      if (!name) { toast('Give the connection a name'); return; }
      const r = await rpc(ctx, 'create_ai_client', { p_name: name, p_author: author });
      const row = Array.isArray(r) ? r[0] : r;
      if (row && row.token) { state.fresh = { name, token: row.token }; f.reset(); draw(ctx); }
    } },
      el('label', { class: 'lbl', for: 'ai-name' }, 'New connection'),
      el('div', { class: 'set-inline' },
        el('input', { id: 'ai-name', name: 'name', class: 'inp', type: 'text', maxlength: '60', placeholder: 'e.g. Claude on my phone', autocomplete: 'off', disabled: !online }),
        el('select', { name: 'author', class: 'inp narrow', 'aria-label': 'Assistant' }, el('option', { value: 'claude', text: 'Claude' }), el('option', { value: 'chatgpt', text: 'ChatGPT' }))),
      el('div', { class: 'inline-actions' }, el('button', { type: 'submit', class: 'primary', disabled: state.busy || !online }, 'Create token'))),
    ctx.mcpUrl ? el('p', { class: 'desc' }, 'Connector address (MCP): ', el('code', { class: 'token', text: ctx.mcpUrl })) : null,
    ctx.mcpUrl ? el('div', { class: 'inline-actions' }, el('button', { type: 'button', class: 'secondary', onclick: () => copy(ctx.mcpUrl, 'Address') }, 'Copy address')) : null);

  // ---- appearance
  let theme = 'auto'; try { theme = localStorage.getItem(THEME_KEY) || 'auto'; } catch {}
  fill(parts.look, 
    el('div', { class: 'card-h' }, el('h3', { text: 'Appearance' })),
    el('label', { class: 'lbl', for: 'theme' }, 'Theme'),
    el('select', { id: 'theme', class: 'inp', onchange: (e) => { try { localStorage.setItem(THEME_KEY, e.target.value); } catch {} applyTheme(); } },
      ...[['auto', 'Match the phone'], ['light', 'Light'], ['dark', 'Dark']].map(([v, n]) => el('option', { value: v, text: n, selected: v === theme ? '' : null }))));
  parts.about.textContent = 'ThaiTastes · build ' + (ctx.build || 'dev');
}

export function renderSettings(ctx) {
  const host = document.getElementById('settings');
  if (!root) build(ctx);
  if (root.parentNode !== host) host.replaceChildren(root);
  // Re-drawing while someone is typing in a field would lose the text, so only the status parts refresh then.
  if (!state.clients && ctx.store.snapshot().status.online && !state.loading) { state.loading = true; loadClients(ctx).finally(() => { state.loading = false; }); }
  const typing = root.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (!typing) draw(ctx);
}

export function resetSettings() { root = null; parts = {}; state = { clients: null, error: '', fresh: null, busy: false, consent: false }; }
