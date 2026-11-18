// Inbox: things Claude or ChatGPT proposed. Nothing here touches the journal until you accept it.
import { el, svgIcon, toast, ago, fill } from './dom.js';

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const who = (a) => (a === 'chatgpt' ? 'ChatGPT' : 'Claude');

/** Payload shapes (also documented in the README and used by the add_suggestion tool):
 *  dish:  { rom, th?, d?, region, reason? }
 *  place: { name, th?, address?, stage, lat?, lng?, note?, reason? }
 *  note:  { text, dish_id?, place_id?, entry_id? } */
function describe(x, ctx) {
  const p = x.payload || {};
  if (x.kind === 'dish') {
    const region = ctx.REGIONS.find((r) => r.k === p.region);
    return { title: p.rom || p.th || 'A dish', meta: [p.th && p.rom ? p.th : null, region ? region.n : null].filter(Boolean).join(' · '),
      body: p.d, reason: p.reason, ok: !!(p.rom || p.th) && !!region, why: region ? '' : 'The region is missing or unknown.' };
  }
  if (x.kind === 'place') {
    const stage = ctx.STAGES.find((s) => s.k === p.stage);
    return { title: p.name || 'A place', meta: [stage ? stage.n : null, p.address].filter(Boolean).join(' · '), body: p.note, reason: p.reason,
      ok: !!p.name && !!stage, why: stage ? '' : 'The trip stop is missing or unknown.' };
  }
  return { title: 'A note', meta: '', body: p.text, reason: null, ok: true, why: '' };
}

function accept(x, ctx) {
  const p = x.payload || {};
  const snap = ctx.store.snapshot();
  if (x.kind === 'dish') {
    const exists = [...snap.dishes.builtin, ...snap.dishes.custom].some((d) => norm(d.rom) === norm(p.rom));
    if (exists) toast('Already on the list');
    else ctx.store.saveDish({ rom: String(p.rom || p.th).slice(0, 80), th: p.th || null, d: p.d ? String(p.d).slice(0, 300) : null, r: p.region, createdAt: Date.now() });
  } else if (x.kind === 'place') {
    const exists = [...snap.places.builtin, ...snap.places.custom].some((q) => norm(q.n) === norm(p.name));
    if (exists) toast('Already on the list');
    else ctx.store.savePlace({ n: String(p.name).slice(0, 80), th: p.th || null, a: p.address ? String(p.address).slice(0, 160) : null, st: p.stage,
      note: p.note ? String(p.note).slice(0, 1000) : null, c: Number.isFinite(p.lat) && Number.isFinite(p.lng) ? [p.lat, p.lng] : undefined, createdAt: Date.now() });
  }
  ctx.store.setSuggestionStatus(x.id, 'accepted');
}

let root = null;
export function renderSuggestions(ctx) {
  const host = document.getElementById('suggest');
  if (!root) root = el('div', { class: 'sug' });
  if (root.parentNode !== host) host.replaceChildren(root);
  const all = ctx.store.snapshot().suggestions;
  const fresh = all.filter((x) => x.status === 'new'), done = all.filter((x) => x.status !== 'new').slice(0, 20);

  const card = (x) => {
    const d = describe(x, ctx);
    const isNew = x.status === 'new';
    return el('div', { class: 'card sug-card' },
      el('div', { class: 'sug-h' },
        el('span', { class: 'sug-by ' + x.author, text: who(x.author) }),
        el('span', { class: 'sug-kind', text: x.kind === 'dish' ? 'Dish' : x.kind === 'place' ? 'Place' : 'Note' }),
        el('span', { class: 'sug-when', text: ago(x.createdAt) })),
      el('div', { class: 'sug-t', text: d.title }),
      d.meta ? el('div', { class: 'desc', text: d.meta }) : null,
      d.body ? el('p', { class: 'sug-body', text: d.body }) : null,
      d.reason ? el('p', { class: 'sug-reason', text: d.reason }) : null,
      !d.ok ? el('p', { class: 'err', text: d.why + ' Dismiss it, or ask the assistant to resend it.' }) : null,
      isNew
        ? el('div', { class: 'inline-actions' },
            el('button', { type: 'button', class: 'secondary', onclick: () => { ctx.store.setSuggestionStatus(x.id, 'dismissed'); ctx.rerender(); } }, 'Dismiss'),
            el('button', { type: 'button', class: 'primary', disabled: !d.ok, onclick: () => { accept(x, ctx); ctx.rerender(); toast(x.kind === 'note' ? 'Marked as read' : 'Added'); } },
              svgIcon('<path d="M20 6 9 17l-5-5"/>', 'ic'), x.kind === 'dish' ? 'Add to list' : x.kind === 'place' ? 'Add place' : 'Got it'))
        : el('span', { class: 'desc', text: x.status === 'accepted' ? 'Accepted' : 'Dismissed' }));
  };

  fill(root, 
    fresh.length ? el('div', { class: 'sug-list' }, fresh.map(card))
      : el('div', { class: 'fempty' }, svgIcon('<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z"/>', 'ic'), 'Nothing waiting. Claude and ChatGPT can propose dishes, places and notes here.'),
    done.length ? el('details', { class: 'sug-done' }, el('summary', { text: 'Earlier (' + done.length + ')' }), el('div', { class: 'sug-list' }, done.map(card))) : null);
}
