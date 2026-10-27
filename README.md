# Tabib.ma V5

Appointment booking and medical-document exchange for Morocco.
Next.js + Supabase + Vercel.

## What works today

- **Search** verified practitioners by specialty, city and name — filters that
  live in the URL, so "cardiologues à Casablanca" is a link. A half-remembered
  name is matched without its accents, because that is how people type.
- **Practitioner sign-up**: a doctor registers themselves, opens hours
  straight away, and goes live once Tabib.ma verifies the profile. Until then
  they are out of search and unbookable.
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
- **Text messages** for the things people need to know without visiting the
  site: a new request to the practitioner, a confirmation or a cancellation to
  the patient, a cancellation back to the cabinet because a slot has just
  freed, a reminder the day before, and a notice when a closure lands on
  someone. Queued by the database, not by the pages.

## Running it

```bash
npm install
cp .env.example .env.local        # fill in the three Supabase values
npm run db:apply "$DATABASE_URL"  # tables, policies, bucket, triggers
npm run db:seed                   # four practitioners with open hours
npm run dev                       # http://localhost:3000
```

`db:apply` is also how you apply a change to a database that already has the
previous version: `schema.sql` and `seed.sql` are both written to be re-run.
The seed exists because a fresh database leaves every page correct and empty —
the search finds nobody, so there is no profile to open, so there is no slot
to book. It creates four verified practitioners in four cities with hours over
the coming fortnight, which is enough to walk the whole patient path. Those
accounts cannot be signed in as: sign-in is a code sent to the number on the
`auth.users` row, and the seeded rows deliberately have no number on them.

Applied to a Supabase project, the schema's last section changes nothing.
Applied to any other PostgreSQL it creates the `anon` and `authenticated`
roles and grants them the tables — without which every query comes back
"permission denied" and it looks as though the schema is broken.

One setting in the Supabase dashboard is needed before anyone can sign in:
**Authentication → Providers → Phone**, with an SMS provider configured.
Without one, `signInWithOtp` returns an error and nobody can log in.

### Sending the messages

`POST /api/notifications` drains the outbox, and queues tomorrow's reminders
while it is there, so there is one thing to schedule rather than two:

```bash
NOTIFY_SECRET=$(openssl rand -hex 32)   # put it in .env.local
npm run notify                          # or point a cron at the endpoint
```

Every ten minutes is a reasonable interval, and running it more often is
harmless — see **Telling people things** below for why. With no
`SMS_PROVIDER` set the messages go to the server log, so the whole chain works
before anyone has an SMS account; set `SMS_PROVIDER=twilio` and its three
credentials to actually send.

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

## Who may become a practitioner

`doctor_profiles` had exactly one policy: the public read of verified
practitioners. So no doctor could create a profile, and a doctor whose profile
someone else had inserted could not read their own row until it was verified —
their own pages asked for it, got nothing, and told them their account was not
attached to a practitioner profile. The product could not onboard the people
it exists for.

Registering is now a request rather than an admission. `register_practitioner`
always writes the profile unverified and never takes `verified` as an
argument, so registering again to correct a city cannot cost a practitioner
their verification. Waving yourself through is the one thing a policy cannot
express — `verified` has to be compared before and after — so a trigger
freezes it.

Anyone being able to register means "a practitioner exists" stops being the
same statement as "a practitioner may be booked", and the appointment insert
policy now says so outright. It had been true only by accident: an unverified
profile is hidden from search and its pages 404, so nobody could reach one.
A practitioner who can take a booking can read the documents a patient
attaches to it, and that must never rest on a page returning the right status
code.

Two related things were fixed in passing. `own profile update` let anyone
write any column of their own row, `role` among them, including
`platform_admin`; nothing in the schema grants anything on the strength of
`role` today, so it was not a way in — it was a loaded gun, and the first
policy written as `role = 'platform_admin'` would have fired it. And
PostgreSQL grants `EXECUTE` on a new function to `PUBLIC`, which made every
`grant execute … to authenticated` in this file decorative; the `revoke`
beside each one is what actually limits it.

## Telling people things

Nothing was ever sent to anyone. A practitioner confirmed a booking and the
patient found out by visiting the site again; a patient cancelled and the
cabinet found out when nobody arrived.

`public.notifications` is an outbox, and the rows are written by **triggers
rather than by pages**. A notification that depends on every code path
remembering to send it is a notification that will be missed, and the one that
gets missed is the cancellation — the message with the most value in it.
Nobody is told what they did themselves, which is why the trigger looks at
`auth.uid()`: the same cancellation notifies the patient or the practitioner
depending on which of them walked away.

A row holds a template name and a payload, never a rendered sentence. The
French is composed in `apps/web/lib/notifications/templates.ts` for the same
reason wall-clock times are converted there — a reminder that says 14:00 for a
15:00 consultation is worse than no reminder, and the server's copy of the
time-zone database is exactly the thing that gets Morocco wrong. The messages
are also written without accents, because one accented character takes a text
message from 160 characters to 70 and would split every one of them in two; a
test holds each to a single segment with a realistic name in it.

Running the drain more often than necessary is harmless, by construction:
reminders are queued under a unique index, claiming uses `for update skip
locked` so two overlapping runs take different rows, and a message is marked
sent only once a provider has accepted it — so a run that dies mid-batch
leaves its rows pending rather than swallowing them. A number the provider
will never accept is given up on at once instead of being retried five times
in front of everything else.

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
npm test          # 272 tests
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
supabase/schema.sql          Tables, RLS policies, Storage bucket, triggers
supabase/seed.sql            Four practitioners, so the pages are not empty
supabase/test/               The policies, run against real PostgreSQL
apps/web/app/                Pages and API routes
apps/web/lib/booking/        Slots, wall-clock conversion, appointment status
apps/web/lib/documents/      Upload inspection and document vocabulary
apps/web/lib/notifications/  Message text and the SMS provider layer
apps/web/lib/morocco/        Phone numbers, specialties and cities
apps/web/components/         Uploader and document list
```

## Not done yet

- **No recurrence model.** Repeating a weekly pattern writes concrete blocks,
  so changing "every Tuesday" means removing and reopening them. Fine for a
  season's hours; it would not scale to a cabinet planning a year.
- **Practitioner verification is still a hand-set flag.** A doctor can now
  register themselves, but someone has to set `verified` with SQL, and nothing
  checks an INPE number against the CNOM register. There is no screen for it.
- **Next.js has a published advisory** at the version in `package.json`, which
  pins `latest` rather than a version — so what you get depends on when you
  install. Both are worth fixing before this is deployed.
- **Arabic.** The interface is French only. The document and appointment data
  carry nothing language-specific, so this is a presentation change, but it is
  a real gap in this market.
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
