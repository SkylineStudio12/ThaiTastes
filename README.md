# ThaiTastes

Food journal for Greg and Andra, Thailand, Nov 2026 to Apr 2027. Static PWA on GitHub Pages, data in Supabase,
and an MCP/REST layer so Claude and ChatGPT can read and write the same journal.

Status: **phases 1 to 3 are done** (backend and migration, the PWA, the AI layer). The extras come next; the full plan is in `docs/PLAN.md`.

## Layout

```
web/                   the PWA: plain HTML, CSS and ES modules. This folder is what GitHub Pages serves
web/js/                app.js (screens, ported from the artifact), store.js (offline-first data layer), settings.js,
                       suggestions.js, location.js, main.js (sign-in and boot)
supabase/migrations/   schema, RLS, storage and realtime, reference data (applied in filename order)
supabase/functions/    the AI layer: tt/ (Edge Function entry) and _shared/ (tools, MCP, REST, OAuth)
supabase/tests/        local schema, RLS and AI-layer tests on a throwaway Postgres
docs/                  PLAN.md (phases, decisions, checklists), connect-claude.md, connect-chatgpt.md
scripts/               migration script and catalogue photo fetch (local only, never deployed) and their tests
test/                  data-layer and browser tests against an in-memory fake Supabase
.github/workflows/     test, then deploy web/ to GitHub Pages
.env.migrate.example   template for the env file the migration reads (the real one is gitignored)
```

No build step. `web/` is served exactly as it is in git (only `js/config.js` is generated at deploy time).

## Secrets rule

The repo is public. Only the Supabase URL and the **anon** key may ever appear in frontend code, and they are safe only
because RLS is on for every table. The **service-role** key lives in `.env.migrate` on your machine (gitignored). The Edge Function
gets it from Supabase itself; you never set or copy it. The export bundle (your journal and photos) is also gitignored.

## Set up the backend

1. Create a Supabase project (free tier is enough). Note the project ref, URL, anon key and service-role key.
2. Install the CLI (`npm i -g supabase` or see supabase.com/docs/guides/cli), then:
   ```sh
   supabase login
   supabase link --project-ref <ref>
   supabase db push          # applies supabase/migrations
   ```
   Or paste the files in `supabase/migrations/` into the Dashboard SQL editor, in order.
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

## Deploy the app (GitHub Pages)

1. Repo Settings > Pages > Build and deployment > Source: **GitHub Actions**.
2. Repo Settings > Secrets and variables > Actions > **Variables** (not Secrets): add `SUPABASE_URL` and
   `SUPABASE_ANON_KEY`. The anon key is public by design; the workflow refuses the service-role or secret key.
3. Supabase Dashboard > Authentication > URL Configuration: Site URL and a Redirect URL = `https://<user>.github.io/<repo>/`.
4. Supabase Dashboard > Authentication > Email Templates > **Magic Link**: add the line `Or type this code: {{ .Token }}`
   to the email. The installed iPhone app cannot receive the link (Safari opens it, with separate storage), so
   the sign-in screen also accepts the 6-digit code.
5. Push to `main`. The workflow runs the tests, writes `web/js/config.js` (URL, anon key, build id), and deploys.
6. Catalogue photos (optional, run once): `cd scripts && npm install && cd ..`, then `node scripts/fetch-stock-images.mjs`, then
   commit `web/images/`. They are stored as WebP (quality 80), about 1.5 to 2 MB in all.
   They were stored inside the artifact and are not in the export, so they are fetched again from the Wikimedia Commons
   pages credited in `web/credits.json`. Without them the app shows its drawn icons.

App icon: the source is `design/app-icon.png`; after replacing it, run `node scripts/make-icons.mjs` (needs `cd scripts &&
npm install` once) and commit `web/icons/`.

Local run: `node test/serve.mjs` serves `web/` on port 8080 (set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the environment).
No service worker runs on localhost unless you add `?sw=1`.

Install: iPhone, Safari > Share > Add to Home Screen. Android, Chrome > Install app.

## Deploy the AI layer

**From GitHub (no laptop needed).** Every push to `main` applies the migrations and deploys the function before the app.
Set this up once, in repo Settings > Secrets and variables > Actions:

- Secret `SUPABASE_ACCESS_TOKEN`: create one at supabase.com/dashboard/account/tokens, scoped to the project, with
  read-write on Edge Functions and Edge Function Secrets. Keep it only here.
- Secret `SUPABASE_DB_URL`: Supabase > Connect > **Session pooler** connection string, with `[YOUR-PASSWORD]` replaced by
  the database password (Project Settings > Database can reset it; letters and digits only avoids URL-encoding).
- Variable `SUPABASE_URL` (already needed for the app). Optional variable `APP_URL` if the app is not at
  `https://<owner>.github.io/<repo>/`.

