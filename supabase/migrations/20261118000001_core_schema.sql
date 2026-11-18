-- ThaiTastes core schema.
-- Every data table carries household_id. Text ids from the original app (n1, c3, doc ids) are kept,
-- so primary keys are (household_id, id) and foreign keys are composite.

create extension if not exists pgcrypto with schema extensions;

-- Random 20-char base36 id, same shape as the ids the original app generated.
create or replace function public.new_id() returns text
language sql volatile as $$
  select string_agg(substr('0123456789abcdefghijklmnopqrstuvwxyz', 1 + (get_byte(b, i) % 36), 1), '')
  from (select extensions.gen_random_bytes(20) as b) s, generate_series(0, 19) i
$$;

-- ---------------------------------------------------------------- households
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  location_retention_days integer not null default 30 check (location_retention_days between 1 and 3650),
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (name in ('greg', 'andra')),
  created_at timestamptz not null default now(),
  primary key (user_id),
  unique (household_id, name)
);

-- ---------------------------------------------------------------- reference data (global)
create table public.regions (
  key text primary key,
  name text not null,
  sub text not null default '',
  sort smallint not null default 0
);

create table public.stages (
  key text primary key,
  name text not null,
  region_key text not null references public.regions(key),
  sort smallint not null default 0
);

-- A stage can be visited more than once (Bangkok at the start and the end), so start dates live here.
create table public.stage_periods (
  start_date date primary key,
  stage_key text not null references public.stages(key)
);

-- Same rule as the original app: the last start date that is <= the given date; before all of them, the first stage.
create or replace function public.stage_for(d date) returns text
language sql stable as $$
  select coalesce(
    (select stage_key from public.stage_periods where start_date <= d order by start_date desc limit 1),
    (select stage_key from public.stage_periods order by start_date limit 1))
$$;

-- ---------------------------------------------------------------- dishes, places
create table public.dishes (
  household_id uuid not null references public.households(id) on delete cascade,
  id text not null default public.new_id(),
  rom text not null,              -- romanised name
  th text,                        -- Thai script
  d text,                         -- description
  region text not null references public.regions(key),
  sublabel text,
  builtin boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (household_id, id)
);

create table public.places (
  household_id uuid not null references public.households(id) on delete cascade,
  id text not null default public.new_id(),
  name text not null,
  th text,
  address text,
  stage text not null references public.stages(key),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  note text,                      -- present on 3 custom places in the export
  builtin boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (household_id, id),
  check ((lat is null) = (lng is null))
);

-- ---------------------------------------------------------------- entries, favs
create table public.entries (
  household_id uuid not null references public.households(id) on delete cascade,
  id text not null default public.new_id(),
  dish_id text,
  dish_free text,
  place_id text,
  place_free text,
  date date not null,
  stage text not null references public.stages(key),
  rating_greg smallint check (rating_greg between 1 and 5),
  rating_andra smallint check (rating_andra between 1 and 5),
  price_thb integer check (price_thb >= 0),
  spice smallint check (spice between 0 and 10),
  again boolean,
  note text,
  photo_path text,                -- object path inside the private 'photos' bucket
  author text not null check (author in ('greg', 'andra', 'claude', 'chatgpt')),
  source_client text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (household_id, id),
  foreign key (household_id, dish_id) references public.dishes(household_id, id),
  foreign key (household_id, place_id) references public.places(household_id, id),
  check (dish_id is not null or dish_free is not null)
);
create index entries_date_idx on public.entries (household_id, date desc, created_at desc);
create index entries_dish_idx on public.entries (household_id, dish_id);
create index entries_place_idx on public.entries (household_id, place_id);
create index dishes_region_idx on public.dishes (household_id, region);
create index places_stage_idx on public.places (household_id, stage);

-- updated_at is the optimistic-concurrency token. Millisecond precision so it survives a trip through
-- JavaScript Date/JSON, and strictly increasing per row so two quick edits never share a value.
create or replace function public.entries_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := greatest(date_trunc('milliseconds', clock_timestamp()), old.updated_at + interval '1 millisecond');
  new.created_at := old.created_at;
  new.household_id := old.household_id;
  new.id := old.id;
  -- The author is who created the entry. A signed-in app user cannot rewrite it; the service role (AI layer) is audited instead.
  if coalesce(auth.role(), '') = 'authenticated' then new.author := old.author; end if;
  return new;
end $$;
create trigger entries_touch before update on public.entries
  for each row execute function public.entries_touch();

create table public.favs (
  household_id uuid not null references public.households(id) on delete cascade,
  dish_id text not null,
  created_at timestamptz not null default now(),
  primary key (household_id, dish_id),
  foreign key (household_id, dish_id) references public.dishes(household_id, id) on delete cascade
);

-- ---------------------------------------------------------------- locations
create table public.locations (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  user_name text not null check (user_name in ('greg', 'andra')),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy real,
  recorded_at timestamptz not null default now(),
  source text not null check (source in ('pwa', 'owntracks'))
);
create index locations_latest_idx on public.locations (household_id, user_name, recorded_at desc);

create view public.latest_locations with (security_invoker = true) as
  select distinct on (household_id, user_name) *
  from public.locations
  order by household_id, user_name, recorded_at desc;

-- Retention is households.location_retention_days (default 30). Scheduled in a later migration when pg_cron is available.
create or replace function public.purge_old_locations() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.locations l using public.households h
   where h.id = l.household_id and l.recorded_at < now() - make_interval(days => h.location_retention_days);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_old_locations() from public, anon, authenticated;

-- ---------------------------------------------------------------- suggestions, audit
create table public.suggestions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  author text not null check (author in ('claude', 'chatgpt')),
  kind text not null check (kind in ('dish', 'place', 'note')),
  payload jsonb not null,
  status text not null default 'new' check (status in ('new', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index suggestions_idx on public.suggestions (household_id, status, created_at desc);

create table public.audit_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  at timestamptz not null default now(),
  actor text not null,            -- claude | chatgpt | ...
  client_id uuid,                 -- ai_clients.id that made the call
  tool text not null,             -- e.g. add_entry
  table_name text,
  record_id text,
  before jsonb,
  after jsonb
);
create index audit_idx on public.audit_log (household_id, at desc);

-- ---------------------------------------------------------------- AI client tokens
create table public.ai_clients (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  author text not null check (author in ('claude', 'chatgpt')),
  token_hash text not null unique,   -- sha256 hex of the bearer token; the token itself is never stored
  token_prefix text not null,        -- first characters, to recognise a token in the settings screen
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);

-- Fixed-window counter used by the Edge Functions (service role only). Returns true when the call is allowed.
create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare w timestamptz; h integer;
begin
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as r (key, window_start, hits) values (p_key, w, 1)
    on conflict (key, window_start) do update set hits = r.hits + 1
    returning r.hits into h;
  delete from public.rate_limits where window_start < now() - interval '1 day';
  return h <= p_limit;
end $$;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
