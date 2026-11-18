-- Private photo bucket. Object path convention: <household_id>/<assetId>.jpg
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Members can read, upload, replace and delete photos inside their own household folder. Nobody else, and never anon.
create policy photos_read on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy photos_update on storage.objects for update to authenticated
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));

-- Realtime: changes made by the AI layer show up live in the open app.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['entries', 'dishes', 'places', 'favs', 'suggestions', 'locations'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- Location retention: purge nightly if pg_cron is enabled (Dashboard > Database > Extensions). Otherwise call
-- select public.purge_old_locations(); by hand, or the AI layer does it opportunistically (phase 3).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('thaitastes-purge-locations', '15 3 * * *', 'select public.purge_old_locations()');
  end if;
end $$;
