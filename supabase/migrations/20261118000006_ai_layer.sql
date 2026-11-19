-- The AI layer. Claude and ChatGPT never touch tables: the Edge Function calls ai_call() with the sha256 of the
-- bearer token, and everything else (who the client is, which household, rate limits, the write and its audit row)
-- happens here in one transaction. All ai_* and oauth_* functions are for the service role only, except the three
-- consent functions at the end, which signed-in household members call from the app.

-- ---------------------------------------------------------------- OAuth storage
alter table public.ai_clients
  add column expires_at timestamptz,          -- null: a static token from Settings, valid until revoked
  add column refresh_hash text unique,        -- sha256 of the OAuth refresh token
  add column oauth_client_id text;            -- the registered OAuth client this token was issued to

create table public.oauth_clients (
  client_id text primary key default ('oc_' || public.new_id()),
  client_name text not null,
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  created_at timestamptz not null default now()
);

create table public.oauth_requests (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  state text,
  code_challenge text not null,
  resource text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  household_id uuid references public.households(id) on delete cascade,
  approved_by text,                           -- greg | andra
  author text check (author in ('claude', 'chatgpt')),
  denied boolean not null default false,
  code_hash text unique,
  used_at timestamptz,
  ai_client_id uuid references public.ai_clients(id) on delete set null
);
alter table public.oauth_clients enable row level security;
alter table public.oauth_requests enable row level security;
-- RLS on with no policy and no grant: only the service role and the definer functions below reach these.

-- ---------------------------------------------------------------- helpers
create or replace function public.ai_fail(p_code text, p_message text) returns void
language plpgsql as $$ begin raise exception '%', p_message using errcode = 'TT000', hint = p_code; end $$;

create or replace function public.ai_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Bangkok')::date $$;

create or replace function public.ai_limit(p_args jsonb) returns integer
language sql immutable as $$ select least(greatest(coalesce((p_args->>'limit')::integer, 50), 1), 200) $$;

create or replace function public.ai_offset(p_args jsonb) returns integer
language sql immutable as $$ select greatest(coalesce((p_args->>'offset')::integer, 0), 0) $$;

create or replace function public.ai_like(p text) returns text
language sql immutable as $$ select '%' || replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_') || '%' $$;

create or replace function public.ai_entry_json(e public.entries) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', e.id, 'date', e.date, 'stage', e.stage,
    'dish', (select jsonb_build_object('id', d.id, 'name', d.rom, 'thai', d.th, 'region', d.region)
               from dishes d where d.household_id = e.household_id and d.id = e.dish_id),
    'dish_free', e.dish_free,
    'place', (select jsonb_build_object('id', p.id, 'name', p.name, 'thai', p.th)
                from places p where p.household_id = e.household_id and p.id = e.place_id),
    'place_free', e.place_free,
    'rating_greg', e.rating_greg, 'rating_andra', e.rating_andra,
    'price_thb', e.price_thb, 'spice', e.spice, 'again', e.again, 'note', e.note,
    'has_photo', e.photo_path is not null,
    'author', e.author, 'source_client', e.source_client,
    'created_at', e.created_at, 'updated_at', e.updated_at)
$$;

create or replace function public.ai_audit(p_h uuid, p_actor text, p_client uuid, p_tool text, p_table text, p_id text, p_before jsonb, p_after jsonb)
returns void language sql set search_path = public as $$
  insert into audit_log (household_id, actor, client_id, tool, table_name, record_id, before, after)
  values (p_h, p_actor, p_client, p_tool, p_table, p_id, p_before, p_after)
$$;

create or replace function public.ai_locations_json(p_h uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'user', l.user_name, 'lat', l.lat, 'lng', l.lng, 'accuracy_m', l.accuracy, 'source', l.source,
    'recorded_at', l.recorded_at,
    'age_minutes', floor(extract(epoch from (now() - l.recorded_at)) / 60)::integer) order by l.user_name), '[]'::jsonb)
  from (select distinct on (user_name) * from locations where household_id = p_h order by user_name, recorded_at desc) l
$$;

-- ---------------------------------------------------------------- read tools
create or replace function public.ai_get_context(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'today', ai_today(),
    'timezone', 'Asia/Bangkok',
    'you_write_as', p_actor,
    'people', jsonb_build_array('greg', 'andra'),
    'current_stage', (select jsonb_build_object('key', s.key, 'name', s.name, 'region', s.region_key) from stages s where s.key = stage_for(ai_today())),
    'itinerary', (select jsonb_agg(jsonb_build_object('from', sp.start_date, 'stage', sp.stage_key, 'name', s.name, 'region', s.region_key) order by sp.start_date)
                    from stage_periods sp join stages s on s.key = sp.stage_key),
    'regions', (select jsonb_agg(jsonb_build_object('key', r.key, 'name', r.name, 'covers', r.sub) order by r.sort) from regions r),
    'counts', jsonb_build_object(
      'entries', (select count(*) from entries where household_id = p_h),
      'dishes', (select count(*) from dishes where household_id = p_h),
      'dishes_tried', (select count(distinct dish_id) from entries where household_id = p_h and dish_id is not null),
      'places', (select count(*) from places where household_id = p_h),
      'favourites', (select count(*) from favs where household_id = p_h),
      'new_suggestions', (select count(*) from suggestions where household_id = p_h and status = 'new')),
    'recent_entries', (select coalesce(jsonb_agg(ai_entry_json(e) order by e.date desc, e.created_at desc), '[]'::jsonb)
                         from (select * from entries where household_id = p_h order by date desc, created_at desc limit 5) e),
    'latest_locations', ai_locations_json(p_h))
