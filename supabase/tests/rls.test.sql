-- Assertions run against the stubbed local database. Any failed assertion raises and aborts the run.
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED: %', msg; end if; end $$;

\set ON_ERROR_STOP on
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'greg@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'andra@example.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'stranger@example.test');
insert into public.households (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'home'), ('22222222-2222-2222-2222-222222222222', 'other');
insert into public.household_members values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a1', 'greg', now()),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a2', 'andra', now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-0000000000b1', 'greg', now());
insert into public.dishes (household_id, id, rom, region, builtin) values
  ('11111111-1111-1111-1111-111111111111', 'n1', 'khao soi', 'nord', true),
  ('22222222-2222-2222-2222-222222222222', 'n1', 'secret dish', 'nord', false);
insert into public.entries (household_id, id, dish_id, date, stage, author) values
  ('11111111-1111-1111-1111-111111111111', 'e1', 'n1', '2026-11-03', 'bkk', 'greg'),
  ('22222222-2222-2222-2222-222222222222', 'x1', 'n1', '2026-11-03', 'bkk', 'greg');

select pg_temp.ok(public.stage_for('2026-10-01') = 'bkk', 'stage before trip');
select pg_temp.ok(public.stage_for('2026-11-08') = 'cnx', 'stage cnx');
select pg_temp.ok(public.stage_for('2027-04-02') = 'bkk', 'stage second bkk');
select pg_temp.ok(length(public.new_id()) = 20, 'new_id length');

-- anon: nothing at all
set role anon;
do $$ begin
  begin perform 1 from public.entries; raise exception 'FAILED: anon read entries'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.ai_clients; raise exception 'FAILED: anon read ai_clients'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.regions; raise exception 'FAILED: anon read regions'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- authenticated stranger (other household): sees only their own
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select count(*) from public.entries) = 1, 'stranger sees exactly own entry');
select pg_temp.ok((select count(*) from public.entries where household_id = '11111111-1111-1111-1111-111111111111') = 0, 'stranger cannot see home entries');
do $$ begin
  begin insert into public.entries (household_id, dish_free, date, stage, author) values ('11111111-1111-1111-1111-111111111111', 'x', '2026-11-03', 'bkk', 'greg');
    raise exception 'FAILED: cross-household insert'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- greg
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.ok((select count(*) from public.entries) = 1, 'greg sees home entries only');
insert into public.entries (household_id, dish_id, date, stage, author) values ('11111111-1111-1111-1111-111111111111', 'n1', '2026-11-04', 'bkk', 'greg');
do $$ begin
  begin insert into public.entries (household_id, dish_free, date, stage, author) values ('11111111-1111-1111-1111-111111111111', 'x', '2026-11-03', 'bkk', 'claude');
    raise exception 'FAILED: greg posed as claude'; exception when insufficient_privilege then null; end;
  begin insert into public.entries (household_id, dish_free, date, stage, author) values ('11111111-1111-1111-1111-111111111111', 'x', '2026-11-03', 'bkk', 'andra');
    raise exception 'FAILED: greg posed as andra'; exception when insufficient_privilege then null; end;
  begin insert into public.dishes (household_id, rom, region, builtin) values ('11111111-1111-1111-1111-111111111111', 'x', 'nord', true);
    raise exception 'FAILED: inserted builtin dish'; exception when insufficient_privilege then null; end;
end $$;
-- builtin dish is not deletable; deleting it deletes 0 rows silently under RLS
delete from public.dishes where id = 'n1';
select pg_temp.ok((select count(*) from public.dishes where id = 'n1') = 1, 'builtin dish survives delete');
-- rating constraint
do $$ begin
  begin update public.entries set rating_greg = 6 where id = 'e1'; raise exception 'FAILED: rating 6 accepted'; exception when check_violation then null; end;
