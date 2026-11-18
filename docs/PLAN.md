# ThaiTastes migration plan

The plan for moving ThaiTastes from a Claude.ai artifact to an app Greg and Andra own. Status as of 2026-11-18.

## Goal

ThaiTastes is a personal food journal for a 5-month Thailand trip (Nov 2026 to Apr 2027). It started as a Claude.ai
artifact, where the data, photos and code all lived inside Claude. The goal is the same app, with the same screens and
data, as a PWA that:

- is installed on both phones and works offline,
- keeps its data in a database the owners control,
- lets Claude and ChatGPT read and write the same journal through an API, with every write attributed and logged.

## Target architecture

| Part | Choice |
| --- | --- |
| Frontend | Static PWA on GitHub Pages. Plain HTML, CSS and ES modules, no build step. |
| Backend | Supabase: Postgres, Auth (magic link, signups off), Storage (private `photos` bucket), Realtime. |
| AI access | Supabase Edge Functions: a remote MCP server (streamable HTTP) for Claude, and a REST API with an OpenAPI 3.1 spec for ChatGPT Custom GPT Actions. Both call one shared service layer. |
| AI auth | Per-client bearer tokens, stored hashed (sha256), created, rotated and revoked from Settings. OAuth 2.1 or static tokens is decided at the start of phase 3. |
| Deploy | GitHub Actions: tests, then `web/` to Pages with the public config injected from repository Variables. |

Rules that hold throughout:

- The repo is public. Only the Supabase URL and anon key appear in frontend code. The service-role key never enters git.
- RLS is on for every table; unauthenticated requests are rejected.
- UI language is English, with Thai script where the data has it.
- The artifact's screens, wording and styling are kept.

## Decisions made

- **Separate repo** (`SkylineStudio12/ThaiTastes`), not a folder in another project.
- **No build step.** `web/` is served as it is in git.
- **`household_id` on every table** plus a `household_members` table; RLS checks membership with `is_member()`.
- **Original ids are kept** (`n1`, `c3`, the random doc ids). Primary keys are `(household_id, id)`.
- **`entries.updated_at` is the concurrency token**: millisecond precision, strictly increasing per row.
- **Stages are split** into `stages` and `stage_periods`, because Bangkok appears twice in the itinerary.
- **Sign-in is magic link plus a 6-digit code**, because the installed iPhone app cannot receive the link.
- **PWA location sharing is off by default**, needs consent, and runs only while the app is open (at most every
  5 minutes). Background tracking comes from OwnTracks in phase 4.
- **Migrated entries** get `author = greg` and `source_client = migration`.

## Phases

Each phase ends with a stop, a demo, and a checklist of what the owners must do by hand.

### Phase 1: repo and backend. Done (PR #1, merged)

- Schema, RLS, private storage bucket, realtime publication, reference data.
- Hashed AI client tokens, rate limiter function, audit log table, location retention purge.
- `scripts/migrate.mjs`: repeatable, insert-only import of the export bundle, with `--dry-run` and a count and photo check.
- Local SQL tests (schema and RLS) and migration tests against a fake Supabase.

### Phase 2: the PWA. Done, in review (PR #2)

- The artifact's screens ported onto an offline-first data layer (`web/js/store.js`).
- IndexedDB cache, outbox, field-level merge guarded by `updated_at`, realtime with catch-up sync.
- Service worker for the app shell; photos cached for offline viewing.
- Sign-in, Settings (sync status, location, AI tokens, theme), suggestions inbox.
- Pages deploy workflow; data-layer and browser tests.

### Phase 3: the AI layer. Pending

- Shared service layer used by both paths.
- MCP server (Edge Function, streamable HTTP) and REST API with an OpenAPI 3.1 spec.
- Tools, the same on both paths:

  | Read | Write |
  | --- | --- |
  | `get_context` | `add_entry` |
  | `search_entries` | `update_entry` (rejects a stale `updated_at` and returns the current record) |
  | `get_entry` | `rate_entry` (only when the user states the rating) |
  | `list_dishes` | `add_dish` |
  | `list_places` | `add_place` |
  | `get_stats` | `toggle_fav` |
  | `list_suggestions` | `add_suggestion` |
  | `get_latest_location` | `attach_photo` (optional) |

- Every write records `author` and `source_client`, and lands in `audit_log`.
- Bearer token check against the hashed tokens, and rate limiting per client.
- OAuth decision: check what Claude custom connectors and ChatGPT developer mode currently require, choose OAuth 2.1
  or static tokens, and record which and why.
- `docs/connect-claude.md` and `docs/connect-chatgpt.md`.

### Phase 4: extras. Pending

- Location history view in the app.
- OwnTracks endpoint for background location.
- CSV and JSON export button.
- Nightly backup of the database and photos.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| A fresh clone, the README steps and your Supabase keys give a working deploy; no secrets in git history. | Workflow and README written. Not yet run against a real project. |
| Migration counts are exact and every photo opens. | The script enforces this (85 entries, 62 dishes, 28 places, 16 favs, 35 photos). Passed against a fake Supabase; the real run is yours. |
| An MCP-added entry appears live in the open PWA with `author` set. | Phase 3. The PWA side (realtime merge) is tested against a fake server only. |
| Concurrent edits from two AI clients never silently overwrite each other. | Phase 3. The `updated_at` guard exists in the schema and the PWA. |
| Unauthenticated requests to any table or function are rejected. | Tables: covered by the local RLS tests. Functions: phase 3. |
| Lighthouse PWA install criteria pass and the app works offline. | Offline reload and queued sync pass in a Chromium test. Installability checked through Chrome's own check (no errors); Lighthouse no longer has a PWA category. Not yet tested on a phone. |
| UI is English, with Thai script where the data has it. | Done. |

## Manual checklists

### After phase 1

- [ ] Create the Supabase project; note the ref, URL, anon key and service-role key.
- [ ] `supabase link`, then `supabase db push`.
- [ ] Authentication: keep Email on, turn off "Allow new users to sign up".
- [ ] Optional: enable `pg_cron` and schedule the nightly location purge.
- [ ] Fill in `.env.migrate`, run `migrate.mjs --dry-run`, then the real run; confirm the counts.

### After phase 2

- [ ] Review and merge PR #2.
- [ ] Repo Settings > Pages > Source: GitHub Actions.
- [ ] Add repository **Variables** (not Secrets) `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- [ ] Supabase Auth: set Site URL and a Redirect URL to the Pages address.
- [ ] Supabase Auth email template (Magic Link): add `Or type this code: {{ .Token }}`.
- [ ] `supabase db push` again, for migration `20261118000005`.
- [ ] Run `node scripts/fetch-stock-images.mjs` and commit `web/images/`.
- [ ] On both phones: sign in (link and code), add to Home Screen, take a photo, add an entry in airplane mode
      and watch it sync, turn on location sharing.

### After phase 3 and phase 4

Written when each phase is delivered.

## Known gaps

- Nothing has run against a real Supabase project yet. Realtime, Auth emails, Storage policies and the token functions
  are proven only against a fake server and a local Postgres.
- The catalogue photos (about 64 Wikimedia images) were stored inside the artifact and are not in the export. The fetch
  script exists but has not been run; until then the app shows its drawn icons.
- iOS does not allow background geolocation for web apps, so until phase 4 the assistants see only the last point
  recorded while the app was open.