$$;

create or replace function public.ai_search_entries(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare lim integer := ai_limit(p_args); off integer := ai_offset(p_args); q text := nullif(trim(p_args->>'query'), ''); res jsonb; total integer;
begin
  with hit as (
    select e.* from entries e
      left join dishes d on d.household_id = e.household_id and d.id = e.dish_id
      left join places p on p.household_id = e.household_id and p.id = e.place_id
     where e.household_id = p_h
       and (p_args->>'date_from' is null or e.date >= (p_args->>'date_from')::date)
       and (p_args->>'date_to' is null or e.date <= (p_args->>'date_to')::date)
       and (p_args->>'stage' is null or e.stage = p_args->>'stage')
       and (p_args->>'region' is null or d.region = p_args->>'region')
       and (p_args->>'dish_id' is null or e.dish_id = p_args->>'dish_id')
       and (p_args->>'place_id' is null or e.place_id = p_args->>'place_id')
       and (p_args->>'author' is null or e.author = p_args->>'author')
       and (p_args->>'min_rating' is null or greatest(e.rating_greg, e.rating_andra) >= (p_args->>'min_rating')::integer)
       and (p_args->>'max_rating' is null or least(e.rating_greg, e.rating_andra) <= (p_args->>'max_rating')::integer)
       and (p_args->>'min_spice' is null or e.spice >= (p_args->>'min_spice')::integer)
       and (p_args->>'max_spice' is null or e.spice <= (p_args->>'max_spice')::integer)
       and (p_args->>'again' is null or e.again = (p_args->>'again')::boolean)
       and (q is null or concat_ws(' ', d.rom, d.th, e.dish_free, p.name, p.th, e.place_free, e.note) ilike ai_like(q))
  )
  select (select count(*) from hit),
         (select coalesce(jsonb_agg(ai_entry_json(h) order by h.date desc, h.created_at desc), '[]'::jsonb)
            from (select * from hit order by date desc, created_at desc limit lim offset off) h)
    into total, res;
  return jsonb_build_object('total', total, 'entries', res, 'next_offset', case when off + lim < total then off + lim end);
end $$;

create or replace function public.ai_get_entry(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare e entries;
begin
  select * into e from entries where household_id = p_h and id = p_args->>'id';
  if not found then perform ai_fail('not_found', 'No entry with id ' || coalesce(p_args->>'id', '(missing)')); end if;
  return ai_entry_json(e);
end $$;

create or replace function public.ai_list_dishes(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare lim integer := ai_limit(p_args); off integer := ai_offset(p_args); q text := nullif(trim(p_args->>'query'), ''); res jsonb; total integer;
begin
  with hit as (
    select d.id, d.rom, d.th, d.d, d.region, d.builtin,
           exists (select 1 from favs f where f.household_id = p_h and f.dish_id = d.id) as fav,
           s.n, s.g, s.a, s.last
      from dishes d
      left join lateral (select count(*) as n, round(avg(rating_greg), 2) as g, round(avg(rating_andra), 2) as a, max(date) as last
                           from entries e where e.household_id = p_h and e.dish_id = d.id) s on true
     where d.household_id = p_h
       and (p_args->>'region' is null or d.region = p_args->>'region')
       and (q is null or concat_ws(' ', d.rom, d.th, d.d) ilike ai_like(q))
       and (p_args->>'tried' is null or (s.n > 0) = (p_args->>'tried')::boolean)
  ), f as (select * from hit where p_args->>'fav' is null or fav = (p_args->>'fav')::boolean)
  select (select count(*) from f),
         (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.rom, 'thai', x.th, 'description', x.d, 'region', x.region,
                   'from_catalogue', x.builtin, 'fav', x.fav, 'times_eaten', x.n, 'avg_rating_greg', x.g, 'avg_rating_andra', x.a, 'last_eaten', x.last)
                   order by x.region, x.rom), '[]'::jsonb)
            from (select * from f order by region, rom limit lim offset off) x)
    into total, res;
  return jsonb_build_object('total', total, 'dishes', res, 'next_offset', case when off + lim < total then off + lim end);
