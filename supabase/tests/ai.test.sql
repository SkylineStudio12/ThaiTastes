-- AI layer assertions. Runs after rls.test.sql in the same database: reuses its households and users, resets the rows.
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED: %', msg; end if; end $$;
create or replace function pg_temp.h(t text) returns text language sql as $$ select encode(extensions.digest(t, 'sha256'), 'hex') $$;
\set ON_ERROR_STOP on
-- On Supabase the service role has every table grant by default; the local stub does not.
grant all on all tables in schema public to service_role;
grant usage on all sequences in schema public to service_role;
\set home '11111111-1111-1111-1111-111111111111'
\set other '22222222-2222-2222-2222-222222222222'

delete from public.entries; delete from public.favs; delete from public.locations; delete from public.places;
delete from public.suggestions; delete from public.audit_log; delete from public.dishes; delete from public.ai_clients;
insert into public.dishes (household_id, id, rom, region, builtin) values (:'home', 'n1', 'khao soi', 'nord', true), (:'other', 'n1', 'secret dish', 'nord', false);
insert into public.entries (household_id, id, dish_id, date, stage, author) values (:'home', 'e1', 'n1', '2026-11-03', 'bkk', 'greg'), (:'other', 'x1', 'n1', '2026-11-03', 'bkk', 'greg');
insert into public.ai_clients (id, household_id, name, author, token_hash, token_prefix) values
  ('aaaaaaaa-0000-0000-0000-000000000001', :'home', 'Claude test', 'claude', pg_temp.h('tok-claude'), 'tt_claude'),
  ('aaaaaaaa-0000-0000-0000-000000000002', :'home', 'ChatGPT test', 'chatgpt', pg_temp.h('tok-gpt'), 'tt_gpt'),
  ('aaaaaaaa-0000-0000-0000-000000000003', :'other', 'Other house', 'claude', pg_temp.h('tok-other'), 'tt_other'),
  ('aaaaaaaa-0000-0000-0000-000000000004', :'home', 'Revoked', 'claude', pg_temp.h('tok-revoked'), 'tt_rev'),
  ('aaaaaaaa-0000-0000-0000-000000000005', :'home', 'Expired', 'claude', pg_temp.h('tok-expired'), 'tt_exp');
update public.ai_clients set revoked_at = now() where name = 'Revoked';
update public.ai_clients set expires_at = now() - interval '1 second' where name = 'Expired';
insert into public.places (household_id, id, name, stage, lat, lng) values (:'home', 'p1', 'Khao Soi Mae Sai', 'cnx', 18.7997, 98.9690);
insert into public.locations (household_id, user_name, lat, lng, recorded_at, source) values
  (:'home', 'greg', 18.80, 98.97, now() - interval '12 minutes', 'pwa'), (:'other', 'greg', 1, 1, now(), 'pwa');

-- privileges: only the service role may call the gate; members get only the consent functions
set role anon;
do $$ begin
  begin perform public.ai_call('x', 'get_context', '{}'); raise exception 'FAILED: anon ai_call'; exception when insufficient_privilege then null; end;
  begin perform public.oauth_register('x', array['https://a/b']); raise exception 'FAILED: anon oauth_register'; exception when insufficient_privilege then null; end;
  begin perform public.oauth_request_info(gen_random_uuid()); raise exception 'FAILED: anon request info'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  begin perform public.ai_call('x', 'get_context', '{}'); raise exception 'FAILED: user ai_call'; exception when insufficient_privilege then null; end;
  begin perform public.ai_add_entry('11111111-1111-1111-1111-111111111111', 'claude', null, '{"dish_name":"x"}'); raise exception 'FAILED: user ai_add_entry'; exception when insufficient_privilege then null; end;
  begin perform public.ai_authenticate('x'); raise exception 'FAILED: user ai_authenticate'; exception when insufficient_privilege then null; end;
  begin perform public.oauth_exchange('a','b','c','d','e','f','g',1); raise exception 'FAILED: user oauth_exchange'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.oauth_requests; raise exception 'FAILED: user reads oauth_requests'; exception when insufficient_privilege then null; end;
  begin perform token_hash from public.ai_clients; raise exception 'FAILED: user reads token_hash'; exception when insufficient_privilege then null; end;
  begin perform refresh_hash from public.ai_clients; raise exception 'FAILED: user reads refresh_hash'; exception when insufficient_privilege then null; end;