end $$;
-- updated_at bumps, strictly increasing, author cannot be rewritten by a signed-in user
create temp table t0 as select updated_at from public.entries where id = 'e1';
update public.entries set rating_greg = 4, author = 'claude' where id = 'e1';
select pg_temp.ok((select updated_at from public.entries where id = 'e1') > (select updated_at from t0), 'updated_at bumped');
select pg_temp.ok((select author from public.entries where id = 'e1') = 'greg', 'author immutable for app users');
-- optimistic concurrency pattern: stale token updates 0 rows
do $$ declare n int; begin
  update public.entries set note = 'stale' where id = 'e1' and updated_at = (select updated_at from t0);
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: stale update succeeded'; end if;
end $$;
-- locations: own only, pwa only
insert into public.locations (household_id, user_name, lat, lng, source) values ('11111111-1111-1111-1111-111111111111', 'greg', 18.78, 98.99, 'pwa');
do $$ begin
  begin insert into public.locations (household_id, user_name, lat, lng, source) values ('11111111-1111-1111-1111-111111111111', 'andra', 18.78, 98.99, 'pwa');
    raise exception 'FAILED: greg wrote andra location'; exception when insufficient_privilege then null; end;
  begin insert into public.locations (household_id, user_name, lat, lng, source) values ('11111111-1111-1111-1111-111111111111', 'greg', 18.78, 98.99, 'owntracks');
    raise exception 'FAILED: app wrote owntracks location'; exception when insufficient_privilege then null; end;
end $$;
-- audit and suggestions cannot be written by users
do $$ begin
  begin insert into public.audit_log (household_id, actor, tool) values ('11111111-1111-1111-1111-111111111111', 'greg', 'x'); raise exception 'FAILED: audit insert'; exception when insufficient_privilege then null; end;
  begin insert into public.suggestions (household_id, author, kind, payload) values ('11111111-1111-1111-1111-111111111111', 'claude', 'note', '{}'); raise exception 'FAILED: suggestion insert'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.rate_limits; raise exception 'FAILED: rate_limits readable'; exception when insufficient_privilege then null; end;
  begin perform token_hash from public.ai_clients; raise exception 'FAILED: token_hash readable'; exception when insufficient_privilege then null; end;
  begin insert into public.household_members values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000b1', 'andra', now()); raise exception 'FAILED: self-join household'; exception when insufficient_privilege then null; end;
end $$;
-- token lifecycle
create temp table tok as select * from public.create_ai_client('Claude connector', 'claude');
grant select on tok to authenticated;
select pg_temp.ok((select token from tok) like 'tt_%' and length((select token from tok)) = 67, 'token shape');
select pg_temp.ok((select count(*) from public.ai_clients) = 1, 'client listed');
select pg_temp.ok(not exists (select 1 from public.ai_clients where token_prefix = (select token from tok)), 'prefix is not the whole token');
reset role;
select pg_temp.ok((select token_hash from public.ai_clients) = encode(extensions.digest((select token from tok), 'sha256'), 'hex'), 'only hash stored');
select pg_temp.ok((select token_hash from public.ai_clients) <> (select token from tok), 'plaintext not stored');
-- other household cannot rotate or revoke it
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select count(*) from public.ai_clients) = 0, 'stranger sees no clients');
do $$ begin
  begin perform public.rotate_ai_client((select id from public.ai_clients limit 1)); raise exception 'FAILED: stranger rotated a token';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin perform public.revoke_ai_client('00000000-0000-0000-0000-000000000000'); raise exception 'FAILED: revoke of unknown';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.revoke_ai_client((select id from public.ai_clients limit 1));
reset role;
select pg_temp.ok((select revoked_at is not null from public.ai_clients), 'revoked');
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
create temp table tok2 as select public.rotate_ai_client((select id from public.ai_clients limit 1)) as token;
reset role;
select pg_temp.ok((select revoked_at is null from public.ai_clients), 'rotate re-activates');
select pg_temp.ok((select token_hash from public.ai_clients) = encode(extensions.digest((select token from tok2), 'sha256'), 'hex'), 'rotated hash');

-- rate limiter (service side)
select pg_temp.ok(public.rate_limit_hit('k', 2, 60), 'hit 1');
select pg_temp.ok(public.rate_limit_hit('k', 2, 60), 'hit 2');
select pg_temp.ok(not public.rate_limit_hit('k', 2, 60), 'hit 3 blocked');

-- location purge honours retention
insert into public.locations (household_id, user_name, lat, lng, source, recorded_at) values
  ('11111111-1111-1111-1111-111111111111', 'greg', 1, 1, 'pwa', now() - interval '31 days');
select pg_temp.ok(public.purge_old_locations() = 1, 'purged exactly the old point');
select pg_temp.ok((select count(*) from public.latest_locations) = 1, 'latest view');
-- storage policy
insert into storage.objects (bucket_id, name) values ('photos', '11111111-1111-1111-1111-111111111111/a.jpg'), ('photos', '22222222-2222-2222-2222-222222222222/b.jpg');
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.ok((select count(*) from storage.objects) = 1, 'storage scoped to household folder');
reset role;
set role anon;
select pg_temp.ok((select count(*) from storage.objects) = 0, 'anon sees no objects');
reset role;