end $$;

create or replace function public.ai_list_places(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare lim integer := ai_limit(p_args); off integer := ai_offset(p_args); q text := nullif(trim(p_args->>'query'), ''); res jsonb; total integer;
  nlat double precision := (p_args->>'near_lat')::double precision; nlng double precision := (p_args->>'near_lng')::double precision;
begin
  if (nlat is null) <> (nlng is null) then perform ai_fail('invalid', 'near_lat and near_lng go together'); end if;
  with hit as (
    select p.*, (select count(*) from entries e where e.household_id = p_h and e.place_id = p.id) as n,
           case when nlat is not null and p.lat is not null then
             round((6371 * 2 * asin(sqrt(power(sin(radians(p.lat - nlat) / 2), 2)
               + cos(radians(nlat)) * cos(radians(p.lat)) * power(sin(radians(p.lng - nlng) / 2), 2))))::numeric, 2) end as km
      from places p
     where p.household_id = p_h
       and (p_args->>'stage' is null or p.stage = p_args->>'stage')
       and (q is null or concat_ws(' ', p.name, p.th, p.address, p.note) ilike ai_like(q))
  ), f as (select * from hit where nlat is null or (km is not null and km <= coalesce((p_args->>'radius_km')::numeric, 5)))
  select (select count(*) from f),
         (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'thai', x.th, 'address', x.address, 'stage', x.stage,
                   'lat', x.lat, 'lng', x.lng, 'note', x.note, 'from_catalogue', x.builtin, 'visits', x.n, 'distance_km', x.km)
                   order by x.km nulls last, x.stage, x.name), '[]'::jsonb)
            from (select * from f order by km nulls last, stage, name limit lim offset off) x)
    into total, res;
  return jsonb_build_object('total', total, 'places', res, 'next_offset', case when off + lim < total then off + lim end);
end $$;

create or replace function public.ai_get_stats(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'entries', (select count(*) from entries where household_id = p_h),
    'avg_rating_greg', (select round(avg(rating_greg), 2) from entries where household_id = p_h),
    'avg_rating_andra', (select round(avg(rating_andra), 2) from entries where household_id = p_h),
    'avg_spice', (select round(avg(spice), 1) from entries where household_id = p_h),
    'total_spend_thb', (select coalesce(sum(price_thb), 0) from entries where household_id = p_h),
    'by_stage', (select coalesce(jsonb_agg(jsonb_build_object('stage', s.key, 'name', s.name, 'entries', x.n, 'spend_thb', x.spend,
                          'avg_price_thb', x.avg_price, 'avg_rating_greg', x.g, 'avg_rating_andra', x.a) order by s.sort), '[]'::jsonb)
                   from stages s join (select stage, count(*) n, coalesce(sum(price_thb), 0) spend, round(avg(price_thb)) avg_price,
                                              round(avg(rating_greg), 2) g, round(avg(rating_andra), 2) a
                                         from entries where household_id = p_h group by stage) x on x.stage = s.key),
    'top_dishes', (select coalesce(jsonb_agg(to_jsonb(t) order by t.avg_rating desc, t.times_eaten desc), '[]'::jsonb)
                     from (select d.id, d.rom as name, d.th as thai, count(*) as times_eaten,
                                  round(avg((coalesce(e.rating_greg, e.rating_andra) + coalesce(e.rating_andra, e.rating_greg)) / 2.0), 2) as avg_rating
                             from entries e join dishes d on d.household_id = e.household_id and d.id = e.dish_id
                            where e.household_id = p_h and coalesce(e.rating_greg, e.rating_andra) is not null
                            group by d.id, d.rom, d.th order by 5 desc, 4 desc limit 10) t),
    'most_eaten', (select coalesce(jsonb_agg(to_jsonb(t) order by t.times_eaten desc), '[]'::jsonb)
                     from (select d.id, d.rom as name, count(*) as times_eaten
                             from entries e join dishes d on d.household_id = e.household_id and d.id = e.dish_id
                            where e.household_id = p_h group by d.id, d.rom order by 3 desc limit 10) t),
    'still_to_try', (select coalesce(jsonb_agg(jsonb_build_object('region', r.key, 'name', r.name, 'dishes', x.total, 'tried', x.tried,
                              'to_try', x.total - x.tried, 'examples', x.examples) order by r.sort), '[]'::jsonb)
                       from regions r join (
                         select d.region, count(*) total,
                                count(*) filter (where exists (select 1 from entries e where e.household_id = p_h and e.dish_id = d.id)) tried,
                                (array_agg(d.rom order by d.rom) filter (where not exists (select 1 from entries e where e.household_id = p_h and e.dish_id = d.id)))[1:8] examples
                           from dishes d where d.household_id = p_h group by d.region) x on x.region = r.key))
$$;

