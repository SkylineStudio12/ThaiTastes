// Finds Playwright: a local install first, then the global one (the sandbox ships it globally).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
export function loadPlaywright() {
  for (const base of [import.meta.url, null]) {
    try {
      const req = base ? createRequire(base) : createRequire(execSync('npm root -g').toString().trim() + '/');
      return req('playwright');
    } catch { /* try next */ }
  }
  return null;
}
