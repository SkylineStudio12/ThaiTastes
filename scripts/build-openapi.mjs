// Writes the OpenAPI document for ChatGPT Custom GPT Actions.
//   node scripts/build-openapi.mjs https://<ref>.supabase.co [out file]     (default out: web/openapi.json)
// The deploy workflow runs this, so the published file always matches the deployed tool list.
import { writeFileSync } from 'node:fs';
import { openapi } from '../supabase/functions/_shared/openapi.js';

const url = (process.argv[2] || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) { console.error('Give the Supabase project URL, e.g. https://abcd.supabase.co'); process.exit(1); }
const out = process.argv[3] || new URL('../web/openapi.json', import.meta.url).pathname;
writeFileSync(out, JSON.stringify(openapi(url + '/functions/v1/tt'), null, 2) + '\n');
console.log('wrote', out);
