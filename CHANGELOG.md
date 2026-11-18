# Changelog

## Unreleased

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
