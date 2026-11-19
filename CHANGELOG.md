# Changelog

## Unreleased

- New app icon (sticky rice and mango), built from `design/app-icon.png` by `scripts/make-icons.mjs`: opaque full-bleed
  versions for iOS and Android maskable, rounded versions for the rest. The unused `icons/icon.svg` is removed.

- `scripts/fetch-stock-images.mjs` stores the catalogue photos as WebP (quality 80, via `sharp`; run `cd scripts && npm install`
  first). A rerun converts any earlier JPEG downloads and removes the old files.

- Fix: `scripts/migrate.mjs` failed on a real project with `null value in column "created_at"` for catalogue dishes and
  places. Batch inserts now ask PostgREST to use column defaults for missing fields. The migration test's fake server
  now behaves like PostgREST here, so it catches this.

### Phase 3: the AI layer
- Migration `20261118000006`: the 15 tools as Postgres functions behind one gate, `ai_call()`, which authenticates the
  token hash, rate-limits, runs the tool and writes the audit row in one transaction.
- Edge Function `tt`: MCP over streamable HTTP (`/mcp`) and REST (`/api/<tool>`), both generated from one tool list.
- Minimal OAuth 2.1 server for the Claude app (discovery, dynamic registration, PKCE, rotating refresh tokens), issuing
  the same hashed tokens as Settings. Consent screen in the app.
- `update_entry` and `rate_entry` refuse a stale `updated_at` and return the current record.
- `openapi.json` (OpenAPI 3.1) is built at deploy for ChatGPT Custom GPT Actions.
- `docs/connect-claude.md`, `docs/connect-chatgpt.md`.
- Tests: SQL assertions, the handler end to end on a real local Postgres (including the official MCP client doing the
  full OAuth flow, and simultaneous edits from two clients), the consent screen in a browser, the entry point under Deno.
- Not built: `attach_photo`.
- CI deploys the backend: on a push to `main`, a `backend` job applies the migrations and deploys the `tt` function
  (needs the secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_URL`; migrations go through the session pooler, because
  scoped access tokens cannot use `supabase link`), checks it refuses strangers, and only then
  the app is deployed.

- `docs/PLAN.md`: the four-phase plan, decisions, acceptance criteria and manual checklists.

### Phase 2: the PWA
- `web/`: the artifact's screens (Home, To try, Add, Favourites, History, dish and place pages, editors) ported with their
  wording and styling, now on an offline-first data layer instead of the artifact database.
- Magic-link sign-in (plus a 6-digit code for the installed iPhone app), two users in one household.
- Offline: service worker for the shell, IndexedDB cache, outbox with field-level merge and `updated_at` guard, realtime.
- Camera and library photos, stored offline then uploaded to the private bucket, shown through signed URLs.
- Suggestions inbox, settings (AI token create, rotate, revoke), location sharing with consent, light/dark theme.
- Migration `20261118000005`: places get `ig`; catalogue places can change only link and note.
- GitHub Actions: tests, then deploy of `web/` to Pages with the public config injected from repository variables.
- Catalogue photos are not part of the export; `scripts/fetch-stock-images.mjs` fetches them from Wikimedia Commons.

### Phase 1: repo and backend
- Schema (`supabase/migrations`): households and members, regions, stages and stage periods, dishes, places, entries, favs, locations, suggestions, audit_log, AI client tokens (hashed), rate limiter.
- Row Level Security on every table; anon has no grants; signed-in users can only reach their own household; app users cannot write entries as `claude` or `chatgpt`.
- Private `photos` storage bucket with household-folder policies; realtime publication for the live tables.
- `scripts/migrate.mjs`: repeatable, insert-only import of the export bundle with `--dry-run` and a final count and photo check.
- Local tests: `supabase/tests/run-local.sh` (schema and RLS on a throwaway Postgres), `scripts/test-*.mjs` (transform, and the migration against an in-memory fake Supabase).
