-- Row Level Security. Default is deny: anon gets nothing, signed-in users get only their own household.
-- The Edge Functions use the service role (which bypasses RLS) and enforce household scoping in code from the token row.

create or replace function public.is_member(hid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.household_members m where m.household_id = hid and m.user_id = auth.uid())
$$;

create or replace function public.member_name(hid uuid) returns text
language sql stable security definer set search_path = public as $$
  select m.name from public.household_members m where m.household_id = hid and m.user_id = auth.uid()
$$;

revoke all on function public.is_member(uuid), public.member_name(uuid) from public, anon;
grant execute on function public.is_member(uuid), public.member_name(uuid) to authenticated;

-- Supabase grants new tables to anon/authenticated by default. Start from nothing, then grant narrowly.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.regions enable row level security;
alter table public.stages enable row level security;
alter table public.stage_periods enable row level security;
alter table public.dishes enable row level security;
alter table public.places enable row level security;
alter table public.entries enable row level security;
alter table public.favs enable row level security;
alter table public.locations enable row level security;
alter table public.suggestions enable row level security;
alter table public.audit_log enable row level security;
alter table public.ai_clients enable row level security;
alter table public.rate_limits enable row level security;

-- reference data: readable by any signed-in user
grant select on public.regions, public.stages, public.stage_periods to authenticated;
create policy ref_read on public.regions for select to authenticated using (true);
create policy ref_read on public.stages for select to authenticated using (true);
create policy ref_read on public.stage_periods for select to authenticated using (true);

-- households: members read; members may change the retention setting only
grant select on public.households to authenticated;
grant update (location_retention_days) on public.households to authenticated;
create policy hh_read on public.households for select to authenticated using (public.is_member(id));
create policy hh_update on public.households for update to authenticated
  using (public.is_member(id)) with check (public.is_member(id));

grant select on public.household_members to authenticated;
create policy hm_read on public.household_members for select to authenticated using (public.is_member(household_id));

-- dishes / places: members read all, write only their own custom rows (builtin rows are read-only)
grant select, insert, update, delete on public.dishes, public.places to authenticated;
create policy dishes_read on public.dishes for select to authenticated using (public.is_member(household_id));
create policy dishes_ins on public.dishes for insert to authenticated with check (public.is_member(household_id) and not builtin);
create policy dishes_upd on public.dishes for update to authenticated
  using (public.is_member(household_id) and not builtin) with check (public.is_member(household_id) and not builtin);
create policy dishes_del on public.dishes for delete to authenticated using (public.is_member(household_id) and not builtin);

create policy places_read on public.places for select to authenticated using (public.is_member(household_id));
create policy places_ins on public.places for insert to authenticated with check (public.is_member(household_id) and not builtin);
create policy places_upd on public.places for update to authenticated
  using (public.is_member(household_id) and not builtin) with check (public.is_member(household_id) and not builtin);
create policy places_del on public.places for delete to authenticated using (public.is_member(household_id) and not builtin);

-- entries: a signed-in user can only create entries as themselves (cannot pose as claude/chatgpt)
grant select, insert, update, delete on public.entries to authenticated;
create policy entries_read on public.entries for select to authenticated using (public.is_member(household_id));
create policy entries_ins on public.entries for insert to authenticated
  with check (public.is_member(household_id) and author = public.member_name(household_id));
create policy entries_upd on public.entries for update to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy entries_del on public.entries for delete to authenticated using (public.is_member(household_id));

grant select, insert, delete on public.favs to authenticated;
create policy favs_read on public.favs for select to authenticated using (public.is_member(household_id));
create policy favs_ins on public.favs for insert to authenticated with check (public.is_member(household_id));
create policy favs_del on public.favs for delete to authenticated using (public.is_member(household_id));

-- locations: members read the household's; a user can only insert their own point, from the PWA
grant select, insert on public.locations to authenticated;
create policy loc_read on public.locations for select to authenticated using (public.is_member(household_id));
create policy loc_ins on public.locations for insert to authenticated
  with check (public.is_member(household_id) and user_name = public.member_name(household_id) and source = 'pwa');
grant select on public.latest_locations to authenticated;

-- suggestions: members read and resolve. Only the AI layer (service role) creates them.
grant select on public.suggestions to authenticated;
grant update (status, resolved_at) on public.suggestions to authenticated;
create policy sug_read on public.suggestions for select to authenticated using (public.is_member(household_id));
create policy sug_upd on public.suggestions for update to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

-- audit log: read only
grant select on public.audit_log to authenticated;
create policy audit_read on public.audit_log for select to authenticated using (public.is_member(household_id));

-- AI clients: members may list them WITHOUT the hash column. Create / rotate / revoke go through the functions below.
grant select (id, household_id, name, author, token_prefix, created_at, last_used_at, revoked_at) on public.ai_clients to authenticated;
create policy aic_read on public.ai_clients for select to authenticated using (public.is_member(household_id));

-- rate_limits: RLS on, no policy, no grant: only the service role can touch it.

-- Token management. The plaintext token is returned once and only its sha256 is stored.
create or replace function public.create_ai_client(p_name text, p_author text)
returns table (id uuid, token text) language plpgsql security definer set search_path = public as $$
declare hid uuid; t text; cid uuid;
begin
  select m.household_id into hid from public.household_members m where m.user_id = auth.uid();
  if hid is null then raise exception 'not a household member' using errcode = '42501'; end if;
  if p_author not in ('claude', 'chatgpt') then raise exception 'author must be claude or chatgpt'; end if;
  t := 'tt_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.ai_clients (household_id, name, author, token_hash, token_prefix)
    values (hid, p_name, p_author, encode(extensions.digest(t, 'sha256'), 'hex'), left(t, 9))
    returning ai_clients.id into cid;
  return query select cid, t;
end $$;

create or replace function public.rotate_ai_client(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare t text; n integer;
begin
  t := 'tt_' || encode(extensions.gen_random_bytes(32), 'hex');
  update public.ai_clients c set token_hash = encode(extensions.digest(t, 'sha256'), 'hex'), token_prefix = left(t, 9),
         revoked_at = null, last_used_at = null
   where c.id = p_id and public.is_member(c.household_id);
  get diagnostics n = row_count;
  if n = 0 then raise exception 'no such client' using errcode = '42501'; end if;
  return t;
end $$;

create or replace function public.revoke_ai_client(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.ai_clients c set revoked_at = now() where c.id = p_id and public.is_member(c.household_id);
  if not found then raise exception 'no such client' using errcode = '42501'; end if;
end $$;

revoke all on function public.create_ai_client(text, text), public.rotate_ai_client(uuid), public.revoke_ai_client(uuid) from public, anon;
grant execute on function public.create_ai_client(text, text), public.rotate_ai_client(uuid), public.revoke_ai_client(uuid) to authenticated;
