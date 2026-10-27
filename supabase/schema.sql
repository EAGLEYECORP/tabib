create extension if not exists btree_gist;
create type public.user_role as enum ('patient','doctor','clinic_admin','platform_admin');
create type public.appointment_status as enum ('requested','confirmed','cancelled','completed','no_show');
create table public.profiles(id uuid primary key references auth.users(id) on delete cascade,full_name text,phone text,role public.user_role not null default 'patient',created_at timestamptz not null default now());
create table public.doctor_profiles(id uuid primary key references public.profiles(id) on delete cascade,display_name text not null,specialty text not null,city text not null,bio text,verified boolean not null default false);
create table public.clinics(id uuid primary key default gen_random_uuid(),name text not null,city text not null,address text,verified boolean not null default false,created_at timestamptz not null default now());
create table public.doctor_availability(id uuid primary key default gen_random_uuid(),doctor_id uuid not null references public.doctor_profiles(id) on delete cascade,start_at timestamptz not null,end_at timestamptz not null,status text not null default 'open',check(end_at>start_at));
create table public.appointments(id uuid primary key default gen_random_uuid(),patient_id uuid not null references public.profiles(id) on delete restrict,doctor_id uuid not null references public.doctor_profiles(id) on delete restrict,start_at timestamptz not null,end_at timestamptz not null,status public.appointment_status not null default 'requested',reason text,created_at timestamptz not null default now(),check(end_at>start_at));
alter table public.appointments add constraint no_overlapping_doctor_appointments exclude using gist(doctor_id with =,tstzrange(start_at,end_at,'[)') with &&) where(status in('requested','confirmed'));
create table public.audit_logs(id bigint generated always as identity primary key,actor_id uuid references auth.users(id) on delete set null,action text not null,entity_type text,entity_id uuid,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now());
alter table public.profiles enable row level security;alter table public.doctor_profiles enable row level security;alter table public.clinics enable row level security;alter table public.doctor_availability enable row level security;alter table public.appointments enable row level security;alter table public.audit_logs enable row level security;
create policy "verified doctors public read" on public.doctor_profiles for select using(verified=true);
create policy "own profile read" on public.profiles for select using(auth.uid()=id);
create policy "patient appointments read" on public.appointments for select using(auth.uid()=patient_id);
create policy "doctor appointments read" on public.appointments for select using(auth.uid()=doctor_id);
create policy "patient appointments create" on public.appointments for insert with check(auth.uid()=patient_id);
create policy "patient appointments update" on public.appointments for update using(auth.uid()=patient_id);
create policy "doctor appointments update" on public.appointments for update using(auth.uid()=doctor_id);

-- ---------------------------------------------------------------------------
-- Medical documents
--
-- Files live in a private Storage bucket; this table is the index over them.
-- Nothing here grants access on its own: every rule below is enforced by
-- Postgres row-level security, so a mistake in application code cannot hand a
-- patient's analyses to the wrong person.
--
-- The sharing model is deliberately narrow. A document belongs to a patient,
-- always -- including a prescription a doctor writes, which is the patient's
-- record held on their behalf. A doctor sees a document only when the patient
-- has attached it to an appointment with that doctor. Attaching is sharing and
-- detaching is un-sharing, so there is no second permission list that can drift
-- out of step with the appointments themselves.
-- ---------------------------------------------------------------------------

create type public.document_kind as enum (
  'analysis','imaging','prescription','report','insurance','referral','other'
);

create table public.documents(
  id uuid primary key default gen_random_uuid(),

  -- Whose record this belongs to.
  patient_id uuid not null references public.profiles(id) on delete cascade,
  -- Attaching to an appointment is what shares the document with its doctor.
  appointment_id uuid references public.appointments(id) on delete set null,
  -- Who put it there: the patient, or a doctor sending a prescription back.
  uploaded_by uuid not null references public.profiles(id) on delete restrict,

  -- Object key in the medical-documents bucket, always '<patient_id>/<uuid>'.
  storage_path text not null unique,
  -- Original name, sanitised, shown in the interface and used on download.
  filename text not null,
  -- Determined by inspecting the bytes on upload, never from the client's
  -- Content-Type header; the check keeps a bad value out even so.
  mime_type text not null check (mime_type in (
    'application/pdf','image/jpeg','image/png','image/webp',
    'image/heic','image/tiff','application/dicom'
  )),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 20971520),
  -- SHA-256 of the contents: detects duplicate uploads and silent corruption.
  checksum text,

  kind public.document_kind not null default 'other',
  note text check (note is null or length(note) <= 500),

  -- Soft delete: the patient's copy disappears and the bytes are removed, but
  -- the row survives so a doctor's record of what informed a consultation is
  -- not rewritten after the fact.
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create index documents_patient_idx on public.documents(patient_id, created_at desc)
  where deleted_at is null;
create index documents_appointment_idx on public.documents(appointment_id)
  where deleted_at is null;

alter table public.documents enable row level security;

-- A doctor's reach, in one place: an appointment of their own that the
-- document is attached to. Both the table policies and the Storage policies
-- call this, so the rule is written once.
create or replace function public.can_doctor_see_document(doc_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.documents d
    join public.appointments a on a.id = d.appointment_id
    where d.id = doc_id
      and d.deleted_at is null
      and a.doctor_id = auth.uid()
  );
$$;

-- Patients: full control over their own record.
create policy "patient reads own documents" on public.documents
  for select using (auth.uid() = patient_id and deleted_at is null);

create policy "patient adds own documents" on public.documents
  for insert with check (
    auth.uid() = patient_id
    and auth.uid() = uploaded_by
    -- May only attach to an appointment that is actually theirs.
    and (appointment_id is null or exists (
      select 1 from public.appointments a
      where a.id = appointment_id and a.patient_id = auth.uid()
    ))
  );

