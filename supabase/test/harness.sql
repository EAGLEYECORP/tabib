-- Supabase stand-in, for running the schema and its policies against a plain
-- PostgreSQL server.
--
-- Supabase provides `auth` and `storage` as part of the platform. This file
-- recreates just enough of them -- the same function signatures and the same
-- `auth.uid()` behaviour, reading the signed-in user from the JWT claims on
-- the session -- so that `supabase/schema.sql` can be applied unchanged and
-- its row-level security policies exercised for real.
--
-- Test scaffolding only. Never applied to a Supabase project, which has the
-- genuine articles.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create schema if not exists auth;
create schema if not exists storage;

create table auth.users(
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  -- Supabase puts whatever the client passed at sign-up here; the
  -- profile-creation trigger reads a name out of it.
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- Supabase derives the caller from the `sub` claim of the request JWT, which
-- it puts on the session as `request.jwt.claims`. Reading it the same way
-- means a test can become a given user with a single `set_config`.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(current_setting('request.jwt.claim.role', true), 'authenticated');
$$;

create table storage.buckets(
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

create table storage.objects(
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

-- Splits an object key into path segments, as Supabase does; policies use the
-- first segment to identify the owning patient.
create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select string_to_array(regexp_replace(name, '/[^/]*$', ''), '/');
$$;

-- The role application requests run as. Policies do not apply to superusers,
-- so the tests must connect as this one for any of it to mean anything.
-- Supabase ships two: `anon` for a visitor who has not signed in, and
-- `authenticated` for one who has. Both exist here because the schema grants
-- to both, and because "can a signed-out visitor see this?" is a question the
-- tests need to be able to ask.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end
$$;

grant usage on schema public, auth, storage to authenticated, anon;
