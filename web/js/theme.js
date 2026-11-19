// Runs before first paint so a saved light/dark choice does not flash.
try { const t = localStorage.getItem('tt-theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) {}
