-- ---------------------------------------------------------------------------
-- Something to look at.
--
-- A fresh database leaves every page correct and empty: the search finds
-- nobody, so there is no profile to open, so there is no slot to book, and
-- the first thing anyone sees of Tabib.ma is an empty state. This fills in
-- four verified practitioners in four cities with hours open over the coming
-- fortnight, which is enough to walk the whole patient path.
--
-- Safe to run more than once, and safe to run on a database that already has
-- real accounts in it: every insert is keyed on a fixed uuid, so a second run
-- updates the same four rows rather than making four more.
--
-- NOT for production, and these are accounts nobody can sign in as. Sign-in
-- is a one-time code sent to the number on the `auth.users` row, and these
-- rows deliberately have no number on them at all — a seeded account with a
-- known phone number is a way in. The number that appears on the profile is
-- the one a patient would call, which is not the same thing.
--
--   npm run db:seed          # with DATABASE_URL set
--   psql "$DATABASE_URL" -f supabase/seed.sql
-- ---------------------------------------------------------------------------

begin;

-- `public.profiles` hangs off `auth.users`, and the row is created by the
-- on_auth_user_created trigger rather than by hand — the same path a real
-- sign-up takes, so the seed exercises it instead of working around it.
insert into auth.users (id, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', '{"full_name":"Dr Amina Benali"}'),
  ('22222222-2222-4222-8222-222222222222', '{"full_name":"Dr Youssef El Amrani"}'),
  ('33333333-3333-4333-8333-333333333333', '{"full_name":"Dr Nadia Chraibi"}'),
  ('44444444-4444-4444-8444-444444444444', '{"full_name":"Dr Omar Tazi"}')
on conflict (id) do nothing;

-- The number a patient would ring, and the one the outbox would text.
update public.profiles set
    full_name = v.full_name,
    phone = v.phone,
    role = 'doctor'
from (values
    ('11111111-1111-4111-8111-111111111111'::uuid, 'Dr Amina Benali',      '+212661000001'),
    ('22222222-2222-4222-8222-222222222222'::uuid, 'Dr Youssef El Amrani', '+212661000002'),
    ('33333333-3333-4333-8333-333333333333'::uuid, 'Dr Nadia Chraibi',     '+212661000003'),
    ('44444444-4444-4444-8444-444444444444'::uuid, 'Dr Omar Tazi',         '+212661000004')
  ) as v(id, full_name, phone)
where public.profiles.id = v.id;

insert into public.doctor_profiles (id, display_name, specialty, city, bio, verified) values
  ('11111111-1111-4111-8111-111111111111', 'Dr Amina Benali', 'Cardiologie', 'Casablanca',
   'Cardiologie interventionnelle. Francais, arabe, anglais. Tiers payant CNSS et CNOPS.', true),
  ('22222222-2222-4222-8222-222222222222', 'Dr Youssef El Amrani', 'Dermatologie', 'Rabat',
   'Dermatologie generale et esthetique. Francais, arabe.', true),
  ('33333333-3333-4333-8333-333333333333', 'Dr Nadia Chraibi', 'Pediatrie', 'Marrakech',
   'Suivi de l''enfant et vaccinations. Francais, arabe, amazigh.', true),
  ('44444444-4444-4444-8444-444444444444', 'Dr Omar Tazi', 'Medecine generale', 'Tanger',
   'Medecine generale, certificats et bilans. Francais, arabe, espagnol.', true)
on conflict (id) do update
  set display_name = excluded.display_name,
      specialty = excluded.specialty,
      city = excluded.city,
      bio = excluded.bio,
      verified = excluded.verified;

-- Hours over the next fortnight: mornings for everyone, plus an afternoon
-- clinic each, anchored to the minute so the slots come out on round times.
-- Weekends are skipped, because a seeded Sunday surgery looks like a bug.
insert into public.doctor_availability (doctor_id, start_at, end_at, slot_minutes, status)
select
  doctor.id,
  day + shift.starts,
  day + shift.ends,
  shift.minutes,
  'open'
from (values
    ('11111111-1111-4111-8111-111111111111'::uuid),
    ('22222222-2222-4222-8222-222222222222'::uuid),
    ('33333333-3333-4333-8333-333333333333'::uuid),
    ('44444444-4444-4444-8444-444444444444'::uuid)
  ) as doctor(id)
cross join generate_series(
    date_trunc('day', now()),
    date_trunc('day', now()) + interval '13 days',
    interval '1 day'
  ) as day
cross join (values
    (interval '9 hours',  interval '12 hours 30 minutes', 30),
    (interval '15 hours', interval '18 hours',            20)
  ) as shift(starts, ends, minutes)
where extract(isodow from day) <= 5
  and day + shift.ends > now()
on conflict do nothing;

commit;

select
  (select count(*) from public.doctor_profiles where verified) as verified_practitioners,
  (select count(*) from public.doctor_availability where end_at > now()) as open_blocks;
