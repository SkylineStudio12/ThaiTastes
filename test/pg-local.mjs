// Starts a throwaway local Postgres with the Supabase stubs and every migration applied (same recipe as
// supabase/tests/run-local.sh), for tests that need the real SQL. Returns null when the server binaries are missing.
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pgBin() {
  try {
    const base = '/usr/lib/postgresql';
    const v = readdirSync(base).sort((a, b) => Number(a) - Number(b)).pop();
    const bin = path.join(base, v, 'bin');
    return existsSync(path.join(bin, 'initdb')) ? bin : null;
  } catch { return null; }
}

export async function startDb() {
  const bin = pgBin();
  if (!bin) return null;
  const dir = mkdtempSync(path.join(tmpdir(), 'tt-pg-'));
  const port = 54400 + Math.floor(Math.random() * 400);
  const isRoot = userInfo().uid === 0;
  chmodSync(dir, 0o755);
  const sh = (cmd) => (isRoot ? execFileSync('su', ['postgres', '-c', cmd], { stdio: 'pipe' }) : execSync(cmd, { stdio: 'pipe' }));
  if (isRoot) execFileSync('chown', ['postgres', dir]);
  sh(`${bin}/initdb -D ${dir}/data -A trust -U postgres >/dev/null && ${bin}/pg_ctl -D ${dir}/data -o '-p ${port} -k ${dir} -c listen_addresses=' -l ${dir}/log -w start >/dev/null`);
  const stopServer = () => { try { sh(`${bin}/pg_ctl -D ${dir}/data -m immediate stop >/dev/null`); } catch {} rmSync(dir, { recursive: true, force: true }); };
  try {
    const psql = (file) => sh(`psql -h ${dir} -p ${port} -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X -f '${file}' 2>&1`);
    psql(path.join(root, 'supabase/tests/stub.sql'));
    for (const f of readdirSync(path.join(root, 'supabase/migrations')).sort()) psql(path.join(root, 'supabase/migrations', f));
  } catch (e) { stopServer(); throw new Error('migrations failed: ' + (e.stdout || e.message)); }
  const pool = new pg.Pool({ host: dir, port, user: 'postgres', database: 'postgres', max: 8 });
  // On Supabase the service role has every table grant by default; the stub does not.
  await pool.query('grant all on all tables in schema public to service_role; grant usage on all sequences in schema public to service_role');

  // Calls public.<name>(named args) under the given role, the way PostgREST would.
  async function call(role, sub, name, params) {
    const keys = Object.keys(params);
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`set local role ${role}`);
      if (sub) await c.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)`, [sub, role]);
      const r = await c.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => params[k]));
      await c.query('commit');
      return r.rows[0].r;
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  return {
    pool,
    rpc: (name, params) => call('service_role', null, name, params),
    asUser: (uid) => (name, params) => call('authenticated', uid, name, params),
    async stop() { await pool.end(); stopServer(); },
  };
}
