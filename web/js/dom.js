// Small DOM helpers shared by the screens that live outside app.js.
export const $ = (s, root = document) => root.querySelector(s);

export function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}

export function svgIcon(paths, cls) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
  return t.content.firstChild;
}

export function toast(msg, action) {
  const t = el('div', { class: 'toast', role: 'status' }, el('span', { text: msg }));
  if (action) {
    const b = el('button', { type: 'button', class: 'toast-act', text: action.label });
    b.addEventListener('click', () => { t.remove(); action.fn(); });
    t.append(b);
  }
  document.body.append(t);
  setTimeout(() => t.remove(), action ? 8000 : 2600);
}

export const ago = (ms) => {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/** replaceChildren that ignores null/false entries (the native one would print "null"). */
export const fill = (node, ...kids) => { node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false)); return node; };