Then Actions > "Test and deploy to GitHub Pages" > Run workflow (on `main`), or just merge. Without the two secrets the
step is skipped with a warning and the app still deploys.

**By hand**, with the Supabase CLI:

1. `supabase db push` (applies `20261118000006_ai_layer.sql`).
2. `supabase secrets set APP_URL=https://<user>.github.io/<repo>/` (the address of the app, with the trailing slash).
3. `supabase functions deploy tt`. The gateway JWT check is off for this function (`supabase/config.toml`): it checks
   its own tokens.
4. Check: `curl -i https://<ref>.supabase.co/functions/v1/tt/mcp` answers `401`, and
   `https://<ref>.supabase.co/functions/v1/tt/.well-known/openid-configuration` answers JSON.
5. Connect the assistants: `docs/connect-claude.md` and `docs/connect-chatgpt.md`.

Redeploy the function (step 3) whenever `supabase/functions/` changes.

## The AI layer

- **One tool list, two doors.** `supabase/functions/_shared/tools.js` defines 15 tools. The MCP endpoint (`/mcp`), the
  REST endpoint (`/api/<tool>`) and `openapi.json` are all generated from it.
- **The work happens in Postgres.** The function passes the hash of the bearer token to `ai_call()`. That one database
  call finds the client and its household, applies the rate limit, runs the tool, and writes the audit row in the same
  transaction. No query in the function can reach another household, because no query in the function names one.
- **Tokens.** Every assistant connection is a row in `ai_clients` holding only a sha256 hash. A token comes from
  Settings (static, for ChatGPT Actions and Claude Code) or from the OAuth sign-in (for the Claude app: one hour, with
  a rotating refresh token). Both kinds are revoked in Settings.
- **OAuth.** The Claude app only accepts OAuth, so the function is also a minimal OAuth 2.1 server: discovery
  documents, dynamic client registration, authorization code with PKCE, refresh. Consent is a screen in the app.
  Supabase's own OAuth server was not used because its tokens are full user sessions, which would let an assistant
  go around the tools, the audit log and the rate limits.
- **Concurrent edits.** `update_entry` needs the `updated_at` the caller last read. If the entry moved on, nothing is
  written and the current record comes back with `conflict: true`.
- **Limits.** 60 calls a minute per connection, 20 of them writes; request bodies up to 100 kB.
- **Open routes** (no token): the OAuth discovery documents, `/register`, `/authorize`, `/token`. Everything else
  answers `401` without a valid token.
- `attach_photo` is not built yet; photos are added in the app.

## How the app behaves

- **Offline first.** Rows are cached in IndexedDB; the app shell is cached by a service worker. Anything you add or
  edit offline is saved on the phone and sent when you are back online (also on app start and when the app becomes
  visible again: iOS has no background sync).
- **Edits merge.** An edit to an entry sends only the fields you changed, guarded by `updated_at`. If Claude changed the
  note while you changed the rating, both survive. If both changed the same field, yours is applied last.
- **Live.** Realtime subscriptions merge changes from the AI layer into the open app; after a dropped connection the app
  does a full catch-up sync.
- **Photos.** Taken from the camera or library, shrunk to 1600 px, stored locally at once, uploaded to the private
  bucket, served through signed URLs and kept on the device for offline viewing.
- **Suggestions.** Claude and ChatGPT propose dishes, places and notes; they show on Home and nothing changes until you accept.
  Payloads: dish `{rom, th?, d?, region, reason?}`, place `{name, th?, address?, stage, lat?, lng?, note?, reason?}`, note `{text, dish_id?, place_id?, entry_id?}`.
- **Settings** (gear on Home): account and sync status, location sharing and retention, AI tokens (create, rotate, revoke;
  a token is shown once), theme.
- **Location.** Off until you allow it. While the app is open and visible it sends a point at most every 5 minutes.
  iOS (and most browsers) do not allow background geolocation for web apps, so the assistants see the last known point and
  its age. Phase 4 adds an OwnTracks endpoint for real background tracking.

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
npm ci && npm test                                              # data layer (fake Supabase), AI layer (throwaway Postgres), browser tests if Playwright is installed
BUNDLE_DIR=/path/to/thaitastes-export npm test                  # same, with your real data in the browser tests
bash supabase/tests/run-local.sh                                # schema, RLS and AI functions on a local Postgres (needs postgresql server binaries)
DENO=$(which deno) node --test test/deno.test.mjs               # the Edge Function entry under Deno
cd scripts && BUNDLE_DIR=/path/to/thaitastes-export node --test # transform tests + migration against a fake Supabase
```

The fake Supabase in `test/` is not Supabase. Realtime, Auth emails and Storage policies are only proven against a real
project, and the OAuth sign-in only against Claude and ChatGPT themselves: see the checklists in `docs/PLAN.md`.