create or replace function public.ai_list_suggestions(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('suggestions', coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'author', s.author, 'kind', s.kind,
           'payload', s.payload, 'status', s.status, 'created_at', s.created_at, 'resolved_at', s.resolved_at) order by s.created_at desc), '[]'::jsonb))
    from (select * from suggestions where household_id = p_h and (p_args->>'status' is null or status = p_args->>'status')
           order by created_at desc limit ai_limit(p_args) offset ai_offset(p_args)) s
$$;

create or replace function public.ai_get_latest_location(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('locations', ai_locations_json(p_h),
    'note', 'Recorded only while the app is open on the phone. Check age_minutes before assuming someone is still there.')
$$;

-- ---------------------------------------------------------------- write tools
-- Resolves dish_id / dish_name and place_id / place_name from the arguments into the four entry columns.
create or replace function public.ai_entry_refs(p_h uuid, p_args jsonb, inout dish_id text, inout dish_free text, inout place_id text, inout place_free text)
language plpgsql stable set search_path = public as $$
begin
  if p_args ? 'dish_id' or p_args ? 'dish_name' then
    dish_id := nullif(p_args->>'dish_id', ''); dish_free := nullif(trim(p_args->>'dish_name'), '');
    if dish_id is not null then
      dish_free := null;
      if not exists (select 1 from dishes where household_id = p_h and id = dish_id) then
        perform ai_fail('not_found', 'No dish with id ' || dish_id || '. Use list_dishes to find it, or pass dish_name for free text.'); end if;
    end if;
  end if;
  if p_args ? 'place_id' or p_args ? 'place_name' then
    place_id := nullif(p_args->>'place_id', ''); place_free := nullif(trim(p_args->>'place_name'), '');
    if place_id is not null then
      place_free := null;
      if not exists (select 1 from places where household_id = p_h and id = place_id) then
        perform ai_fail('not_found', 'No place with id ' || place_id || '. Use list_places to find it, or pass place_name for free text.'); end if;
    end if;
  end if;
  if dish_id is null and dish_free is null then perform ai_fail('invalid', 'An entry needs dish_id or dish_name'); end if;
end $$;

create or replace function public.ai_add_entry(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare e entries; r record; d date := coalesce((p_args->>'date')::date, ai_today());
begin
  select * into r from ai_entry_refs(p_h, p_args, null, null, null, null);
  insert into entries (household_id, dish_id, dish_free, place_id, place_free, date, stage, price_thb, spice, again, note, author, source_client)
  values (p_h, r.dish_id, r.dish_free, r.place_id, r.place_free, d, stage_for(d), (p_args->>'price_thb')::integer,
          (p_args->>'spice')::smallint, (p_args->>'again')::boolean, nullif(trim(p_args->>'note'), ''), p_actor,
          (select name from ai_clients where id = p_client))
  returning * into e;
  perform ai_audit(p_h, p_actor, p_client, 'add_entry', 'entries', e.id, null, to_jsonb(e));
  return ai_entry_json(e);
end $$;

-- Optimistic concurrency: the caller sends the updated_at it last read. If the row has moved on, nothing is written
-- and the current record comes back, so the caller can merge and retry. The row lock makes the check race-free.
create or replace function public.ai_update_entry(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare old entries; e entries; r record; exp timestamptz := (p_args->>'expected_updated_at')::timestamptz;
begin
  select * into old from entries where household_id = p_h and id = p_args->>'id' for update;
  if not found then perform ai_fail('not_found', 'No entry with id ' || coalesce(p_args->>'id', '(missing)')); end if;
  if exp is null then perform ai_fail('invalid', 'expected_updated_at is required: send the updated_at you last read for this entry'); end if;
  if old.updated_at <> exp then
    return jsonb_build_object('conflict', true,
      'message', 'The entry changed since you read it. Nothing was written. Merge your change into "current" and retry with its updated_at.',
      'current', ai_entry_json(old));
  end if;
  select * into r from ai_entry_refs(p_h, p_args, old.dish_id, old.dish_free, old.place_id, old.place_free);
  update entries set
    dish_id = r.dish_id, dish_free = r.dish_free, place_id = r.place_id, place_free = r.place_free,
    date = case when p_args ? 'date' then (p_args->>'date')::date else date end,
    stage = case when p_args ? 'date' then stage_for((p_args->>'date')::date) else stage end,
    price_thb = case when p_args ? 'price_thb' then (p_args->>'price_thb')::integer else price_thb end,
    spice = case when p_args ? 'spice' then (p_args->>'spice')::smallint else spice end,
    again = case when p_args ? 'again' then (p_args->>'again')::boolean else again end,
    note = case when p_args ? 'note' then nullif(trim(p_args->>'note'), '') else note end
  where household_id = p_h and id = old.id returning * into e;
  perform ai_audit(p_h, p_actor, p_client, 'update_entry', 'entries', e.id, to_jsonb(old), to_jsonb(e));
  return ai_entry_json(e);
end $$;

create or replace function public.ai_rate_entry(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare old entries; e entries; who text := p_args->>'person'; val smallint := (p_args->>'rating')::smallint;
begin
  if who is null or who not in ('greg', 'andra') then perform ai_fail('invalid', 'person must be greg or andra'); end if;
  select * into old from entries where household_id = p_h and id = p_args->>'id' for update;
  if not found then perform ai_fail('not_found', 'No entry with id ' || coalesce(p_args->>'id', '(missing)')); end if;
  if p_args->>'expected_updated_at' is not null and old.updated_at <> (p_args->>'expected_updated_at')::timestamptz then
    return jsonb_build_object('conflict', true,
      'message', 'The entry changed since you read it. Nothing was written. Check "current" and retry with its updated_at.',
      'current', ai_entry_json(old));
  end if;
  update entries set rating_greg = case when who = 'greg' then val else rating_greg end,
                     rating_andra = case when who = 'andra' then val else rating_andra end
   where household_id = p_h and id = old.id returning * into e;
  perform ai_audit(p_h, p_actor, p_client, 'rate_entry', 'entries', e.id, to_jsonb(old), to_jsonb(e));
  return ai_entry_json(e);
end $$;

create or replace function public.ai_add_dish(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare d dishes; nm text := nullif(trim(p_args->>'name'), '');
begin
  if nm is null then perform ai_fail('invalid', 'name is required'); end if;
  if not exists (select 1 from regions where key = p_args->>'region') then
    perform ai_fail('invalid', 'region must be one of: ' || (select string_agg(key, ', ' order by sort) from regions)); end if;
  select * into d from dishes where household_id = p_h and lower(rom) = lower(nm) limit 1;
  if found then
    return jsonb_build_object('already_existed', true, 'id', d.id, 'name', d.rom, 'thai', d.th, 'description', d.d, 'region', d.region);
  end if;
  insert into dishes (household_id, rom, th, d, region) values (p_h, nm, nullif(trim(p_args->>'thai'), ''), nullif(trim(p_args->>'description'), ''), p_args->>'region')
    returning * into d;
  perform ai_audit(p_h, p_actor, p_client, 'add_dish', 'dishes', d.id, null, to_jsonb(d));
  return jsonb_build_object('already_existed', false, 'id', d.id, 'name', d.rom, 'thai', d.th, 'description', d.d, 'region', d.region);
end $$;

create or replace function public.ai_add_place(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare p places; nm text := nullif(trim(p_args->>'name'), ''); st text := coalesce(p_args->>'stage', stage_for(ai_today()));
begin
  if nm is null then perform ai_fail('invalid', 'name is required'); end if;
  if not exists (select 1 from stages where key = st) then
    perform ai_fail('invalid', 'stage must be one of: ' || (select string_agg(key, ', ' order by sort) from stages)); end if;
  if (p_args->>'lat' is null) <> (p_args->>'lng' is null) then perform ai_fail('invalid', 'lat and lng go together'); end if;
  select * into p from places where household_id = p_h and lower(name) = lower(nm) and stage = st limit 1;
  if not found then
    insert into places (household_id, name, th, address, stage, lat, lng, note)
    values (p_h, nm, nullif(trim(p_args->>'thai'), ''), nullif(trim(p_args->>'address'), ''), st,
            (p_args->>'lat')::double precision, (p_args->>'lng')::double precision, nullif(trim(p_args->>'note'), ''))
    returning * into p;
    perform ai_audit(p_h, p_actor, p_client, 'add_place', 'places', p.id, null, to_jsonb(p));
    return jsonb_build_object('already_existed', false, 'id', p.id, 'name', p.name, 'thai', p.th, 'address', p.address, 'stage', p.stage, 'lat', p.lat, 'lng', p.lng, 'note', p.note);
  end if;
  return jsonb_build_object('already_existed', true, 'id', p.id, 'name', p.name, 'thai', p.th, 'address', p.address, 'stage', p.stage, 'lat', p.lat, 'lng', p.lng, 'note', p.note);
end $$;

create or replace function public.ai_toggle_fav(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare did text := p_args->>'dish_id'; was boolean; want boolean;
begin
  if not exists (select 1 from dishes where household_id = p_h and id = did) then
    perform ai_fail('not_found', 'No dish with id ' || coalesce(did, '(missing)')); end if;
  was := exists (select 1 from favs where household_id = p_h and dish_id = did);
  want := coalesce((p_args->>'fav')::boolean, not was);
  if want and not was then insert into favs (household_id, dish_id) values (p_h, did) on conflict do nothing;
  elsif was and not want then delete from favs where household_id = p_h and dish_id = did; end if;
  if want <> was then
    perform ai_audit(p_h, p_actor, p_client, 'toggle_fav', 'favs', did, jsonb_build_object('fav', was), jsonb_build_object('fav', want));
  end if;
  return jsonb_build_object('dish_id', did, 'fav', want);
end $$;

create or replace function public.ai_add_suggestion(p_h uuid, p_actor text, p_client uuid, p_args jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare s suggestions; k text := p_args->>'kind'; pl jsonb := p_args->'payload'; clean jsonb;
begin
  if pl is null or jsonb_typeof(pl) <> 'object' then perform ai_fail('invalid', 'payload must be an object'); end if;
  if k = 'dish' then
    if nullif(trim(pl->>'rom'), '') is null then perform ai_fail('invalid', 'A dish suggestion needs payload.rom (the romanised name)'); end if;
    if not exists (select 1 from regions where key = pl->>'region') then
      perform ai_fail('invalid', 'payload.region must be one of: ' || (select string_agg(key, ', ' order by sort) from regions)); end if;
    clean := jsonb_strip_nulls(jsonb_build_object('rom', trim(pl->>'rom'), 'th', pl->>'th', 'd', pl->>'d', 'region', pl->>'region', 'reason', pl->>'reason'));
  elsif k = 'place' then
    if nullif(trim(pl->>'name'), '') is null then perform ai_fail('invalid', 'A place suggestion needs payload.name'); end if;
    if not exists (select 1 from stages where key = pl->>'stage') then
      perform ai_fail('invalid', 'payload.stage must be one of: ' || (select string_agg(key, ', ' order by sort) from stages)); end if;
    if (pl->>'lat' is null) <> (pl->>'lng' is null) then perform ai_fail('invalid', 'payload.lat and payload.lng go together'); end if;
    clean := jsonb_strip_nulls(jsonb_build_object('name', trim(pl->>'name'), 'th', pl->>'th', 'address', pl->>'address', 'stage', pl->>'stage',
      'lat', (pl->>'lat')::double precision, 'lng', (pl->>'lng')::double precision, 'note', pl->>'note', 'reason', pl->>'reason'));
  elsif k = 'note' then
    if nullif(trim(pl->>'text'), '') is null then perform ai_fail('invalid', 'A note suggestion needs payload.text'); end if;
    clean := jsonb_strip_nulls(jsonb_build_object('text', trim(pl->>'text'), 'dish_id', pl->>'dish_id', 'place_id', pl->>'place_id', 'entry_id', pl->>'entry_id'));
  else
    perform ai_fail('invalid', 'kind must be dish, place or note');
  end if;
  insert into suggestions (household_id, author, kind, payload) values (p_h, p_actor, k, clean) returning * into s;
  perform ai_audit(p_h, p_actor, p_client, 'add_suggestion', 'suggestions', s.id::text, null, to_jsonb(s));
  return jsonb_build_object('id', s.id, 'kind', s.kind, 'payload', s.payload, 'status', s.status,
    'message', 'Saved to the inbox in the app. Nothing changes in the journal until Greg or Andra accepts it.');
end $$;

-- ---------------------------------------------------------------- gate and dispatcher
-- Limits per client: 60 calls a minute, of which 20 writes.
create or replace function public.ai_authenticate(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c ai_clients;
begin
  select * into c from ai_clients where token_hash = p_token_hash and revoked_at is null and (expires_at is null or expires_at > now());
  if not found then return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'unauthorized', 'message', 'Unknown, expired or revoked token')); end if;
  if not rate_limit_hit('c:' || c.id, 60, 60) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'rate_limited', 'message', 'Too many requests. Wait a minute and try again.'));
  end if;
  if c.last_used_at is null or c.last_used_at < now() - interval '1 minute' then
    update ai_clients set last_used_at = now() where id = c.id;
  end if;
  return jsonb_build_object('ok', true, 'client', jsonb_build_object('id', c.id, 'household_id', c.household_id, 'author', c.author, 'name', c.name));
end $$;

create or replace function public.ai_call(p_token_hash text, p_tool text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb := ai_authenticate(p_token_hash); h uuid; actor text; cid uuid; res jsonb; args jsonb := coalesce(p_args, '{}'::jsonb);
  code text; msg text; hint text; is_write boolean;
begin
  if not (a->>'ok')::boolean then return a; end if;
  h := (a#>>'{client,household_id}')::uuid; actor := a#>>'{client,author}'; cid := (a#>>'{client,id}')::uuid;
  is_write := p_tool in ('add_entry', 'update_entry', 'rate_entry', 'add_dish', 'add_place', 'toggle_fav', 'add_suggestion');
  if is_write and not rate_limit_hit('w:' || cid, 20, 60) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'rate_limited', 'message', 'Too many writes. Wait a minute and try again.'));
  end if;
  begin
    case p_tool
      when 'get_context' then res := ai_get_context(h, actor, cid, args);
      when 'search_entries' then res := ai_search_entries(h, actor, cid, args);
      when 'get_entry' then res := ai_get_entry(h, actor, cid, args);
      when 'list_dishes' then res := ai_list_dishes(h, actor, cid, args);
      when 'list_places' then res := ai_list_places(h, actor, cid, args);
      when 'get_stats' then res := ai_get_stats(h, actor, cid, args);
      when 'list_suggestions' then res := ai_list_suggestions(h, actor, cid, args);
      when 'get_latest_location' then res := ai_get_latest_location(h, actor, cid, args);
      when 'add_entry' then res := ai_add_entry(h, actor, cid, args);
      when 'update_entry' then res := ai_update_entry(h, actor, cid, args);
      when 'rate_entry' then res := ai_rate_entry(h, actor, cid, args);
      when 'add_dish' then res := ai_add_dish(h, actor, cid, args);
      when 'add_place' then res := ai_add_place(h, actor, cid, args);
      when 'toggle_fav' then res := ai_toggle_fav(h, actor, cid, args);
      when 'add_suggestion' then res := ai_add_suggestion(h, actor, cid, args);
      else return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'not_found', 'message', 'Unknown tool ' || coalesce(p_tool, '')));
    end case;
  exception
    when sqlstate 'TT000' then
      get stacked diagnostics msg = message_text, hint = pg_exception_hint;
      return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', hint, 'message', msg));
    when check_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow
      or numeric_value_out_of_range or foreign_key_violation or not_null_violation or string_data_right_truncation then
      get stacked diagnostics msg = message_text;
      return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid', 'message', 'Invalid value: ' || msg));
  end;
  return jsonb_build_object('ok', true, 'result', res, 'client', a->'client');
end $$;

-- ---------------------------------------------------------------- OAuth (called by the Edge Function)
create or replace function public.oauth_register(p_name text, p_redirect_uris text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c oauth_clients; u text;
begin
  if p_redirect_uris is null or cardinality(p_redirect_uris) not between 1 and 10 then
    return jsonb_build_object('error', 'invalid_redirect_uri', 'error_description', 'Send 1 to 10 redirect_uris'); end if;
  foreach u in array p_redirect_uris loop
    if u !~ '^https://[^/?#]+' and u !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)' or length(u) > 500 then
      return jsonb_build_object('error', 'invalid_redirect_uri', 'error_description', 'redirect_uris must be https, or http on localhost'); end if;
  end loop;
  -- Registration is open by design (the MCP spec expects it), so keep the table from growing without bound.
  delete from oauth_clients o where o.created_at < now() - interval '30 days'
     and not exists (select 1 from ai_clients a where a.oauth_client_id = o.client_id and a.revoked_at is null);
  insert into oauth_clients (client_name, redirect_uris) values (left(coalesce(nullif(trim(p_name), ''), 'Unnamed client'), 80), p_redirect_uris) returning * into c;
  return jsonb_build_object('client_id', c.client_id, 'client_name', c.client_name, 'redirect_uris', to_jsonb(c.redirect_uris),
    'client_id_issued_at', floor(extract(epoch from c.created_at))::bigint);
end $$;

-- Loopback redirect URIs match on any port (RFC 8252); everything else must match exactly.
create or replace function public.oauth_redirect_ok(p_registered text[], p_uri text) returns boolean
language sql immutable as $$
  select p_uri = any (p_registered)
      or (p_uri ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)'
          and regexp_replace(p_uri, '^(http://[^/:]+)(:[0-9]+)?', '\1') in
              (select regexp_replace(r, '^(http://[^/:]+)(:[0-9]+)?', '\1') from unnest(p_registered) r))
$$;

create or replace function public.oauth_begin(p_client_id text, p_redirect_uri text, p_state text, p_code_challenge text, p_resource text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c oauth_clients; rid uuid;
begin
  select * into c from oauth_clients where client_id = p_client_id;
  if not found then return jsonb_build_object('error', 'invalid_client'); end if;
  if p_redirect_uri is null or not oauth_redirect_ok(c.redirect_uris, p_redirect_uri) then return jsonb_build_object('error', 'invalid_redirect_uri'); end if;
  if p_code_challenge is null or p_code_challenge !~ '^[A-Za-z0-9_-]{43}$' then return jsonb_build_object('error', 'invalid_request', 'redirect', true); end if;
  delete from oauth_requests where expires_at < now() - interval '1 day';
  insert into oauth_requests (client_id, redirect_uri, state, code_challenge, resource)
    values (c.client_id, p_redirect_uri, left(p_state, 1000), p_code_challenge, left(p_resource, 500)) returning id into rid;
  return jsonb_build_object('request_id', rid);
end $$;

-- Authorization-code grant. The code is single use: presenting it twice revokes the token it produced.
create or replace function public.oauth_exchange(p_code_hash text, p_client_id text, p_redirect_uri text, p_code_challenge text,
  p_token_hash text, p_token_prefix text, p_refresh_hash text, p_ttl_seconds integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r oauth_requests; cid uuid; nm text;
begin
  select * into r from oauth_requests where code_hash = p_code_hash for update;
  if not found then return jsonb_build_object('error', 'invalid_grant'); end if;
  if r.used_at is not null then
    update ai_clients set revoked_at = now() where id = r.ai_client_id and revoked_at is null;
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  if r.expires_at < now() or r.denied or r.household_id is null or r.client_id <> p_client_id
     or r.redirect_uri <> p_redirect_uri or r.code_challenge <> p_code_challenge then
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  select client_name into nm from oauth_clients where client_id = r.client_id;
  insert into ai_clients (household_id, name, author, token_hash, token_prefix, refresh_hash, expires_at, oauth_client_id)
    values (r.household_id, left(nm, 60) || ' (approved by ' || r.approved_by || ')', r.author, p_token_hash, p_token_prefix, p_refresh_hash,
            now() + make_interval(secs => p_ttl_seconds), r.client_id)
    returning id into cid;
  update oauth_requests set used_at = now(), ai_client_id = cid where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.oauth_refresh(p_refresh_hash text, p_client_id text, p_token_hash text, p_token_prefix text,
  p_new_refresh_hash text, p_ttl_seconds integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update ai_clients set token_hash = p_token_hash, token_prefix = p_token_prefix, refresh_hash = p_new_refresh_hash,
         expires_at = now() + make_interval(secs => p_ttl_seconds)
   where refresh_hash = p_refresh_hash and oauth_client_id = p_client_id and revoked_at is null;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('error', 'invalid_grant'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- consent (called by signed-in members from the app)
create or replace function public.oauth_request_info(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r oauth_requests; nm text;
begin
  if not exists (select 1 from household_members where user_id = auth.uid()) then raise exception 'not a household member' using errcode = '42501'; end if;
  select * into r from oauth_requests where id = p_id and expires_at > now() and code_hash is null and not denied;
  if not found then return null; end if;
  select client_name into nm from oauth_clients where client_id = r.client_id;
  return jsonb_build_object('client_name', nm, 'redirect_uri', r.redirect_uri);
end $$;

-- Approve: binds the request to the member's household and returns the one-time code for the redirect.
create or replace function public.approve_oauth_request(p_id uuid, p_author text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m household_members; r oauth_requests; code text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  select * into m from household_members where user_id = auth.uid();
  if not found then raise exception 'not a household member' using errcode = '42501'; end if;
  if p_author not in ('claude', 'chatgpt') then raise exception 'author must be claude or chatgpt'; end if;
  update oauth_requests set household_id = m.household_id, approved_by = m.name, author = p_author,
         code_hash = encode(extensions.digest(code, 'sha256'), 'hex'), expires_at = now() + interval '2 minutes'
   where id = p_id and expires_at > now() and code_hash is null and not denied
   returning * into r;
  if not found then raise exception 'This request has expired or was already answered' using errcode = 'P0002'; end if;
  return jsonb_build_object('redirect_uri', r.redirect_uri, 'code', code, 'state', r.state);
end $$;

create or replace function public.deny_oauth_request(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r oauth_requests;
begin
  if not exists (select 1 from household_members where user_id = auth.uid()) then raise exception 'not a household member' using errcode = '42501'; end if;
  update oauth_requests set denied = true where id = p_id and expires_at > now() and code_hash is null and not denied returning * into r;
  if not found then raise exception 'This request has expired or was already answered' using errcode = 'P0002'; end if;
  return jsonb_build_object('redirect_uri', r.redirect_uri, 'state', r.state);
end $$;

-- ---------------------------------------------------------------- privileges
-- Postgres grants EXECUTE to PUBLIC by default. Take it away from everything in this file, then grant narrowly.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'ai\_%' or p.proname like 'oauth\_%' or p.proname in ('approve_oauth_request', 'deny_oauth_request'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
grant execute on function public.oauth_request_info(uuid), public.approve_oauth_request(uuid, text), public.deny_oauth_request(uuid) to authenticated;

-- Members see when an OAuth token expires in Settings (never the hashes).
grant select (expires_at, oauth_client_id) on public.ai_clients to authenticated;

-- A rotated static token must not keep an OAuth refresh token alive.
create or replace function public.rotate_ai_client(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare t text; n integer;
begin
  t := 'tt_' || encode(extensions.gen_random_bytes(32), 'hex');
  update public.ai_clients c set token_hash = encode(extensions.digest(t, 'sha256'), 'hex'), token_prefix = left(t, 9),
         revoked_at = null, last_used_at = null, expires_at = null, refresh_hash = null, oauth_client_id = null
   where c.id = p_id and public.is_member(c.household_id);
  get diagnostics n = row_count;
  if n = 0 then raise exception 'no such client' using errcode = '42501'; end if;
  return t;
end $$;

-- The Edge Function also rate-limits its open OAuth routes by caller address.
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