end $$;
reset role; reset request.jwt.claim.sub;

set role service_role;
-- authentication
select pg_temp.ok(public.ai_call(pg_temp.h('nope'), 'get_context', '{}') #>> '{error,code}' = 'unauthorized', 'unknown token rejected');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-revoked'), 'get_context', '{}') #>> '{error,code}' = 'unauthorized', 'revoked token rejected');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-expired'), 'get_context', '{}') #>> '{error,code}' = 'unauthorized', 'expired token rejected');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-claude'), 'drop_everything', '{}') #>> '{error,code}' = 'not_found', 'unknown tool');

-- context
select public.ai_call(pg_temp.h('tok-claude'), 'get_context', '{}') -> 'result' as ctx \gset
select pg_temp.ok((:'ctx'::jsonb ->> 'today')::date = (now() at time zone 'Asia/Bangkok')::date, 'today in Bangkok');
select pg_temp.ok(:'ctx'::jsonb #>> '{current_stage,key}' = public.stage_for((now() at time zone 'Asia/Bangkok')::date), 'current stage');
select pg_temp.ok((:'ctx'::jsonb #>> '{counts,entries}')::int = 1, 'context counts only this household');
select pg_temp.ok(jsonb_array_length(:'ctx'::jsonb -> 'latest_locations') = 1 and (:'ctx'::jsonb #>> '{latest_locations,0,age_minutes}')::int = 12, 'latest location with age');
select pg_temp.ok(:'ctx'::jsonb ->> 'you_write_as' = 'claude', 'context names the author');

-- add_entry: author, source_client, stage, audit
select public.ai_call(pg_temp.h('tok-claude'), 'add_entry', '{"dish_id":"n1","place_id":"p1","date":"2026-11-10","price_thb":60,"spice":4,"note":" rich broth "}') -> 'result' as e \gset
select :'e'::jsonb ->> 'id' as eid, :'e'::jsonb ->> 'updated_at' as t0 \gset
select pg_temp.ok(:'e'::jsonb ->> 'author' = 'claude' and :'e'::jsonb ->> 'source_client' = 'Claude test', 'entry author and source_client');
select pg_temp.ok(:'e'::jsonb ->> 'stage' = 'cnx' and :'e'::jsonb ->> 'note' = 'rich broth' and :'e'::jsonb #>> '{dish,name}' = 'khao soi', 'entry stage, note, dish');
select pg_temp.ok((select count(*) from public.audit_log where tool = 'add_entry' and record_id = :'eid' and actor = 'claude'
  and client_id = 'aaaaaaaa-0000-0000-0000-000000000001' and before is null and after ->> 'note' = 'rich broth') = 1, 'add_entry audited');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-claude'), 'add_entry', '{"dish_name":"mystery curry"}') #>> '{result,dish_free}' = 'mystery curry', 'free-text dish, default date');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-claude'), 'add_entry', '{"dish_id":"zzz"}') #>> '{error,code}' = 'not_found', 'unknown dish id');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-claude'), 'add_entry', '{"note":"x"}') #>> '{error,code}' = 'invalid', 'entry needs a dish');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-claude'), 'add_entry', '{"dish_id":"n1","spice":11}') #>> '{error,code}' = 'invalid', 'check constraint becomes invalid');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-claude'), 'add_entry', '{"dish_id":"n1","date":"not a date"}') #>> '{error,code}' = 'invalid', 'bad date becomes invalid');
select pg_temp.ok((select count(*) from public.entries where household_id = :'home') = 3, 'failed adds wrote nothing');

-- two AI clients edit the same entry: the second one gets a conflict and the first write survives
select public.ai_call(pg_temp.h('tok-claude'), 'update_entry', jsonb_build_object('id', :'eid', 'expected_updated_at', :'t0', 'note', 'from claude')) -> 'result' as u1 \gset
select pg_temp.ok(:'u1'::jsonb ->> 'note' = 'from claude' and (:'u1'::jsonb ->> 'updated_at')::timestamptz > :'t0'::timestamptz, 'first update wins and moves updated_at');
select public.ai_call(pg_temp.h('tok-gpt'), 'update_entry', jsonb_build_object('id', :'eid', 'expected_updated_at', :'t0', 'note', 'from chatgpt', 'price_thb', 80)) -> 'result' as u2 \gset
select pg_temp.ok((:'u2'::jsonb ->> 'conflict')::boolean and :'u2'::jsonb #>> '{current,note}' = 'from claude', 'stale update returns conflict with the current record');
select pg_temp.ok((select note = 'from claude' and price_thb = 60 from public.entries where id = :'eid'), 'stale update wrote nothing');
select public.ai_call(pg_temp.h('tok-gpt'), 'update_entry', jsonb_build_object('id', :'eid', 'expected_updated_at', :'u2'::jsonb #>> '{current,updated_at}', 'price_thb', 80, 'place_id', null, 'place_name', 'street cart')) -> 'result' as u3 \gset
select pg_temp.ok(:'u3'::jsonb ->> 'note' = 'from claude' and (:'u3'::jsonb ->> 'price_thb')::int = 80 and :'u3'::jsonb ->> 'place_free' = 'street cart' and :'u3'::jsonb -> 'place' = 'null', 'retry merges: untouched fields kept');
select pg_temp.ok(:'u3'::jsonb ->> 'author' = 'claude', 'author stays the creator');
select pg_temp.ok((select count(*) from public.audit_log where tool = 'update_entry' and record_id = :'eid') = 2
  and (select before ->> 'price_thb' = '60' and after ->> 'price_thb' = '80' and actor = 'chatgpt' from public.audit_log where tool = 'update_entry' and record_id = :'eid' order by id desc limit 1), 'updates audited with before and after, conflicts not');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-gpt'), 'update_entry', jsonb_build_object('id', :'eid', 'note', 'x')) #>> '{error,code}' = 'invalid', 'update needs expected_updated_at');

-- rate_entry
select pg_temp.ok((public.ai_call(pg_temp.h('tok-gpt'), 'rate_entry', jsonb_build_object('id', :'eid', 'person', 'andra', 'rating', 5)) #>> '{result,rating_andra}')::int = 5, 'rate andra');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-gpt'), 'rate_entry', jsonb_build_object('id', :'eid', 'person', 'andra', 'rating', 6)) #>> '{error,code}' = 'invalid', 'rating out of range');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-gpt'), 'rate_entry', jsonb_build_object('id', :'eid', 'person', 'bob', 'rating', 3)) #>> '{error,code}' = 'invalid', 'rating for unknown person');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-gpt'), 'rate_entry', jsonb_build_object('id', :'eid', 'person', 'greg', 'rating', 4, 'expected_updated_at', :'t0')) #>> '{result,conflict}')::boolean, 'rate with stale token conflicts');
select pg_temp.ok((select rating_andra = 5 and rating_greg is null from public.entries where id = :'eid'), 'ratings stored');

-- household isolation: the other household's token cannot see or touch this one
select pg_temp.ok(public.ai_call(pg_temp.h('tok-other'), 'get_entry', jsonb_build_object('id', :'eid')) #>> '{error,code}' = 'not_found', 'other household cannot read');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-other'), 'update_entry', jsonb_build_object('id', :'eid', 'expected_updated_at', :'t0', 'note', 'hack')) #>> '{error,code}' = 'not_found', 'other household cannot update');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-other'), 'add_entry', '{"dish_id":"n1","place_id":"p1"}') #>> '{error,code}' = 'not_found', 'other household cannot reference our place');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-other'), 'search_entries', '{}') #>> '{result,total}')::int = 1, 'other household sees only its own entries');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-other'), 'list_dishes', '{}') #>> '{result,dishes,0,name}' = 'secret dish', 'other household sees only its own dishes');
select pg_temp.ok(jsonb_array_length(public.ai_call(pg_temp.h('tok-other'), 'list_places', '{}') #> '{result,places}') = 0, 'other household sees no places');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-other'), 'get_latest_location', '{}') #>> '{result,locations,0,lat}')::numeric = 1, 'other household sees only its own location');

-- search, lists, stats
select pg_temp.ok((public.ai_call(pg_temp.h('tok-claude'), 'search_entries', '{"query":"SOI"}') #>> '{result,total}')::int = 2, 'search by text (dish name)');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-claude'), 'search_entries', '{"query":"100%"}') #>> '{result,total}')::int = 0, 'search escapes wildcards');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-claude'), 'search_entries', '{"date_from":"2026-11-05","date_to":"2026-11-30","min_rating":5,"min_spice":4}') #>> '{result,total}')::int = 1, 'search by date, rating, spice');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-claude'), 'search_entries', '{"limit":1}') #>> '{result,next_offset}')::int = 1, 'search pages');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-claude'), 'list_dishes', '{"tried":true}') #>> '{result,dishes,0,times_eaten}' = '2', 'list dishes with counts');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-claude'), 'list_places', '{"near_lat":18.80,"near_lng":98.97,"radius_km":1}') #>> '{result,places,0,distance_km}')::numeric < 0.2, 'places near a point');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-claude'), 'list_places', '{"near_lat":13.75,"near_lng":100.5}') #>> '{result,total}')::int = 0, 'no places near Bangkok');
select public.ai_call(pg_temp.h('tok-claude'), 'get_stats', '{}') -> 'result' as st \gset
select pg_temp.ok((:'st'::jsonb ->> 'total_spend_thb')::int = 80 and :'st'::jsonb #>> '{top_dishes,0,name}' = 'khao soi', 'stats: spend and top dishes');
select pg_temp.ok((select (x ->> 'spend_thb')::int = 80 from jsonb_array_elements(:'st'::jsonb -> 'by_stage') x where x ->> 'stage' = 'cnx'), 'stats: spend per stage');
select pg_temp.ok((select (x ->> 'tried')::int = 1 and (x ->> 'to_try')::int = 0 from jsonb_array_elements(:'st'::jsonb -> 'still_to_try') x where x ->> 'region' = 'nord'), 'stats: still to try per region');

-- dishes, places, favs, suggestions
select public.ai_call(pg_temp.h('tok-claude'), 'add_dish', '{"name":"Gaeng hang lay","thai":"แกงฮังเล","region":"nord"}') -> 'result' as d \gset
select pg_temp.ok(not (:'d'::jsonb ->> 'already_existed')::boolean and :'d'::jsonb ->> 'thai' = 'แกงฮังเล', 'add dish keeps Thai script');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-gpt'), 'add_dish', '{"name":"gaeng HANG lay","region":"nord"}') #>> '{result,already_existed}')::boolean, 'duplicate dish returns the existing one');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-gpt'), 'add_dish', '{"name":"x","region":"mars"}') #>> '{error,code}' = 'invalid', 'bad region');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-gpt'), 'add_place', '{"name":"Cart","lat":18.8}') #>> '{error,code}' = 'invalid', 'lat without lng');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-gpt'), 'add_place', '{"name":"Night market cart","stage":"cnx","lat":18.79,"lng":98.99}') #>> '{result,stage}' = 'cnx', 'add place');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-claude'), 'toggle_fav', '{"dish_id":"n1"}') #>> '{result,fav}')::boolean, 'toggle fav on');
select pg_temp.ok((public.ai_call(pg_temp.h('tok-claude'), 'toggle_fav', '{"dish_id":"n1","fav":true}') #>> '{result,fav}')::boolean, 'fav true is idempotent');
select pg_temp.ok(not (public.ai_call(pg_temp.h('tok-claude'), 'toggle_fav', '{"dish_id":"n1"}') #>> '{result,fav}')::boolean, 'toggle fav off');
select pg_temp.ok((select count(*) from public.audit_log where tool = 'toggle_fav') = 2, 'only real fav changes audited');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-gpt'), 'add_suggestion', '{"kind":"dish","payload":{"rom":"Khanom krok","region":"dulci","reason":"sold near you","junk":1}}') #> '{result,payload}'
  = '{"rom":"Khanom krok","region":"dulci","reason":"sold near you"}', 'suggestion payload cleaned');
select pg_temp.ok(public.ai_call(pg_temp.h('tok-gpt'), 'add_suggestion', '{"kind":"place","payload":{"name":"x","stage":"nowhere"}}') #>> '{error,code}' = 'invalid', 'bad suggestion rejected');
select pg_temp.ok((select author = 'chatgpt' and status = 'new' from public.suggestions where household_id = :'home'), 'suggestion author');
select pg_temp.ok(jsonb_array_length(public.ai_call(pg_temp.h('tok-claude'), 'list_suggestions', '{"status":"new"}') #> '{result,suggestions}') = 1, 'list suggestions');
select pg_temp.ok((select count(*) from public.audit_log where household_id = :'other') = 0 and (select count(*) from public.audit_log where client_id is null) = 0, 'audit rows carry household and client');

-- rate limits: 20 writes a minute, 60 calls a minute
delete from public.rate_limits;
do $$ declare i int; r jsonb; begin
  for i in 1..20 loop r := public.ai_call(encode(extensions.digest('tok-gpt', 'sha256'), 'hex'), 'toggle_fav', '{"dish_id":"n1"}'); end loop;
  if not (r ->> 'ok')::boolean then raise exception 'FAILED: 20th write should pass: %', r; end if;
  r := public.ai_call(encode(extensions.digest('tok-gpt', 'sha256'), 'hex'), 'toggle_fav', '{"dish_id":"n1"}');
  if r #>> '{error,code}' <> 'rate_limited' then raise exception 'FAILED: 21st write should be limited: %', r; end if;
  r := public.ai_call(encode(extensions.digest('tok-claude', 'sha256'), 'hex'), 'toggle_fav', '{"dish_id":"n1"}');
  if not (r ->> 'ok')::boolean then raise exception 'FAILED: limits are per client: %', r; end if;
  for i in 1..39 loop r := public.ai_call(encode(extensions.digest('tok-gpt', 'sha256'), 'hex'), 'get_context', '{}'); end loop;
  if not (r ->> 'ok')::boolean then raise exception 'FAILED: 60th call should pass: %', r; end if;
  r := public.ai_call(encode(extensions.digest('tok-gpt', 'sha256'), 'hex'), 'get_context', '{}');
  if r #>> '{error,code}' <> 'rate_limited' then raise exception 'FAILED: 61st call should be limited: %', r; end if;
end $$;
delete from public.rate_limits;

-- OAuth: register, begin, approve (as a member), exchange, replay, refresh
select pg_temp.ok(public.oauth_register('Evil', array['http://evil.example/cb']) ->> 'error' = 'invalid_redirect_uri', 'plain http redirect refused');
select public.oauth_register('Claude', array['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback']) ->> 'client_id' as oc \gset
select pg_temp.ok(public.oauth_begin(:'oc', 'https://evil.example/cb', 's', repeat('a', 43), null) ->> 'error' = 'invalid_redirect_uri', 'unregistered redirect refused');
select pg_temp.ok(public.oauth_begin('oc_nope', 'https://claude.ai/api/mcp/auth_callback', 's', repeat('a', 43), null) ->> 'error' = 'invalid_client', 'unknown client refused');
select pg_temp.ok(public.oauth_begin(:'oc', 'https://claude.ai/api/mcp/auth_callback', 's', 'short', null) ->> 'error' = 'invalid_request', 'PKCE challenge required');
select pg_temp.ok(public.oauth_begin(:'oc', 'http://localhost:43111/callback', 's', repeat('a', 43), null) ? 'request_id', 'loopback redirect on any port');
select public.oauth_begin(:'oc', 'https://claude.ai/api/mcp/auth_callback', 'st8', repeat('a', 43), 'https://x/mcp') ->> 'request_id' as rq \gset
select public.oauth_begin(:'oc', 'https://claude.ai/api/mcp/auth_callback', 'st9', repeat('a', 43), null) ->> 'request_id' as rq2 \gset
reset role;

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.ok(public.oauth_request_info(:'rq') ->> 'client_name' = 'Claude', 'member sees who is asking');
select public.approve_oauth_request(:'rq', 'claude') as ap \gset
select pg_temp.ok(:'ap'::jsonb ->> 'state' = 'st8' and length(:'ap'::jsonb ->> 'code') = 64, 'approve returns code and state');
do $$ begin
  begin perform public.approve_oauth_request((select id from (values (1)) v, lateral (select gen_random_uuid() id) g), 'claude'); raise exception 'FAILED: approve unknown request'; exception when no_data_found then null; end;
end $$;
select pg_temp.ok(public.oauth_request_info(:'rq') is null, 'answered request is gone');
select pg_temp.ok(public.deny_oauth_request(:'rq2') ->> 'state' = 'st9', 'deny returns redirect');
reset role; reset request.jwt.claim.sub;

set role service_role;
select pg_temp.ok(public.oauth_exchange(pg_temp.h(:'ap'::jsonb ->> 'code'), :'oc', 'https://claude.ai/api/mcp/auth_callback', repeat('b', 43), pg_temp.h('at1'), 'tt_at1', pg_temp.h('rt1'), 3600) ->> 'error' = 'invalid_grant', 'wrong PKCE verifier refused');
select pg_temp.ok((public.oauth_exchange(pg_temp.h(:'ap'::jsonb ->> 'code'), :'oc', 'https://claude.ai/api/mcp/auth_callback', repeat('a', 43), pg_temp.h('at1'), 'tt_at1', pg_temp.h('rt1'), 3600) ->> 'ok')::boolean, 'code exchanged');
select public.ai_call(pg_temp.h('at1'), 'get_context', '{}') as c1 \gset
select pg_temp.ok(:'c1'::jsonb #>> '{client,author}' = 'claude' and :'c1'::jsonb #>> '{client,name}' = 'Claude (approved by andra)' and :'c1'::jsonb #>> '{client,household_id}' = :'home', 'OAuth token is bound to the approver''s household');
select pg_temp.ok((public.oauth_refresh(pg_temp.h('rt1'), :'oc', pg_temp.h('at2'), 'tt_at2', pg_temp.h('rt2'), 3600) ->> 'ok')::boolean, 'refresh');
select pg_temp.ok(public.ai_call(pg_temp.h('at1'), 'get_context', '{}') #>> '{error,code}' = 'unauthorized' and (public.ai_call(pg_temp.h('at2'), 'get_context', '{}') ->> 'ok')::boolean, 'refresh rotates the access token');
select pg_temp.ok(public.oauth_refresh(pg_temp.h('rt1'), :'oc', pg_temp.h('at3'), 'tt_at3', pg_temp.h('rt3'), 3600) ->> 'error' = 'invalid_grant', 'old refresh token is dead');
select pg_temp.ok(public.oauth_exchange(pg_temp.h(:'ap'::jsonb ->> 'code'), :'oc', 'https://claude.ai/api/mcp/auth_callback', repeat('a', 43), pg_temp.h('at9'), 'tt_at9', pg_temp.h('rt9'), 3600) ->> 'error' = 'invalid_grant', 'replayed code refused');
select pg_temp.ok(public.ai_call(pg_temp.h('at2'), 'get_context', '{}') #>> '{error,code}' = 'unauthorized', 'replayed code revokes the token it produced');
select pg_temp.ok(public.oauth_refresh(pg_temp.h('rt2'), :'oc', pg_temp.h('at4'), 'tt_at4', pg_temp.h('rt4'), 3600) ->> 'error' = 'invalid_grant', 'revoked client cannot refresh');
reset role;
