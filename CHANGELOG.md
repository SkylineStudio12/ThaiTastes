# Changelog

## Unreleased

### Phase 1: repo and backend
- Schema (`supabase/migrations`): households and members, regions, stages and stage periods, dishes, places, entries, favs, locations, suggestions, audit_log, AI client tokens (hashed), rate limiter.
- Row Level Security on every table; anon has no grants; signed-in users can only reach their own household; app users cannot write entries as `claude` or `chatgpt`.
- Private `photos` storage bucket with household-folder policies; realtime publication for the live tables.
- `scripts/migrate.mjs`: repeatable, insert-only import of the export bundle with `--dry-run` and a final count and photo check.
- Local tests: `supabase/tests/run-local.sh` (schema and RLS on a throwaway Postgres), `scripts/test-*.mjs` (transform, and the migration against an in-memory fake Supabase).
