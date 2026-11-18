-- Reference data extracted from the original app (builtin/regions.json, builtin/stages.json). Idempotent.
insert into public.regions (key, name, sub, sort) values
  ('nord',   'North',             'Chiang Mai, Chiang Rai, Pai', 1),
  ('centru', 'Central',           'Bangkok', 2),
  ('sud',    'South',             'Khao Lak, Phuket, Krabi, Lanta', 3),
  ('est',    'East',              'Koh Chang and Trat', 4),
  ('isaan',  'Isaan',             'found everywhere', 5),
  ('dulci',  'Sweets and drinks', '', 6)
on conflict (key) do nothing;

insert into public.stages (key, name, region_key, sort) values
  ('bkk',   'Bangkok',    'centru', 1),
  ('cnx',   'Chiang Mai', 'nord',   2),
  ('khl',   'Khao Lak',   'sud',    3),
  ('hkt',   'Phuket',     'sud',    4),
  ('pp',    'Phi Phi',    'sud',    5),
  ('kbv',   'Krabi',      'sud',    6),
  ('lanta', 'Koh Lanta',  'sud',    7),
  ('chang', 'Koh Chang',  'est',    8)
on conflict (key) do nothing;

insert into public.stage_periods (start_date, stage_key) values
  ('2026-11-03', 'bkk'), ('2026-11-07', 'cnx'), ('2026-12-20', 'khl'), ('2026-12-30', 'hkt'),
  ('2027-01-02', 'pp'),  ('2027-01-04', 'kbv'), ('2027-02-01', 'lanta'), ('2027-03-01', 'chang'),
  ('2027-04-01', 'bkk')
on conflict (start_date) do nothing;
