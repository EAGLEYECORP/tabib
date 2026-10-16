# Tabib.ma V5

Appointment booking and medical-document exchange for Morocco.
Next.js + Supabase + Vercel.

## What works today

- **Search** verified practitioners by specialty and city.
- **Closures**: a holiday, Aïd, a conference or a lost afternoon hides the
  slots it covers without deleting the weekly hours underneath — and hands
  back the patients already booked inside it, with their numbers, because
  those appointments survive the closure and those people need telling.
- **Opening hours**: a practitioner opens blocks of consulting time — a date,
  start and end, how long one consultation lasts, optionally repeated weekly —
  and those become bookable slots on their public profile.
- **Booking**: a patient opens a practitioner's profile, sees free slots
  grouped by day, picks one and confirms. Overlapping bookings are impossible
  because the database says so (a GiST exclusion constraint), not because the
  application checked first and hoped — when two patients submit the same slot
  at the same moment, exactly one wins and the other is told to pick again.
- **Answering a booking**: a practitioner confirms or refuses a request, and
  afterwards records whether the patient came. The patient sees "en attente de
  confirmation" rather than a request that sits unanswered forever, and can
  withdraw right up to the minute it starts.
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

## How booking works

Free slots are not a table. A practitioner opens blocks of consulting time in
`doctor_availability`, each with its own consultation length, and
`available_slots()` cuts those into slots, drops anything already taken,
anything in the past, and anything inside the two-hour lead time a cabinet
needs to know someone is coming.

That function runs as its owner on purpose. Working out what is free means
knowing which times are taken, but a patient must never read another
patient's appointments — so the function can see every booking and returns
only times, never who holds them.

Three things had to be fixed before any of this could work:

- `doctor_availability` had row-level security enabled and **no policies at
  all**, which made it unreadable by everyone. No patient could ever have seen
  a free slot.
- **Nothing created the `public.profiles` row** when someone signed in, so a
  first booking failed on a foreign key — a confusing way to learn your
  account is half-created. A trigger on `auth.users` creates it now.
- The appointment insert policy accepted **any timestamp at all**, so a
  patient could have booked a doctor at three in the morning by posting a
  chosen time. It now requires the slot to fall inside an advertised block and
  to respect the lead time.

### One clock, not two

Slots are shown in the cabinet's time zone, not the viewer's, so a patient
booking from Paris sees the hour they are expected in Casablanca. The zone is
resolved through the IANA database rather than a fixed `+01:00`: Morocco sits
on UTC+1 year-round but returns to UTC for the month of Ramadan, so a
hard-coded offset is wrong for several weeks a year.

A practitioner types wall-clock time — "Tuesday, nine to one" — and that is
resolved to an instant in `apps/web/lib/booking/wall-time.ts`, **not** by
PostgreSQL's `AT TIME ZONE`. The reason is worth knowing before anyone
"simplifies" it: every time a patient or doctor *reads* a time, it is
formatted by `Intl`, using the runtime's copy of the time-zone database. If
writing consulted the database server's copy instead, the two could disagree
and a doctor's 09:00 would be shown to a patient as 08:00. That gap is not
hypothetical — the PostgreSQL this was developed against reports
`Africa/Casablanca` as a flat UTC+0 for every date, missing both the
permanent UTC+1 and the Ramadan return. Converting in one place means the two
ends can only ever be wrong together, which is a far smaller problem than
being wrong separately.

`open_availability()` therefore takes absolute instants and never
reinterprets them. Weekly repeats are converted per week from their own
wall-clock time rather than by adding seven days, because across the Ramadan
change those are not the same thing: the clock moves, "nine o'clock" does
not.

## The life of an appointment

Every booking arrives as `requested` and the practitioner answers it:
confirmed, or refused. Once the consultation has begun they record what
happened — effectuée, or the patient did not come. Those three are endings: an
appointment past one of them is a record, and a record that can still be
rewritten is not worth keeping.

Giving the two sides that power meant first taking away power they already
had. "A party to this appointment may update their own row" sounds like a rule
and is not one — it says who may write, never what they may write. A patient
could post a booking that satisfied every insert check, inside an open block
and past the lead time, and then `UPDATE start_at` to three in the morning,
because an UPDATE never passes the insert policy. The same policy would have
accepted a new `doctor_id`, moving the appointment into a practitioner's diary
without their having advertised the time at all. The practitioner's own was
wider still: it would have taken a new `patient_id`.

