# ThaiTastes

Food journal for Greg and Andra, Thailand, Nov 2026 to Apr 2027. Static PWA on GitHub Pages, data in Supabase,
and an MCP/REST layer so Claude and ChatGPT can read and write the same journal.

Status: **phase 1 (backend and migration) done.** The PWA, the AI layer and the extras come next; see `CHANGELOG.md`.

## Layout

```
supabase/migrations/   schema, RLS, storage and realtime, reference data (applied in filename order)
supabase/tests/        local schema/RLS tests on a throwaway Postgres
scripts/               migration script (local only, never deployed) and its tests
.env.migrate.example   template for the env file the migration reads (the real one is gitignored)
```

No build step. The frontend (phase 2) is plain ES modules that GitHub Pages serves as they are.

## Secrets rule

The repo is public. Only the Supabase URL and the **anon** key may ever appear in frontend code, and they are safe only
because RLS is on for every table. The **service-role** key lives in `.env.migrate` on your machine (gitignored) and, in
phase 3, as a Supabase Edge Function secret. The export bundle (your journal and photos) is also gitignored.

## Set up the backend

1. Create a Supabase project (free tier is enough). Note the project ref, URL, anon key and service-role key.
2. Install the CLI (`npm i -g supabase` or see supabase.com/docs/guides/cli), then:
   ```sh
   supabase login
   supabase link --project-ref <ref>
   supabase db push          # applies supabase/migrations
   ```
   Or paste the four files in `supabase/migrations/` into the Dashboard SQL editor, in order.
3. Dashboard > Authentication > Providers > Email: keep Email on, turn **off** "Allow new users to sign up".
   Dashboard > Authentication > URL Configuration: set the Site URL to your Pages URL.
4. Optional: Dashboard > Database > Extensions > enable `pg_cron`, then re-run the last block of
   `20261118000003_storage_realtime.sql` to schedule the nightly location purge.
5. Import the data:
   ```sh
   cp .env.migrate.example .env.migrate      # fill in URL, service-role key, the two emails
   cd scripts && npm install
   node migrate.mjs --bundle /path/to/thaitastes-export --dry-run   # offline check of the bundle
   node migrate.mjs --bundle /path/to/thaitastes-export             # the real run
   ```
   The real run prints inserted/already-present per table, then verifies against the bundle: 85 entries, 62 custom
   dishes, 28 custom places, 16 favs, 35 photos (each fetched through a signed URL). It exits non-zero on any mismatch.
   Run it again at any time: existing rows are skipped, never overwritten.

## Data notes

- Ids are kept (`n1`, `c3`, the random doc ids). Primary keys are `(household_id, id)`; new rows get a 20-char id.
- Every data table has `household_id`; `is_member()` in RLS compares it with the signed-in user's membership.
- **Stages**: Bangkok appears twice in the itinerary, so start dates live in `stage_periods` and `stage_for(date)`
  returns the current stage with the original app's rule.
- **Places** have `lat`/`lng` columns instead of the `c` array, and a `note` column (3 custom places had one).
- **Entries** have `photo_path` (`<household_id>/<assetId>.jpg` in the private `photos` bucket). Two entries share one
  photo (`cl-payak-icecream-1106`, `cl-payak-grassjelly-1106`); that is 36 references to 35 files.
- **Migrated entries** get `author = greg` and `source_client = migration`, because the artifact never recorded an author.
  Change it with a single `update entries set author = ... where source_client = 'migration' and id like ...` if you care.
- **Sanpakoi**: entries that used `cnx-sanpakoi` now use `o0vflgkc8hbdyc43p7m0`, as requested (3 entries). The built-in
  `cnx-sanpakoi` place (which has coordinates) still exists, so there are now two places with that name.
- Two built-in dishes (`e2`, `e3`) stored their name as `ro`; it is loaded into `rom`.
- Location retention is `households.location_retention_days` (default 30); `purge_old_locations()` applies it.

## Tests

```sh
bash supabase/tests/run-local.sh                                # schema + RLS on a local Postgres (needs postgresql server binaries)
cd scripts && BUNDLE_DIR=/path/to/thaitastes-export node --test # transform tests + migration against a fake Supabase
```
