# Tabib.ma V5

Appointment booking and medical-document exchange for Morocco.
Next.js + Supabase + Vercel.

## What works today

- **Search** verified practitioners by specialty and city.
- **Appointments**, with overlapping bookings made impossible by the database
  itself (a GiST exclusion constraint), not by application checks that can
  lose a race.
- **Medical documents**: a patient uploads analyses, radiology images or
  insurance forms, shares them with a practitioner by attaching them to an
  appointment, and withdraws the share at any time. A practitioner sends a
  prescription or report back into the patient's record.
- **Phone sign-in** by one-time SMS code, because the mobile number is how
  patients are identified here and many have no email address.

## Running it

```bash
npm install
cp .env.example .env.local        # fill in the Supabase values
npm run dev                       # http://localhost:3000
```

Create a Supabase project, then run `supabase/schema.sql` against it once
(SQL Editor, or `psql` with the project's connection string). It creates the
tables, the row-level security policies, the private `medical-documents`
Storage bucket and the audit trigger.

Two settings in the Supabase dashboard are needed for sign-in to work:
**Authentication → Providers → Phone** must be enabled, with an SMS provider
configured. Without one, `signInWithOtp` returns an error and nobody can log
in.

## How document access is decided

Every rule lives in the database, so a mistake in a page or an API route
cannot hand one patient's scans to another:

- A document **belongs to a patient**, always — including a prescription a
  doctor writes, which is the patient's record held on their behalf.
- A doctor sees a document **only through an appointment of their own**.
  Attaching a document to an appointment is what shares it; detaching is what
  stops sharing. There is no separate permission list to drift out of step
  with the appointments themselves.
- Files sit in a **private** Storage bucket under `<patient_id>/<uuid>`, with
  policies mirroring the table's. A row grants nothing on its own, and neither
  does an object; both have to agree.
- Downloads are short-lived signed URLs minted only for a caller the policies
  already allow. Nothing is proxied through the app server.
- Every create, share, un-share and delete lands in `audit_logs` with its
  actor, which is the only way to answer "who saw my file?" later.

Two details worth knowing about:

**Uploads are inspected server-side.** The bucket's MIME allowlist believes
the `Content-Type` the client declares, so a renamed HTML page would satisfy
it. `/api/documents` reads the first bytes of each file instead, discards the
declared type, and renames the file to match what it actually is — a
photograph sent as `results.pdf` is stored as `results.jpg`. SVG is refused
despite being an image: it can carry script and no medical workflow needs one.

**Deleting is a function, not an UPDATE.** The read policies hide rows with
`deleted_at` set, so a patient setting that column through a plain update
would be writing a row they can no longer see, which PostgreSQL rejects.
`soft_delete_document()` checks ownership, marks the row and returns the
object key so the bytes can be removed — "delete" has to mean the file is
gone, while the row survives so a doctor's record of what informed a
consultation is not rewritten.

## Tests

```bash
npm test          # 85 tests
npm run typecheck
npm run build
```

The suite has two halves:

- **Row-level security** (`supabase/test/rls.test.ts`) applies
  `supabase/schema.sql` unchanged to a real PostgreSQL server and exercises
  the policies as the `authenticated` role — as superuser every policy is
  bypassed and the suite would pass while proving nothing.
  `supabase/test/harness.sql` supplies the `auth` and `storage` schemas
  Supabase provides, including `auth.uid()` reading the JWT subject from the
  session.
- **Application logic**: upload inspection, filename sanitisation, phone
  normalisation, and the upload route's sequencing.

The RLS half needs a PostgreSQL 16 with `pgcrypto` and `btree_gist`, reached
through the usual `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` variables.
CI starts one as a service container; locally, point them at any instance you
have. Without one, those tests fail to connect — they do not silently skip.

## Layout

```
supabase/schema.sql          Tables, RLS policies, Storage bucket, audit trigger
supabase/test/               The policies, run against real PostgreSQL
apps/web/app/                Pages and API routes
apps/web/lib/documents/      Upload inspection and document vocabulary
apps/web/lib/morocco/        Phone numbers in E.164
apps/web/components/         Uploader and document list
```

## Not done yet

- **Appointment booking from the UI.** The schema and the overlap constraint
  are there; the patient-facing flow to pick a slot is not.
- **Arabic.** The interface is French only. The document and appointment data
  carry nothing language-specific, so this is a presentation change, but it is
  a real gap in this market.
- **Practitioner onboarding.** `doctor_profiles.verified` is a flag someone
  sets by hand; nothing checks an INPE number against the CNOM register.
- **Virus scanning.** Files are type-checked, not scanned.
- **The browser flows are untested.** The RLS policies and the upload route
  are covered; signing in and uploading through the interface has not been
  exercised end to end, because that needs a live Supabase project.

## Important

Not certified for real health data. Legal and privacy review, provider
contracts, backup and disaster recovery, monitoring, and penetration testing
are all required before this holds a real patient's records.