**A policy cannot express the fix.** A policy sees one row at a time: `USING`
is given the old row, `WITH CHECK` the new one, and neither can compare them.
"These columns may not change" needs both at once, so it is a `BEFORE UPDATE`
trigger — `guard_appointment_update`. Who, when and for how long are settled
when the appointment is made; changing one means cancelling and booking again,
which sends the new time back through the insert policy instead of around it.

The rest of the trigger is about who may say what. A patient may withdraw and
only withdraw — whether they turned up is the practitioner's observation, not
the patient's claim, and a patient cannot cancel a consultation that has
already started to tidy away a missed one. A practitioner cannot mark tomorrow
morning's patient absent, because absence is an observation and not a
prediction. And the reason for the visit stays the patient's own words: a
practitioner records their findings in a document, not by editing what the
patient said.

Status changes land in `audit_logs` alongside the document trail, with whether
it was the patient, the practitioner or the system that made them. "Who
cancelled my appointment?" is the same kind of question as "who saw my file?"
and deserves the same answer.

`apps/web/lib/booking/status.ts` holds the matching view of those rules, so
the interface never offers a button the database is going to refuse — an
action that fails is worse than one that was never offered. It is also where
the English the enum is written in becomes the French a cabinet reads; showing
`no_show` to a practitioner is a bug, not a detail.

## How document access is decided

Every rule lives in the database, so a mistake in a page or an API route
cannot hand one patient's scans to another:

- A document **belongs to a patient**, always — including a prescription a
  doctor writes, which is the patient's record held on their behalf.
Closures work the same way, and carry a trap worth knowing about: the check
that stops a patient booking into a closed period cannot be a plain subquery
in the policy. Closures are private to the practitioner, so a subquery
evaluated as the *patient* sees no rows and concludes nothing is closed —
passing exactly the bookings it exists to refuse. It goes through
`is_doctor_closed()`, which runs as its owner and returns a bare boolean: the
patient learns a time is unavailable, never why.

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
npm test          # 211 tests
npm run typecheck
npm run build
```

The row-level security half needs a PostgreSQL to run against.
`supabase/test/start-postgres.sh` brings up a throwaway one if you do not
already have a server to point `PGHOST`/`PGPORT` at:

```bash
source supabase/test/start-postgres.sh && npm test
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
  normalisation, wall-clock-to-instant conversion across Morocco's Ramadan
  change, slot grouping, and the upload route's sequencing.

The RLS half needs a PostgreSQL 16 with `pgcrypto` and `btree_gist`, reached
through the usual `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` variables.
CI starts one as a service container. Without one, those tests fail to
connect — they do not silently skip.

## Layout

```
supabase/schema.sql          Tables, RLS policies, Storage bucket, audit trigger
supabase/test/               The policies, run against real PostgreSQL
apps/web/app/                Pages and API routes
apps/web/lib/booking/        Slots, wall-clock conversion, appointment status
apps/web/lib/documents/      Upload inspection and document vocabulary
apps/web/lib/morocco/        Phone numbers in E.164
apps/web/components/         Uploader and document list
```

## Not done yet

- **No recurrence model.** Repeating a weekly pattern writes concrete blocks,
  so changing "every Tuesday" means removing and reopening them. Fine for a
  season's hours; it would not scale to a cabinet planning a year.
- **Closures do not notify anyone.** The practitioner is shown who is affected
  and is expected to call them. Nothing is sent automatically, because nothing
  is sent automatically anywhere yet — see SMS below.
- **No SMS.** A confirmed or refused booking changes what the patient sees on
  the site and nothing more: no message, no reminder the day before, no notice
  when a closure affects someone. For a market where no-shows are the problem
  a booking platform exists to solve, this is the largest remaining gap.
- **Arabic.** The interface is French only. The document and appointment data
  carry nothing language-specific, so this is a presentation change, but it is
  a real gap in this market.
- **Practitioner onboarding.** `doctor_profiles.verified` is a flag someone
  sets by hand; nothing checks an INPE number against the CNOM register.
- **Virus scanning.** Files are type-checked, not scanned.
- **The browser flows are untested.** The database rules are covered
  thoroughly — including two patients racing for one slot — and so is the
  upload route. But signing in, picking a slot and uploading *through the
  interface* has not been exercised end to end, because that needs a live
  Supabase project. The pages render and every route returns what it should;
  the click-path has not been walked.

## Important

Not certified for real health data. Legal and privacy review, provider
contracts, backup and disaster recovery, monitoring, and penetration testing
are all required before this holds a real patient's records.
