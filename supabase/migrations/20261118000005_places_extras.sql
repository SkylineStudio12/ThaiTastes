-- The original app lets you attach an Instagram link and a note to ANY place, including catalogue (builtin) ones.
alter table public.places add column if not exists ig text check (ig is null or ig ~* '^https?://');

-- Builtin places stay protected except for ig and note. Signed-in users cannot flip the builtin flag on any row.
drop policy if exists places_upd on public.places;
create policy places_upd on public.places for update to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

create or replace function public.places_guard() returns trigger
language plpgsql as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' then
    new.household_id := old.household_id;
    new.id := old.id;
    new.builtin := old.builtin;
    new.created_at := old.created_at;
    if old.builtin then
      new.name := old.name; new.th := old.th; new.address := old.address;
      new.stage := old.stage; new.lat := old.lat; new.lng := old.lng;
    end if;
  end if;
  return new;
end $$;
create trigger places_guard before update on public.places for each row execute function public.places_guard();