-- Sharing, un-sharing and editing the note. Deletion is deliberately not
-- reachable here: see soft_delete_document below.
create policy "patient updates own documents" on public.documents
  for update using (auth.uid() = patient_id and deleted_at is null)
  with check (
    auth.uid() = patient_id
    and deleted_at is null
    and (appointment_id is null or exists (
      select 1 from public.appointments a
      where a.id = appointment_id and a.patient_id = auth.uid()
    ))
  );

-- Deleting a document is an operation, not a field edit.
--
-- It has to be, because the read policies hide deleted rows: a patient setting
-- deleted_at through a plain UPDATE would be writing a row they can no longer
-- see, which PostgreSQL rejects. Routing it through one security-definer
-- function also gives a single place to check ownership, and returns the
-- object key so the caller can remove the bytes from Storage -- "delete" has
-- to mean the file is gone, not merely hidden.
create or replace function public.soft_delete_document(doc_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  path text;
begin
  update public.documents
     set deleted_at = now()
   where id = doc_id
     and patient_id = auth.uid()
     and deleted_at is null
  returning storage_path into path;

  if path is null then
    raise exception 'Document not found, already deleted, or not yours'
      using errcode = 'insufficient_privilege';
  end if;

  return path;
end;
$$;

revoke all on function public.soft_delete_document(uuid) from public;
grant execute on function public.soft_delete_document(uuid) to authenticated;

-- Doctors: read only what was shared with them, and only through their own
-- appointment. No update, no delete -- a doctor cannot alter or remove
-- anything from a patient's record.
create policy "doctor reads shared documents" on public.documents
  for select using (
    deleted_at is null
    and appointment_id is not null
    and exists (
      select 1 from public.appointments a
      where a.id = appointment_id and a.doctor_id = auth.uid()
    )
  );

-- A doctor may file a document into the record of a patient they are seeing --
-- a prescription, a report -- but only against their own appointment.
create policy "doctor sends document to patient" on public.documents
  for insert with check (
    auth.uid() = uploaded_by
    and appointment_id is not null
    and exists (
      select 1 from public.appointments a
      where a.id = appointment_id
        and a.doctor_id = auth.uid()
        and a.patient_id = documents.patient_id
    )
  );

-- ---------------------------------------------------------------------------
-- Storage
--
-- The bucket is private: there is no public URL for a scan or an analysis, and
-- the only way to the bytes is a short-lived signed URL minted for someone the
-- policies below already allow.
--
-- Object keys are '<patient_id>/<uuid>', so the first path segment identifies
-- the owner and every policy keys off it. Storage policies are separate from
-- the table's: a row in public.documents grants nothing by itself, and neither
-- does an object -- both have to agree.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'medical-documents', 'medical-documents', false, 20971520,
  array['application/pdf','image/jpeg','image/png','image/webp',
        'image/heic','image/tiff','application/dicom']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- A patient reaches the objects filed under their own id.
create policy "patient reads own files" on storage.objects
  for select using (
    bucket_id = 'medical-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "patient uploads own files" on storage.objects
  for insert with check (
    bucket_id = 'medical-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "patient deletes own files" on storage.objects
  for delete using (
    bucket_id = 'medical-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- A doctor reaches an object only through a document row that is attached to
-- one of their own appointments -- the same rule as the table, applied to the
-- bytes.
create policy "doctor reads shared files" on storage.objects
  for select using (
    bucket_id = 'medical-documents'
    and exists (
      select 1
      from public.documents d
      join public.appointments a on a.id = d.appointment_id
      where d.storage_path = storage.objects.name
        and d.deleted_at is null
        and a.doctor_id = auth.uid()
    )
  );

-- A doctor writes into the patient's folder only when sending a document to a
-- patient they have an appointment with.
create policy "doctor uploads to patient folder" on storage.objects
  for insert with check (
    bucket_id = 'medical-documents'
    and exists (
      select 1 from public.appointments a
      where a.doctor_id = auth.uid()
        and a.patient_id::text = (storage.foldername(name))[1]
    )
  );

-- ---------------------------------------------------------------------------
-- Audit trail
--
-- Who touched which document, and when. Medical records need this for its own
-- sake, and it is the only way to answer "who saw my file?" later.
-- ---------------------------------------------------------------------------

create or replace function public.log_document_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (
    auth.uid(),
    case
      when tg_op = 'INSERT' then 'document.created'
      when tg_op = 'UPDATE' and new.deleted_at is not null
           and old.deleted_at is null then 'document.deleted'
      when tg_op = 'UPDATE' and new.appointment_id is distinct from old.appointment_id
        then case when new.appointment_id is null
                  then 'document.unshared' else 'document.shared' end
      else 'document.updated'
    end,
    'document',
    new.id,
    jsonb_build_object(
      'patient_id', new.patient_id,
      'appointment_id', new.appointment_id,
      'kind', new.kind
    )
  );
  return new;
end;
$$;

create trigger documents_audit
  after insert or update on public.documents
  for each row execute function public.log_document_change();

-- ---------------------------------------------------------------------------
-- Accounts
--
-- Supabase Auth creates a row in auth.users when someone signs in with a code;
-- nothing creates the public.profiles row that the rest of the schema points
-- at. Without this trigger a patient's first booking fails on a foreign key,
-- which is a confusing way to learn that an account is half-created.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, phone, role)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    new.phone,
    'patient'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A patient fills in their own name after signing in; the booking form needs
-- somewhere to put it.
create policy "own profile update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- A doctor needs to read the names of patients they are seeing. Limited to
-- people they actually have an appointment with.
create policy "doctor reads own patients" on public.profiles
  for select using (
    exists (
      select 1 from public.appointments a
      where a.patient_id = profiles.id and a.doctor_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Availability
--
-- The table had row-level security enabled and no policies at all, which made
-- it unreadable by everyone: no patient could ever see a free slot. Opening
-- hours of a verified practitioner are public information, so they are
-- readable by anyone, signed in or not.
-- ---------------------------------------------------------------------------

-- How long one consultation lasts in a given block. A cabinet's morning is
-- one row, sliced into appointments of this length.
alter table public.doctor_availability
  add column if not exists slot_minutes integer not null default 30
    check (slot_minutes between 5 and 240);

create policy "open availability is public" on public.doctor_availability
  for select using (
    status = 'open'
    and exists (
      select 1 from public.doctor_profiles d
      where d.id = doctor_id and d.verified = true
    )
  );

create policy "doctor manages own availability" on public.doctor_availability
  for all using (auth.uid() = doctor_id) with check (auth.uid() = doctor_id);

-- ---------------------------------------------------------------------------
-- Free slots
--
-- Computing these needs to know which times are already taken, but a patient
-- must not be able to read another patient's appointments. The function runs
-- as its owner for that reason: it can see every booking, and returns only
-- times -- never who holds them.
-- ---------------------------------------------------------------------------

/** Nobody may book a consultation starting in the next two hours; a cabinet
    needs warning that someone is coming. */
create or replace function public.booking_lead_time()
returns interval language sql immutable as $$ select interval '2 hours' $$;

create or replace function public.available_slots(
  p_doctor_id uuid,
  p_from timestamptz default now(),
  p_days integer default 14
)
returns table (slot_start timestamptz, slot_end timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      greatest(p_from, now() + public.booking_lead_time()) as earliest,
      p_from + (least(greatest(p_days, 0), 60) || ' days')::interval as latest
  ),
  candidate as (
    -- Each availability block is cut into consultations of its own length.
    -- The series stops one slot short of the end so a block never emits a
    -- consultation that would run past closing time.
    select
      step as slot_start,
      step + (av.slot_minutes || ' minutes')::interval as slot_end
    from public.doctor_availability av
    cross join bounds b
    cross join lateral generate_series(
      av.start_at,
      av.end_at - (av.slot_minutes || ' minutes')::interval,
      (av.slot_minutes || ' minutes')::interval
    ) as step
    where av.doctor_id = p_doctor_id
      and av.status = 'open'
      and av.end_at > b.earliest
      and av.start_at < b.latest
  )
  select c.slot_start, c.slot_end
  from candidate c
  cross join bounds b
  where c.slot_start >= b.earliest
    and c.slot_start < b.latest
    and not exists (
      select 1
      from public.appointments a
      where a.doctor_id = p_doctor_id
        and a.status in ('requested', 'confirmed')
        and tstzrange(a.start_at, a.end_at, '[)')
            && tstzrange(c.slot_start, c.slot_end, '[)')
    )
  order by c.slot_start;
$$;

-- Availability is public, so an unauthenticated visitor may look before
-- signing in; booking still requires an account.
grant execute on function public.available_slots(uuid, timestamptz, integer) to anon, authenticated;
grant execute on function public.booking_lead_time() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Booking
--
-- The original insert policy accepted any time at all, so a patient could book
-- a doctor at three in the morning by posting a chosen timestamp. Replaced
-- with one that requires the slot to fall inside an advertised block and to
-- respect the lead time. Double booking is prevented separately, by the
-- exclusion constraint on the table.
-- ---------------------------------------------------------------------------

drop policy if exists "patient appointments create" on public.appointments;

create policy "patient appointments create" on public.appointments
  for insert with check (
    auth.uid() = patient_id
    and start_at >= now() + public.booking_lead_time()
    and exists (
      select 1 from public.doctor_availability av
      where av.doctor_id = appointments.doctor_id
        and av.status = 'open'
        and appointments.start_at >= av.start_at
        and appointments.end_at <= av.end_at
    )
  );

-- Cancelling is the patient's to do; rescheduling means cancelling and
-- booking again, so the times are frozen once the row exists.
drop policy if exists "patient appointments update" on public.appointments;

create policy "patient appointments cancel" on public.appointments
  for update using (auth.uid() = patient_id)
  with check (auth.uid() = patient_id);

-- ---------------------------------------------------------------------------
-- Opening consulting hours
--
-- A practitioner thinks in wall-clock time: "Tuesday, nine to one". Turning
-- that into an instant has to go through the time-zone database, because
-- Morocco's offset is not constant -- the country keeps UTC+1 year-round but
-- returns to UTC for the month of Ramadan. PostgreSQL's AT TIME ZONE does
-- this correctly from tzdata, so the conversion lives here rather than in the
-- browser, where it would need a date library and would be wrong for several
-- weeks a year if anyone reached for a fixed +01:00.
-- ---------------------------------------------------------------------------

-- Two overlapping open blocks would offer the same minute twice and let a
-- doctor be booked into both. The diary refuses to describe itself twice.
alter table public.doctor_availability
  add constraint no_overlapping_availability
  exclude using gist (
    doctor_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status = 'open');

/**
 * Opens blocks of consulting time.
 *
 * Takes absolute instants, not wall-clock times. Resolving "nine o'clock in
 * Casablanca" to a moment belongs with the code that renders it back, and
 * that is the application: PostgreSQL's AT TIME ZONE would consult the
 * server's own copy of the time-zone database, which is not always current --
 * some builds still carry an Africa/Casablanca fixed at UTC, missing both the
 * permanent UTC+1 and the Ramadan return to UTC. Converting in two places
 * against two copies risks a doctor's 09:00 being shown to a patient as
 * 08:00, so the conversion happens once, in apps/web/lib/booking/wall-time.ts.
 *
 * Runs as the caller, so the insert policy decides whose diary this writes
 * to: a doctor can only ever open their own. Blocks in the past, or
 * overlapping something already open, are skipped rather than failing the
 * request -- a practitioner repeating a Tuesday for two months should not
 * lose the other seven weeks because one is already covered.
 *
 * @param p_blocks [{"start": "<ISO instant>", "end": "<ISO instant>"}, ...]
 */
create or replace function public.open_availability(
  p_blocks jsonb,
  p_slot_minutes integer default 30
)
returns setof public.doctor_availability
language plpgsql
volatile
as $$
declare
  block jsonb;
  block_start timestamptz;
  block_end timestamptz;
  created public.doctor_availability;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  if p_slot_minutes is null or p_slot_minutes < 5 or p_slot_minutes > 240 then
    raise exception 'A consultation lasts between 5 and 240 minutes'
      using errcode = 'check_violation';
  end if;

  if p_blocks is null or jsonb_typeof(p_blocks) <> 'array' then
    raise exception 'Expected a list of blocks' using errcode = 'check_violation';
  end if;

  for block in select * from jsonb_array_elements(p_blocks) loop
    block_start := (block ->> 'start')::timestamptz;
    block_end := (block ->> 'end')::timestamptz;

    if block_start is null or block_end is null then
      raise exception 'Each block needs a start and an end'
        using errcode = 'check_violation';
    end if;

    if block_end <= block_start then
      raise exception 'The block must end after it starts'
        using errcode = 'check_violation';
    end if;

    if block_end - block_start < (p_slot_minutes || ' minutes')::interval then
      raise exception 'The block is shorter than one consultation'
        using errcode = 'check_violation';
    end if;

    -- Opening hours that have already passed help nobody.
    if block_end <= now() then
      continue;
    end if;

    -- An overlap is a week already covered, not a reason to abandon the rest.
    begin
      insert into public.doctor_availability
        (doctor_id, start_at, end_at, slot_minutes, status)
      values (auth.uid(), block_start, block_end, p_slot_minutes, 'open')
      returning * into created;

      return next created;
    exception
      when exclusion_violation then
        continue;
    end;
  end loop;

  return;
end;
$$;

revoke all on function public.open_availability(jsonb, integer) from public;
grant execute on function public.open_availability(jsonb, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Closures
--
-- Opening hours repeat; life does not. A practitioner takes a holiday, closes
-- for Aïd, goes to a conference, or loses an afternoon to an emergency, and
-- none of that should mean deleting the weekly blocks they will want back
-- next month. A closure sits over the top of the diary and hides whatever it
-- covers, so the underlying hours survive it.
--
-- A closure hides *free* time. It deliberately does not cancel appointments
-- already booked: those people have a place in the diary and are owed a
-- conversation, not a silent disappearance. The screen lists who is affected
-- so the practitioner can reach them.
-- ---------------------------------------------------------------------------

create table public.doctor_absences(
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctor_profiles(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text check (reason is null or length(reason) <= 200),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index doctor_absences_doctor_idx
  on public.doctor_absences (doctor_id, starts_at);

alter table public.doctor_absences enable row level security;

-- Only the practitioner sees or touches their own closures. Patients never
-- need to read them: a closed slot is simply absent from what is offered,
-- which says nothing about why.
create policy "doctor manages own closures" on public.doctor_absences
  for all using (auth.uid() = doctor_id) with check (auth.uid() = doctor_id);

-- Closures take effect by being excluded from the slots on offer. The
-- function already runs as its owner, so it reads them regardless of the
-- policy above.
create or replace function public.available_slots(
  p_doctor_id uuid,
  p_from timestamptz default now(),
  p_days integer default 14
)
returns table (slot_start timestamptz, slot_end timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      greatest(p_from, now() + public.booking_lead_time()) as earliest,
      p_from + (least(greatest(p_days, 0), 60) || ' days')::interval as latest
  ),
  candidate as (
    -- Each availability block is cut into consultations of its own length.
    -- The series stops one slot short of the end so a block never emits a
    -- consultation that would run past closing time.
    select
      step as slot_start,
      step + (av.slot_minutes || ' minutes')::interval as slot_end
    from public.doctor_availability av
    cross join bounds b
    cross join lateral generate_series(
      av.start_at,
      av.end_at - (av.slot_minutes || ' minutes')::interval,
      (av.slot_minutes || ' minutes')::interval
    ) as step
    where av.doctor_id = p_doctor_id
      and av.status = 'open'
      and av.end_at > b.earliest
      and av.start_at < b.latest
  )
  select c.slot_start, c.slot_end
  from candidate c
  cross join bounds b
  where c.slot_start >= b.earliest
    and c.slot_start < b.latest
    and not exists (
      select 1
      from public.appointments a
      where a.doctor_id = p_doctor_id
        and a.status in ('requested', 'confirmed')
        and tstzrange(a.start_at, a.end_at, '[)')
            && tstzrange(c.slot_start, c.slot_end, '[)')
    )
    and not exists (
      select 1
      from public.doctor_absences x
      where x.doctor_id = p_doctor_id
        and tstzrange(x.starts_at, x.ends_at, '[)')
            && tstzrange(c.slot_start, c.slot_end, '[)')
    )
  order by c.slot_start;
$$;

/**
 * Whether a practitioner has closed a given period.
 *
 * This has to run as its owner. Closures are private to the practitioner, so
 * a policy subquery evaluated as the *patient* would see no rows at all and
 * conclude that nothing is closed -- the check would pass for exactly the
 * bookings it exists to refuse. Returning a bare boolean leaks nothing: the
 * patient learns a time is unavailable, never why.
 */
create or replace function public.is_doctor_closed(
  p_doctor_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.doctor_absences x
    where x.doctor_id = p_doctor_id
      and tstzrange(x.starts_at, x.ends_at, '[)')
          && tstzrange(p_starts_at, p_ends_at, '[)')
  );
$$;

grant execute on function public.is_doctor_closed(uuid, timestamptz, timestamptz)
  to anon, authenticated;

-- Booking has to respect a closure too, or a patient holding a stale page
-- could still post a time the practitioner has just closed.
drop policy if exists "patient appointments create" on public.appointments;

create policy "patient appointments create" on public.appointments
  for insert with check (
    auth.uid() = patient_id
    and start_at >= now() + public.booking_lead_time()
    and exists (
      select 1 from public.doctor_availability av
      where av.doctor_id = appointments.doctor_id
        and av.status = 'open'
        and appointments.start_at >= av.start_at
        and appointments.end_at <= av.end_at
    )
    and not public.is_doctor_closed(
      appointments.doctor_id, appointments.start_at, appointments.end_at
    )
  );

/**
 * The appointments a proposed closure would cover.
 *
 * A practitioner marking a holiday needs to know who is already booked into
 * it before they commit, because those bookings survive the closure and the
 * people behind them need telling. Returns only the caller's own diary.
 */
create or replace function public.appointments_in_period(
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns table (
  appointment_id uuid,
  start_at timestamptz,
  patient_name text,
  patient_phone text
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.start_at, p.full_name, p.phone
  from public.appointments a
  join public.profiles p on p.id = a.patient_id
  where a.doctor_id = auth.uid()
    and a.status in ('requested', 'confirmed')
    and tstzrange(a.start_at, a.end_at, '[)')
        && tstzrange(p_starts_at, p_ends_at, '[)')
  order by a.start_at;
$$;

-- PostgreSQL grants EXECUTE on a new function to PUBLIC, so naming
-- `authenticated` adds nothing on its own: the revoke is what limits it. The
-- function keys off auth.uid() and so returns nothing to a caller without a
-- subject, but a practitioner's diary should not be reachable at all.
revoke all on function public.appointments_in_period(timestamptz, timestamptz) from public;
grant execute on function public.appointments_in_period(timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- The life of an appointment
--
-- Every booking arrives as 'requested' and, until now, stayed there: nothing
-- in the schema or the interface ever moved it. A patient saw "requested"
-- for a consultation they had already attended, and a practitioner had no way
-- to say "yes, come" — the one thing a cabinet does with a booking request.
--
-- Giving the two sides that power meant first taking away power they already
-- had. "A party to this appointment may update their own row" sounds like a
-- rule and is not one: it says who may write, never what they may write. A
-- patient could post a booking that satisfied every insert check — inside an
-- open block, outside a closure, past the lead time — and then UPDATE
-- start_at to three in the morning, or hand the row to a different
-- practitioner, because an UPDATE never passes the insert policy. The
-- practitioner's own policy was wider still: it would have accepted a new
-- patient_id.
--
-- A policy cannot express the fix, because a policy sees one row at a time —
-- USING is given the old row, WITH CHECK the new one, and neither can compare
-- them. "These columns may not change" needs both at once, which is a trigger.
-- ---------------------------------------------------------------------------

create or replace function public.guard_appointment_update()
returns trigger
language plpgsql
as $$
declare
  actor uuid := auth.uid();
begin
  -- Nothing below constrains the service role or a migration. Row-level
  -- security does not constrain them either, so a check here would be
  -- comfort rather than safety — and a caller the policies let through
  -- always has a subject, because every policy on this table compares
  -- auth.uid() to a column.
  if actor is null then
    return new;
  end if;

  -- Who, when, and for how long are settled when the appointment is made.
  -- Changing one means cancelling and booking again, so the new time goes
  -- through the insert policy instead of around it.
  if new.id <> old.id
     or new.patient_id <> old.patient_id
     or new.doctor_id <> old.doctor_id
     or new.start_at <> old.start_at
     or new.end_at <> old.end_at
     or new.created_at <> old.created_at
  then
    raise exception
      'an appointment''s time and parties cannot be changed; cancel and book again'
      using errcode = 'check_violation';
  end if;

  -- The reason for the visit is the patient's own account of why they are
  -- coming. A practitioner records their findings in a document, not by
  -- editing what the patient said.
  if coalesce(new.reason, '') <> coalesce(old.reason, '')
     and actor <> old.patient_id
  then
    raise exception 'only the patient may change the reason for a visit'
      using errcode = 'check_violation';
  end if;

  if new.status = old.status then
    return new;
  end if;

  -- Cancelled, attended and missed are endings. After one of them the row is
  -- a record of what happened, and a record that can still be rewritten is
  -- not worth keeping.
  if old.status in ('cancelled', 'completed', 'no_show') then
    raise exception 'this appointment is closed and its outcome cannot change'
      using errcode = 'check_violation';
  end if;

  if actor = old.patient_id then
    -- A patient may withdraw, and only withdraw: whether they turned up is
    -- the practitioner's observation, not the patient's claim.
    if new.status <> 'cancelled' then
      raise exception 'a patient may only cancel an appointment'
        using errcode = 'check_violation';
    end if;
    -- Cancelling is allowed up to the minute it starts — a late cancellation
    -- is still far better for the cabinet than silence. Afterwards it is
    -- something that happened, and only the practitioner can say what.
    if old.start_at <= now() then
      raise exception 'this appointment has already started and cannot be cancelled'
        using errcode = 'check_violation';
    end if;

  elsif actor = old.doctor_id then
    -- 'requested' is what a booking arrives as; a practitioner cannot put one
    -- back to undecided once they have answered it.
    if new.status = 'requested' then
      raise exception 'an appointment cannot be returned to requested'
        using errcode = 'check_violation';
    end if;
    -- Attendance is an observation about a consultation that has begun, not a
    -- prediction: tomorrow's patient has not failed to arrive yet.
    if new.status in ('completed', 'no_show') and old.start_at > now() then
      raise exception
        'an appointment cannot be completed or marked missed before it starts'
        using errcode = 'check_violation';
    end if;

  else
    raise exception 'not a party to this appointment'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create or replace trigger guard_appointment_update
  before update on public.appointments
  for each row execute function public.guard_appointment_update();

-- The policies still decide who may write at all; they are restated here with
-- an explicit WITH CHECK so the intent is on the page rather than inherited
-- from USING, and so the pair reads as "a party, and only to their own row".
drop policy if exists "patient appointments update" on public.appointments;
drop policy if exists "patient appointments cancel" on public.appointments;
drop policy if exists "doctor appointments update" on public.appointments;

create policy "patient appointments cancel" on public.appointments
  for update using (auth.uid() = patient_id)
  with check (auth.uid() = patient_id);

create policy "doctor appointments decide" on public.appointments
  for update using (auth.uid() = doctor_id)
  with check (auth.uid() = doctor_id);

-- "Who cancelled my appointment, and when?" is the same kind of question as
-- "who saw my file?", and deserves the same answer. Only outcomes are logged;
-- a reason reworded by the patient is not an event anyone will ask about.
create or replace function public.log_appointment_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
    values (
      auth.uid(),
      'appointment.' || new.status,
      'appointment',
      new.id,
      jsonb_build_object(
        'from', old.status,
        'to', new.status,
        'doctor_id', new.doctor_id,
        'patient_id', new.patient_id,
        'start_at', new.start_at,
        -- Whether the actor was the patient, the practitioner or neither is
        -- the first thing anyone reading this back wants to know.
        'by', case
                when auth.uid() = new.patient_id then 'patient'
                when auth.uid() = new.doctor_id then 'doctor'
                else 'system'
              end
      )
    );
  end if;
  return new;
end;
$$;

create or replace trigger appointments_status_audit
  after update on public.appointments
  for each row execute function public.log_appointment_status_change();

-- ---------------------------------------------------------------------------
-- Becoming a practitioner
--
-- Until now there was no way to. `doctor_profiles` had exactly one policy —
-- the public read of verified practitioners — and so no doctor could create a
-- profile, and a doctor whose profile someone else had inserted could not
-- read it until it was verified. The practitioner's own pages asked
-- `doctor_profiles` for their row, got nothing back, and told them their
-- account was not attached to a practitioner profile. The product could not
-- onboard the people it exists for.
--
-- Self-registration is therefore a request, not an admission: a profile is
-- created unverified, stays out of search, and cannot be booked. What a
-- practitioner may not do is wave themselves through, which is the one thing
-- a policy cannot express — `verified` must be compared before and after, so
-- it is frozen by a trigger.
-- ---------------------------------------------------------------------------

create policy "doctor reads own profile" on public.doctor_profiles
  for select using (auth.uid() = id);

create policy "doctor updates own profile" on public.doctor_profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

create or replace function public.guard_doctor_profile_update()
returns trigger
language plpgsql
as $$
begin
  -- As with appointments, a null subject is the service role or a migration,
  -- which row-level security does not constrain either. Verification is
  -- granted from outside the application; this is the door it comes through.
  if auth.uid() is null then
    return new;
  end if;

  if new.id <> old.id or new.verified <> old.verified then
    raise exception 'a practitioner cannot verify themselves'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create or replace trigger guard_doctor_profile_update
  before update on public.doctor_profiles
  for each row execute function public.guard_doctor_profile_update();

/**
 * Registering as a practitioner, or correcting one's own details later.
 *
 * One call so that the profile and the account's role move together, and so
 * `verified` is never among the columns the caller supplies: a second
 * registration edits the details and leaves verification exactly as an
 * administrator left it.
 */
create or replace function public.register_practitioner(
  p_display_name text,
  p_specialty text,
  p_city text,
  p_bio text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  name text := nullif(btrim(p_display_name), '');
  specialty text := nullif(btrim(p_specialty), '');
  city text := nullif(btrim(p_city), '');
begin
  if uid is null then
    raise exception 'sign in before registering as a practitioner'
      using errcode = 'insufficient_privilege';
  end if;
  if name is null or specialty is null or city is null then
    raise exception 'a practitioner needs a name, a specialty and a city'
      using errcode = 'check_violation';
  end if;

  insert into public.doctor_profiles (id, display_name, specialty, city, bio, verified)
  values (uid, name, specialty, city, nullif(btrim(coalesce(p_bio, '')), ''), false)
  on conflict (id) do update
    set display_name = excluded.display_name,
        specialty = excluded.specialty,
        city = excluded.city,
        bio = excluded.bio;

  update public.profiles set role = 'doctor' where id = uid and role = 'patient';
end;
$$;

revoke all on function public.register_practitioner(text, text, text, text) from public;
grant execute on function public.register_practitioner(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- What an account may say about itself
--
-- `own profile update` let anyone write any column of their own row, `role`
-- among them — including 'platform_admin'. Nothing in this schema grants
-- anything on the strength of `role` today, so it was not a way in; it was a
-- loaded gun, and the first policy written as `role = 'platform_admin'` would
-- have fired it. Self-service covers exactly one promotion, patient to
-- practitioner, and that is all this allows.
-- ---------------------------------------------------------------------------

create or replace function public.guard_profile_update()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.id <> old.id then
    raise exception 'a profile cannot change hands'
      using errcode = 'check_violation';
  end if;

  if new.role <> old.role
     and not (old.role = 'patient' and new.role = 'doctor')
  then
    raise exception 'an account cannot grant itself this role'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create or replace trigger guard_profile_update
  before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Anyone may now register, so "a practitioner exists" stops being the same
-- statement as "a practitioner may be booked". An unverified profile is
-- hidden from search and its pages 404, which made it unreachable in
-- practice; the insert policy now says so outright, because a doctor who can
-- take a booking can read the documents the patient attaches to it, and that
-- must never rest on a page returning the right status code.
/**
 * Whether this practitioner may be booked at all.
 *
 * A security definer function rather than a subquery on `doctor_profiles`,
 * even though the subquery would work today: a patient sees exactly the
 * verified practitioners, so `exists` would already mean `verified`. It would
 * mean that by coincidence. The closure check in this file was written as a
 * plain subquery for the same reason and was a no-op, because a patient
 * cannot see closures — and the next hand to widen the public read of
 * practitioners would turn this one into a no-op in the dangerous direction,
 * silently. Asking a function that runs as its owner means the answer does
 * not depend on who is asking.
 */
create or replace function public.is_doctor_bookable(p_doctor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.doctor_profiles d
    where d.id = p_doctor_id and d.verified
  );
$$;

grant execute on function public.is_doctor_bookable(uuid) to anon, authenticated;

drop policy if exists "patient appointments create" on public.appointments;

create policy "patient appointments create" on public.appointments
  for insert with check (
    auth.uid() = patient_id
    and start_at >= now() + public.booking_lead_time()
    and public.is_doctor_bookable(appointments.doctor_id)
    and exists (
      select 1 from public.doctor_availability av
      where av.doctor_id = appointments.doctor_id
        and av.status = 'open'
        and appointments.start_at >= av.start_at
        and appointments.end_at <= av.end_at
    )
    and not public.is_doctor_closed(
      appointments.doctor_id, appointments.start_at, appointments.end_at
    )
  );

-- `clinics` has row-level security and, like `doctor_availability` before it,
-- no policies at all: unreadable by everyone. Nothing reads it yet, which is
-- the only reason it has not been noticed. A verified clinic is public
-- information, the same as a verified practitioner.
create policy "verified clinics public read" on public.clinics
  for select using (verified = true);

-- ---------------------------------------------------------------------------
-- Finding a practitioner
--
-- The search page listed the first fifty verified practitioners in the
-- country and offered no way to narrow them, which for a patient in Oujda
-- looking for a dermatologist is not a search. Filtering happens here rather
-- than in the page so that the name match can be accent-folded: a patient
-- half-remembering a name is the normal case, and "benali", "Bénali" and
-- "BENALI" all have to reach Dr Amina Benali.
--
-- `fold` does that without `unaccent`, which would be another extension to
-- install on a self-hosted Postgres for the sake of thirty characters.
-- ---------------------------------------------------------------------------

create or replace function public.fold(value text)
returns text
language sql
immutable
strict
as $$
  select lower(translate(
    value,
    'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿ',
    'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOOooooooUUUUuuuuYyy'
  ));
$$;

grant execute on function public.fold(text) to anon, authenticated;

/**
 * Verified practitioners matching any combination of the three filters.
 *
 * Deliberately *not* security definer: the public read policy already limits
 * this to verified practitioners, so running as the caller means the search
 * cannot show more than the caller could read anyway. `verified` is named in
 * the predicate as well, because a practitioner can read their own
 * unverified row and should not find themselves in a patient's search.
 */
create or replace function public.search_practitioners(
  p_specialty text default null,
  p_city text default null,
  p_name text default null
)
returns table (
  id uuid,
  display_name text,
  specialty text,
  city text,
  bio text
)
language sql
stable
set search_path = public
as $$
  select d.id, d.display_name, d.specialty, d.city, d.bio
  from public.doctor_profiles d
  where d.verified
    and (nullif(btrim(coalesce(p_specialty, '')), '') is null
         or d.specialty = btrim(p_specialty))
    and (nullif(btrim(coalesce(p_city, '')), '') is null
         or d.city = btrim(p_city))
    and (nullif(btrim(coalesce(p_name, '')), '') is null
         or public.fold(d.display_name) like '%' || public.fold(btrim(p_name)) || '%')
  order by d.display_name
  limit 100;
$$;

grant execute on function public.search_practitioners(text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Telling people things
--
-- Nothing was ever sent to anyone. A practitioner confirmed a booking and the
-- patient found out by visiting the site again; a patient cancelled and the
-- cabinet found out when nobody arrived. For a market where the no-show is
-- the problem a booking platform exists to solve, that was the largest hole
-- left in it.
--
-- This is an outbox, not a sender. Rows are written by triggers rather than
-- by pages, because a notification that depends on every code path
-- remembering to send it is a notification that will be missed — and the one
-- that gets missed is the cancellation, which is the one that matters. A
-- separate process drains the table; until an SMS provider is configured it
-- logs, and the rows pile up harmlessly rather than being lost.
--
-- A row holds a template name and a payload, never a rendered sentence. The
-- French is composed in TypeScript for the same reason wall-clock times are
-- converted there: `Intl` and the server's copy of the time-zone database
-- disagree about Morocco, and a reminder that says 14:00 for a 15:00
-- consultation is worse than no reminder at all.
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete cascade,
  -- Which message this is. Rendered by apps/web/lib/notifications/templates.ts.
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  channel text not null default 'sms' check (channel in ('sms')),
  -- Copied at enqueue time: a patient who changes their number later should
  -- not have yesterday's unsent reminder follow them to it.
  to_phone text,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- One of each message per appointment. This is what makes the triggers safe
-- to re-enter and the reminder sweep safe to run as often as you like: a
-- second attempt to enqueue the same thing does nothing.
create unique index if not exists notifications_once_per_appointment
  on public.notifications (appointment_id, template)
  where appointment_id is not null;

create index if not exists notifications_pending
  on public.notifications (created_at)
  where status = 'pending';

alter table public.notifications enable row level security;

-- Someone may read what was sent to them, and nothing else. There is no
-- insert or update policy at all: rows are written by triggers and by the
-- drain, both of which run outside row-level security, and a notification a
-- recipient could edit would not be worth sending.
create policy "own notifications read" on public.notifications
  for select using (auth.uid() = recipient_id);

/**
 * Queues one message, unless it is already queued.
 *
 * The phone number is looked up here rather than passed in, so no caller can
 * aim a notification at a number of its choosing.
 */
create or replace function public.enqueue_notification(
  p_recipient_id uuid,
  p_appointment_id uuid,
  p_template text,
  p_payload jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  phone text;
begin
  select p.phone into phone from public.profiles p where p.id = p_recipient_id;

  insert into public.notifications
    (recipient_id, appointment_id, template, payload, to_phone)
  values (p_recipient_id, p_appointment_id, p_template, p_payload, phone)
  on conflict do nothing;
end;
$$;

revoke all on function
  public.enqueue_notification(uuid, uuid, text, jsonb) from public;

/**
 * What each side needs to be told as an appointment moves.
 *
 * The practitioner hears about arrivals and departures — a new request, and a
 * cancellation that has just freed a slot. The patient hears about decisions
 * made about them. Nobody is told what they did themselves.
 */
create or replace function public.notify_appointment_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  details jsonb;
begin
  details := jsonb_build_object(
    'start_at', new.start_at,
    'doctor_name', (select d.display_name from public.doctor_profiles d where d.id = new.doctor_id),
    'patient_name', (select p.full_name from public.profiles p where p.id = new.patient_id)
  );

  if tg_op = 'INSERT' then
    perform public.enqueue_notification(
      new.doctor_id, new.id, 'appointment.requested', details);
    return new;
  end if;

  if new.status = old.status then
    return new;
  end if;

  if new.status = 'confirmed' then
    perform public.enqueue_notification(
      new.patient_id, new.id, 'appointment.confirmed', details);

  elsif new.status = 'cancelled' then
    -- Who is told depends on who walked away, which is the whole point of
    -- recording the actor.
    if actor = new.patient_id then
      perform public.enqueue_notification(
        new.doctor_id, new.id, 'appointment.cancelled_by_patient', details);
    else
      perform public.enqueue_notification(
        new.patient_id, new.id, 'appointment.cancelled_by_doctor', details);
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger notify_appointment_change
  after insert or update on public.appointments
  for each row execute function public.notify_appointment_change();

/**
 * Tells the patients a closure has just landed on.
 *
 * Their appointments survive a closure deliberately — those people have a
 * place in the diary — so this does not cancel anything. It says the cabinet
 * is closed and will be in touch, which is the honest message, and it means
 * the practitioner's list of people to call is no longer the only thing
 * standing between a patient and a locked door.
 */
create or replace function public.notify_closure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  affected record;
begin
  for affected in
    select a.id, a.patient_id, a.start_at
    from public.appointments a
    where a.doctor_id = new.doctor_id
      and a.status in ('requested', 'confirmed')
      and tstzrange(a.start_at, a.end_at, '[)')
          && tstzrange(new.starts_at, new.ends_at, '[)')
  loop
    perform public.enqueue_notification(
      affected.patient_id, affected.id, 'closure.affected',
      jsonb_build_object(
        'start_at', affected.start_at,
        'doctor_name', (select d.display_name from public.doctor_profiles d
                        where d.id = new.doctor_id)
      ));
  end loop;

  return new;
end;
$$;

create or replace trigger notify_closure
  after insert on public.doctor_absences
  for each row execute function public.notify_closure();

/**
 * Queues tomorrow's reminders.
 *
 * Called by the drain, so there is one thing to schedule rather than two. The
 * unique index makes it idempotent: running it every ten minutes queues each
 * reminder once, and a run that is missed catches up on the next one.
 *
 * Deliberately not sent for a request still awaiting an answer — reminding
 * someone of a consultation the cabinet has not agreed to would be worse than
 * silence.
 */
create or replace function public.enqueue_due_reminders(
  p_within interval default interval '24 hours'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  queued integer := 0;
  appointment record;
begin
  for appointment in
    select a.id, a.patient_id, a.start_at,
           (select d.display_name from public.doctor_profiles d where d.id = a.doctor_id)
             as doctor_name
    from public.appointments a
    where a.status = 'confirmed'
      and a.start_at > now()
      and a.start_at <= now() + p_within
      and not public.is_doctor_closed(a.doctor_id, a.start_at, a.end_at)
  loop
    perform public.enqueue_notification(
      appointment.patient_id, appointment.id, 'appointment.reminder',
      jsonb_build_object(
        'start_at', appointment.start_at,
        'doctor_name', appointment.doctor_name
      ));
    queued := queued + 1;
  end loop;

  return queued;
end;
$$;

revoke all on function public.enqueue_due_reminders(interval) from public;

/**
 * Hands the drain the next batch and marks it in flight.
 *
 * `for update skip locked` so two drains running at once cannot send the same
 * message twice — the second one simply takes different rows. A message is
 * marked sent only once a provider has accepted it, so a drain that dies
 * mid-batch leaves its rows pending rather than silently swallowing them.
 */
create or replace function public.claim_notifications(p_limit integer default 50)
returns setof public.notifications
language sql
volatile
security definer
set search_path = public
as $$
  with batch as (
    select n.id from public.notifications n
    where n.status = 'pending' and n.attempts < 5
    order by n.created_at
    limit greatest(1, least(coalesce(p_limit, 50), 500))
    for update skip locked
  )
  update public.notifications n
     set attempts = n.attempts + 1
   where n.id in (select id from batch)
  returning n.*;
$$;

revoke all on function public.claim_notifications(integer) from public;

create or replace function public.mark_notification_sent(p_id bigint)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.notifications
     set status = 'sent', sent_at = now(), last_error = null
   where id = p_id;
$$;

revoke all on function public.mark_notification_sent(bigint) from public;

/**
 * Records a failure.
 *
 * A row goes back to pending so the next drain retries it, until five
 * attempts have been made — one unreachable number must not hold up the queue
 * behind it forever. `p_permanent` is for a refusal that will never become a
 * success, a malformed number being the usual one: retrying that four more
 * times is just four more delays.
 */
create or replace function public.mark_notification_failed(
  p_id bigint,
  p_error text,
  p_permanent boolean default false
)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.notifications
     set status = case
                    when p_permanent or attempts >= 5 then 'failed'
                    else 'pending'
                  end,
         last_error = left(coalesce(p_error, 'unknown'), 500)
   where id = p_id;
$$;

revoke all on function
  public.mark_notification_failed(bigint, text, boolean) from public;

-- ---------------------------------------------------------------------------
-- Who may reach the tables at all
--
-- Row-level security decides which rows; a plain GRANT decides whether the
-- role can see the table in the first place, and these two are easy to
-- confuse because Supabase hands out the grants itself. Applied to a Supabase
-- project this section changes nothing. Applied to any other PostgreSQL —
-- self-hosted, or the one the tests run against — it is the difference
-- between a working database and one where every query is "permission denied
-- for table doctor_profiles".
--
-- It is last in the file on purpose: `all tables in schema public` grants on
-- the tables that exist when it runs, so it has to run once everything does.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon noinherit nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated noinherit nologin;
  end if;
end
$$;

grant usage on schema public to anon, authenticated;

-- Wide on purpose, and safe only because of row-level security: every table
-- here has it enabled, so a grant without a matching policy reaches nothing.
-- `audit_logs` and `notifications` are the proof — both are granted below and
-- neither has a policy that lets anyone write to them.
grant select on all tables in schema public to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
