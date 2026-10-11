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
