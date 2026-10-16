import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { weeklyBlocks } from "../../apps/web/lib/booking/wall-time";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Row-level security for medical documents, against a real PostgreSQL server.
 *
 * These rules are the whole safety story of the feature, and they live in the
 * database rather than in application code precisely so that a mistake in a
 * page or an API route cannot leak a patient's scans. Testing them therefore
 * means running them: the queries below go through Postgres as the
 * `authenticated` role with a JWT subject set, exactly as a Supabase request
 * does, so a policy that is too generous fails here.
 *
 * `supabase/test/harness.sql` supplies the `auth` and `storage` schemas that
 * Supabase would provide; `supabase/schema.sql` is applied unchanged.
 */

/**
 * Any PostgreSQL 16 with pgcrypto and btree_gist will do. Locally that tends
 * to be a socket in a scratch directory; in CI it is the service container on
 * localhost, which wants a password. Both are reached through the standard
 * libpq environment variables.
 */
const HOST = process.env.PGHOST ?? "/var/tmp/tabibpg";
const PORT = Number(process.env.PGPORT ?? 55432);
const USER = process.env.PGUSER ?? "postgres";
const PASSWORD = process.env.PGPASSWORD;
const DB = "tabib_rls_test";

const repoRoot = join(__dirname, "..", "..");

function connect(database: string) {
  return new Client({
    host: HOST,
    port: PORT,
    user: USER,
    database,
    ...(PASSWORD ? { password: PASSWORD } : {}),
  });
}

/** A client acting as one signed-in user, subject to RLS. */
class AsUser {
  constructor(
    private readonly client: Client,
    private readonly userId: string,
    /** `anon` for a visitor who has not signed in. */
    private readonly role: "authenticated" | "anon" = "authenticated",
  ) {}

  /**
   * Runs a query as this user. The role is switched to `authenticated` and the
   * JWT subject set for the statement, which is what makes the policies apply
   * — as superuser they would all be bypassed and every test would pass.
   */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.client.query("begin");
    try {
      await this.client.query(`set local role ${this.role}`);
      await this.client.query("select set_config('request.jwt.claim.sub', $1, true)", [
        this.userId,
      ]);
      const result = await this.client.query(sql, params);
      await this.client.query("commit");
      return result.rows as T[];
    } catch (error) {
      await this.client.query("rollback");
      throw error;
    }
  }
}

let admin: Client;
let session: Client;
/** A second connection, so two patients can genuinely race for one slot. */
let rival: Client;

const ids = {
  patientA: "",
  patientB: "",
  doctorA: "",
  doctorB: "",
  apptA: "",
  apptB: "",
};

/** Gives each fixture account its own number, as a real sign-up has. */
let phoneCounter = 1000;

let asPatientA: AsUser;
let asPatientB: AsUser;
let asDoctorA: AsUser;
let asDoctorB: AsUser;

beforeAll(async () => {
  const bootstrap = connect("postgres");
  await bootstrap.connect();
  await bootstrap.query(`drop database if exists ${DB}`);
  await bootstrap.query(`create database ${DB}`);
  await bootstrap.end();

  admin = connect(DB);
  await admin.connect();
  await admin.query(readFileSync(join(repoRoot, "supabase", "test", "harness.sql"), "utf8"));
  await admin.query(readFileSync(join(repoRoot, "supabase", "schema.sql"), "utf8"));

  // The application role must be able to reach the tables at all; RLS then
  // decides which rows. Without the grants every test would fail for the
  // wrong reason.
  await admin.query(`
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant select on all tables in schema public to anon;
    grant select, insert, update, delete on storage.objects to authenticated;
    grant select on storage.buckets to authenticated;
    grant usage, select on all sequences in schema public to authenticated;
  `);

  session = connect(DB);
  await session.connect();
  rival = connect(DB);
  await rival.connect();
}, 60_000);

beforeEach(async () => {
  await admin.query("delete from public.documents");
  await admin.query("delete from public.appointments");
  await admin.query("delete from public.doctor_availability");
  await admin.query("delete from public.audit_logs");
  await admin.query("delete from storage.objects");
  await admin.query("delete from public.doctor_profiles");
  await admin.query("delete from public.profiles");
  await admin.query("delete from auth.users");

  // The profile row is created by the on_auth_user_created trigger, exactly
  // as it is in production; this only fills in the parts sign-up cannot know.
  const makeUser = async (role: string, name: string) => {
    const {
      rows: [user],
    } = await admin.query<{ id: string }>(
      `insert into auth.users (phone, raw_user_meta_data)
       values ($2, jsonb_build_object('full_name', $1::text))
       returning id`,
      [name, `+21260000${String(phoneCounter++).padStart(4, "0")}`],
    );
    await admin.query(
      "update public.profiles set role = $2::public.user_role where id = $1",
      [user.id, role],
    );
    return user.id;
  };

  ids.patientA = await makeUser("patient", "Salma Bennis");
  ids.patientB = await makeUser("patient", "Karim Tazi");
  ids.doctorA = await makeUser("doctor", "Dr Amina Benali");
  ids.doctorB = await makeUser("doctor", "Dr Youssef El Amrani");

  for (const [id, name] of [
    [ids.doctorA, "Dr Amina Benali"],
    [ids.doctorB, "Dr Youssef El Amrani"],
  ]) {
    await admin.query(
      `insert into public.doctor_profiles (id, display_name, specialty, city, verified)
       values ($1, $2, 'Cardiologie', 'Casablanca', true)`,
      [id, name],
    );
  }

  const appointment = async (doctorId: string, patientId: string, hoursAhead: number) => {
    const {
      rows: [row],
    } = await admin.query<{ id: string }>(
      `insert into public.appointments (patient_id, doctor_id, start_at, end_at, status)
       values ($1, $2, now() + ($3 || ' hours')::interval,
               now() + (($3::int + 1) || ' hours')::interval, 'confirmed')
       returning id`,
      [patientId, doctorId, hoursAhead],
    );
    return row.id;
  };

  ids.apptA = await appointment(ids.doctorA, ids.patientA, 24);
  ids.apptB = await appointment(ids.doctorB, ids.patientB, 48);

  asPatientA = new AsUser(session, ids.patientA);
  asPatientB = new AsUser(session, ids.patientB);
  asDoctorA = new AsUser(session, ids.doctorA);
  asDoctorB = new AsUser(session, ids.doctorB);
});

afterAll(async () => {
  await session?.end();
  await rival?.end();
  await admin?.end();
});

/** Files a document straight in, bypassing RLS, to set up a scenario. */
async function seedDocument(options: {
  patientId: string;
  uploadedBy: string;
  appointmentId?: string | null;
  filename?: string;
}): Promise<string> {
  const {
    rows: [row],
  } = await admin.query<{ id: string }>(
    `insert into public.documents
       (patient_id, uploaded_by, appointment_id, storage_path, filename,
        mime_type, size_bytes, kind)
     values ($1::uuid, $2::uuid, $3::uuid, $1::text || '/' || gen_random_uuid(), $4,
             'application/pdf', 1024, 'analysis')
     returning id`,
    [
      options.patientId,
      options.uploadedBy,
      options.appointmentId ?? null,
      options.filename ?? "analyse.pdf",
    ],
  );
  return row.id;
}

describe("the appointment overlap guarantee", () => {
  it("refuses a second appointment overlapping one already booked", async () => {
    // The exclusion constraint that came with the schema: worth a test, since
    // every document rule below hangs off appointments being real.
    await expect(
      admin.query(
        `insert into public.appointments (patient_id, doctor_id, start_at, end_at, status)
         select $1, doctor_id, start_at + interval '30 minutes',
                end_at + interval '30 minutes', 'confirmed'
         from public.appointments where id = $2`,
        [ids.patientB, ids.apptA],
      ),
    ).rejects.toThrow(/no_overlapping_doctor_appointments|exclusion/i);
  });

  it("allows a cancelled appointment's slot to be taken", async () => {
    await admin.query("update public.appointments set status = 'cancelled' where id = $1", [
      ids.apptA,
    ]);
    await expect(
      admin.query(
        `insert into public.appointments (patient_id, doctor_id, start_at, end_at, status)
         select $1, doctor_id, start_at, end_at, 'confirmed'
         from public.appointments where id = $2`,
        [ids.patientB, ids.apptA],
      ),
    ).resolves.toBeTruthy();
  });
});

describe("a patient's own documents", () => {
  it("are readable by that patient", async () => {
    await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    const rows = await asPatientA.query("select id from public.documents");
    expect(rows).toHaveLength(1);
  });

  it("are invisible to another patient", async () => {
    await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    expect(await asPatientB.query("select id from public.documents")).toHaveLength(0);
  });

  it("are invisible to every doctor until shared", async () => {
    await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    expect(await asDoctorA.query("select id from public.documents")).toHaveLength(0);
    expect(await asDoctorB.query("select id from public.documents")).toHaveLength(0);
  });

  it("are invisible to a signed-out caller", async () => {
    await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    const anonymous = new AsUser(session, "00000000-0000-0000-0000-000000000000");
    expect(await anonymous.query("select id from public.documents")).toHaveLength(0);
  });

  it("disappear from the patient's view once soft-deleted", async () => {
    const id = await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    await asPatientA.query("select public.soft_delete_document($1)", [id]);
    expect(await asPatientA.query("select id from public.documents")).toHaveLength(0);
  });
});

describe("sharing a document with a doctor", () => {
  it("makes it readable by that doctor and no other", async () => {
    await seedDocument({
      patientId: ids.patientA,
      uploadedBy: ids.patientA,
      appointmentId: ids.apptA,
    });

    expect(await asDoctorA.query("select id from public.documents")).toHaveLength(1);
    expect(await asDoctorB.query("select id from public.documents")).toHaveLength(0);
    expect(await asPatientB.query("select id from public.documents")).toHaveLength(0);
  });

  it("is done by the patient attaching it to their appointment", async () => {
    const id = await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    expect(await asDoctorA.query("select id from public.documents")).toHaveLength(0);

    await asPatientA.query("update public.documents set appointment_id = $1 where id = $2", [
      ids.apptA,
      id,
    ]);
    expect(await asDoctorA.query("select id from public.documents")).toHaveLength(1);
  });

  it("is undone by detaching it", async () => {
    const id = await seedDocument({
      patientId: ids.patientA,
      uploadedBy: ids.patientA,
      appointmentId: ids.apptA,
    });
    await asPatientA.query("update public.documents set appointment_id = null where id = $1", [id]);
    expect(await asDoctorA.query("select id from public.documents")).toHaveLength(0);
  });

  it("cannot be aimed at an appointment belonging to someone else", async () => {
    const id = await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    // Patient A tries to attach their document to patient B's appointment,
    // which would push it into another doctor's view.
    await expect(
      asPatientA.query("update public.documents set appointment_id = $1 where id = $2", [
        ids.apptB,
        id,
      ]),
    ).rejects.toThrow(/row-level security/i);
  });

  it("stops being visible when the appointment is cancelled and detached", async () => {
    const id = await seedDocument({
      patientId: ids.patientA,
      uploadedBy: ids.patientA,
      appointmentId: ids.apptA,
    });
    await asPatientA.query("update public.documents set appointment_id = null where id = $1", [id]);
    expect(await asDoctorA.query("select id from public.documents")).toHaveLength(0);
  });
});

describe("what a patient may write", () => {
  it("files a document into their own record", async () => {
    const rows = await asPatientA.query(
      `insert into public.documents
         (patient_id, uploaded_by, storage_path, filename, mime_type, size_bytes, kind)
       values ($1::uuid, $1::uuid, $1::text || '/doc-1', 'analyse.pdf', 'application/pdf', 2048, 'analysis')
       returning id`,
      [ids.patientA],
    );
    expect(rows).toHaveLength(1);
  });

  it("cannot file a document into another patient's record", async () => {
    await expect(
      asPatientA.query(
        `insert into public.documents
           (patient_id, uploaded_by, storage_path, filename, mime_type, size_bytes, kind)
         values ($1::uuid, $2::uuid, $1::text || '/doc-2', 'faux.pdf', 'application/pdf', 2048, 'analysis')`,
        [ids.patientB, ids.patientA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot forge who uploaded it", async () => {
    await expect(
      asPatientA.query(
        `insert into public.documents
           (patient_id, uploaded_by, storage_path, filename, mime_type, size_bytes, kind)
         values ($1::uuid, $2::uuid, $1::text || '/doc-3', 'faux.pdf', 'application/pdf', 2048, 'analysis')`,
        [ids.patientA, ids.doctorA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot store a file type the platform does not accept", async () => {
    await expect(
      asPatientA.query(
        `insert into public.documents
           (patient_id, uploaded_by, storage_path, filename, mime_type, size_bytes, kind)
         values ($1::uuid, $1::uuid, $1::text || '/doc-4', 'page.html', 'text/html', 2048, 'other')`,
        [ids.patientA],
      ),
    ).rejects.toThrow(/mime_type/i);
  });

  it("cannot store a file beyond the size limit", async () => {
    await expect(
      asPatientA.query(
        `insert into public.documents
           (patient_id, uploaded_by, storage_path, filename, mime_type, size_bytes, kind)
         values ($1::uuid, $1::uuid, $1::text || '/doc-5', 'enorme.pdf', 'application/pdf', 99999999, 'imaging')`,
        [ids.patientA],
      ),
    ).rejects.toThrow(/size_bytes/i);
  });
});

describe("what a doctor may write", () => {
  it("sends a prescription into the record of a patient they are seeing", async () => {
    const rows = await asDoctorA.query(
      `insert into public.documents
         (patient_id, uploaded_by, appointment_id, storage_path, filename,
          mime_type, size_bytes, kind)
       values ($1::uuid, $2::uuid, $3::uuid, $1::text || '/ordonnance', 'ordonnance.pdf',
               'application/pdf', 1024, 'prescription')
       returning id`,
      [ids.patientA, ids.doctorA, ids.apptA],
    );
    expect(rows).toHaveLength(1);

    // It is the patient's document from the moment it exists.
    expect(await asPatientA.query("select id from public.documents")).toHaveLength(1);
  });

  it("cannot file into the record of a patient they are not seeing", async () => {
    await expect(
      asDoctorB.query(
        `insert into public.documents
           (patient_id, uploaded_by, appointment_id, storage_path, filename,
            mime_type, size_bytes, kind)
         values ($1::uuid, $2::uuid, $3::uuid, $1::text || '/intrus', 'intrus.pdf',
                 'application/pdf', 1024, 'prescription')`,
        [ids.patientA, ids.doctorB, ids.apptA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot file an unattached document into a patient's record", async () => {
    await expect(
      asDoctorA.query(
        `insert into public.documents
           (patient_id, uploaded_by, storage_path, filename, mime_type, size_bytes, kind)
         values ($1::uuid, $2::uuid, $1::text || '/flottant', 'flottant.pdf',
                 'application/pdf', 1024, 'prescription')`,
        [ids.patientA, ids.doctorA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot alter a document in a patient's record", async () => {
    const id = await seedDocument({
      patientId: ids.patientA,
      uploadedBy: ids.patientA,
      appointmentId: ids.apptA,
    });
    // The update policy names only the patient, so a doctor's update matches
    // no rows rather than raising — either way nothing changes.
    await asDoctorA.query("update public.documents set note = 'altered' where id = $1", [id]);
    const [row] = await admin
      .query<{ note: string | null }>("select note from public.documents where id = $1", [id])
      .then((r) => r.rows);
    expect(row.note).toBeNull();
  });

  it("cannot remove a document from a patient's record", async () => {
    const id = await seedDocument({
      patientId: ids.patientA,
      uploadedBy: ids.patientA,
      appointmentId: ids.apptA,
    });
    await asDoctorA.query("delete from public.documents where id = $1", [id]);
    const { rows } = await admin.query("select id from public.documents where id = $1", [id]);
    expect(rows).toHaveLength(1);
  });
});

describe("the files themselves", () => {
  beforeEach(async () => {
    await admin.query(
      `insert into storage.objects (bucket_id, name) values ('medical-documents', $1)`,
      [`${ids.patientA}/scan-001`],
    );
  });

  it("are readable by the patient who owns the folder", async () => {
    const rows = await asPatientA.query(
      "select name from storage.objects where bucket_id = 'medical-documents'",
    );
    expect(rows).toHaveLength(1);
  });

  it("are not readable by another patient", async () => {
    expect(
      await asPatientB.query("select name from storage.objects where bucket_id = 'medical-documents'"),
    ).toHaveLength(0);
  });

  it("are not readable by a doctor until the document is shared", async () => {
    expect(
      await asDoctorA.query("select name from storage.objects where bucket_id = 'medical-documents'"),
    ).toHaveLength(0);

    await admin.query(
      `insert into public.documents
         (patient_id, uploaded_by, appointment_id, storage_path, filename,
          mime_type, size_bytes, kind)
       values ($1, $1, $2, $3, 'scan.pdf', 'application/pdf', 1024, 'imaging')`,
      [ids.patientA, ids.apptA, `${ids.patientA}/scan-001`],
    );

    expect(
      await asDoctorA.query("select name from storage.objects where bucket_id = 'medical-documents'"),
    ).toHaveLength(1);
    expect(
      await asDoctorB.query("select name from storage.objects where bucket_id = 'medical-documents'"),
    ).toHaveLength(0);
  });

  it("cannot be written into another patient's folder", async () => {
    await expect(
      asPatientB.query(
        `insert into storage.objects (bucket_id, name) values ('medical-documents', $1)`,
        [`${ids.patientA}/intrus`],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("are kept in a private bucket, so there is no public URL", async () => {
    const { rows } = await admin.query<{ public: boolean }>(
      "select public from storage.buckets where id = 'medical-documents'",
    );
    expect(rows[0].public).toBe(false);
  });
});


/** Opens a block of consulting time for a doctor. */
async function openAvailability(options: {
  doctorId: string;
  startsInHours: number;
  lengthHours: number;
  slotMinutes?: number;
  status?: string;
}): Promise<void> {
  // Anchored to the minute, as a real cabinet's hours are. It also keeps the
  // fixtures honest: node-pg hands back timestamptz as a JS Date, which has
  // millisecond resolution, so microsecond-precision times would not survive
  // being read as a slot and passed back as a booking.
  await admin.query(
    `insert into public.doctor_availability
       (doctor_id, start_at, end_at, slot_minutes, status)
     values ($1,
             date_trunc('minute', now()) + ($2 || ' hours')::interval,
             date_trunc('minute', now()) + (($2::numeric + $3::numeric) || ' hours')::interval,
             $4, $5)`,
    [
      options.doctorId,
      options.startsInHours,
      options.lengthHours,
      options.slotMinutes ?? 30,
      options.status ?? "open",
    ],
  );
}

interface Slot {
  slot_start: Date;
  slot_end: Date;
}

function slotsFor(caller: AsUser, doctorId: string, days = 14) {
  return caller.query<Slot>("select * from public.available_slots($1, now(), $2)", [
    doctorId,
    days,
  ]);
}

describe("a new account", () => {
  it("gets a profile, so the first booking does not fail on a foreign key", async () => {
    const {
      rows: [user],
    } = await admin.query<{ id: string }>(
      "insert into auth.users (phone) values ('+212600112233') returning id",
    );
    const { rows } = await admin.query<{ id: string; role: string; phone: string }>(
      "select id, role, phone from public.profiles where id = $1",
      [user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("patient");
    expect(rows[0].phone).toBe("+212600112233");
  });
});

describe("seeing free slots", () => {
  // The shared fixtures include appointments, which would silently eat slots
  // out of the blocks opened here. Booking starts from an empty diary.
  beforeEach(async () => {
    await admin.query("delete from public.appointments");
  });

  it("cuts an availability block into consultations", async () => {
    // A four-hour block in 30-minute consultations is eight slots.
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 4 });
    const slots = await slotsFor(asPatientA, ids.doctorA);
    expect(slots).toHaveLength(8);
  });

  it("honours the length the doctor set for that block", async () => {
    await openAvailability({
      doctorId: ids.doctorA,
      startsInHours: 24,
      lengthHours: 1,
      slotMinutes: 20,
    });
    expect(await slotsFor(asPatientA, ids.doctorA)).toHaveLength(3);
  });

  it("never offers a consultation running past closing time", async () => {
    // 50 minutes of block in 20-minute consultations is two, not two and a bit.
    await openAvailability({
      doctorId: ids.doctorA,
      startsInHours: 24,
      lengthHours: 50 / 60,
      slotMinutes: 20,
    });
    expect(await slotsFor(asPatientA, ids.doctorA)).toHaveLength(2);
  });

  it("is visible to a visitor who has not signed in", async () => {
    // Opening hours are public; you should not have to sign in to see whether
    // a doctor has anything free this week.
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 1 });
    const anonymous = new AsUser(session, ids.patientA, "anon");
    expect(await slotsFor(anonymous, ids.doctorA)).toHaveLength(2);
  });

  it("hides a block the doctor has closed", async () => {
    await openAvailability({
      doctorId: ids.doctorA,
      startsInHours: 24,
      lengthHours: 2,
      status: "closed",
    });
    expect(await slotsFor(asPatientA, ids.doctorA)).toHaveLength(0);
  });

  it("hides slots inside the lead time", async () => {
    // A block starting in thirty minutes is too soon to book into.
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 0.5, lengthHours: 1 });
    expect(await slotsFor(asPatientA, ids.doctorA)).toHaveLength(0);
  });

  it("hides a block that has already passed", async () => {
    await openAvailability({ doctorId: ids.doctorA, startsInHours: -48, lengthHours: 4 });
    expect(await slotsFor(asPatientA, ids.doctorA)).toHaveLength(0);
  });

  it("stops at the end of the window asked for", async () => {
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24 * 20, lengthHours: 2 });
    expect(await slotsFor(asPatientA, ids.doctorA, 7)).toHaveLength(0);
    expect(await slotsFor(asPatientA, ids.doctorA, 30)).toHaveLength(4);
  });

  it("shows only the doctor being looked at", async () => {
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 1 });
    await openAvailability({ doctorId: ids.doctorB, startsInHours: 24, lengthHours: 1 });
    expect(await slotsFor(asPatientA, ids.doctorA)).toHaveLength(2);
  });

  it("drops a slot once it is booked, without revealing who booked it", async () => {
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 2 });
    const before = await slotsFor(asPatientA, ids.doctorA);
    expect(before).toHaveLength(4);

    // Booked by somebody else entirely.
    await admin.query(
      `insert into public.appointments (patient_id, doctor_id, start_at, end_at, status)
       values ($1, $2, $3, $4, 'confirmed')`,
      [ids.patientB, ids.doctorA, before[1].slot_start, before[1].slot_end],
    );

    const after = await slotsFor(asPatientA, ids.doctorA);
    expect(after).toHaveLength(3);
    expect(after.map((s) => s.slot_start.getTime())).not.toContain(
      before[1].slot_start.getTime(),
    );
    // And patient A still cannot read patient B's appointment itself.
    expect(await asPatientA.query("select id from public.appointments")).toHaveLength(0);
  });

  it("frees the slot again when the appointment is cancelled", async () => {
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 1 });
    const [slot] = await slotsFor(asPatientA, ids.doctorA);
    const {
      rows: [appointment],
    } = await admin.query<{ id: string }>(
      `insert into public.appointments (patient_id, doctor_id, start_at, end_at, status)
       values ($1, $2, $3, $4, 'confirmed') returning id`,
      [ids.patientB, ids.doctorA, slot.slot_start, slot.slot_end],
    );
    expect(await slotsFor(asPatientA, ids.doctorA)).toHaveLength(1);

    await admin.query("update public.appointments set status = 'cancelled' where id = $1", [
      appointment.id,
    ]);
    expect(await slotsFor(asPatientA, ids.doctorA)).toHaveLength(2);
  });
});

describe("booking a slot", () => {
  // The shared fixtures include appointments, which would silently eat slots
  // out of the blocks opened here. Booking starts from an empty diary.
  beforeEach(async () => {
    await admin.query("delete from public.appointments");
  });

  it("is accepted when the slot is really on offer", async () => {
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 1 });
    const [slot] = await slotsFor(asPatientA, ids.doctorA);

    const rows = await asPatientA.query(
      `insert into public.appointments (patient_id, doctor_id, start_at, end_at, reason)
       values ($1, $2, $3, $4, 'Contrôle de tension') returning id`,
      [ids.patientA, ids.doctorA, slot.slot_start, slot.slot_end],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a time the doctor never advertised", async () => {
    // The original policy accepted any timestamp at all, so a patient could
    // book a doctor at three in the morning.
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 1 });
    await expect(
      asPatientA.query(
        `insert into public.appointments (patient_id, doctor_id, start_at, end_at)
         values ($1, $2, now() + interval '72 hours', now() + interval '73 hours')`,
        [ids.patientA, ids.doctorA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses a slot inside the lead time", async () => {
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 0, lengthHours: 4 });
    await expect(
      asPatientA.query(
        `insert into public.appointments (patient_id, doctor_id, start_at, end_at)
         values ($1, $2, now() + interval '15 minutes', now() + interval '45 minutes')`,
        [ids.patientA, ids.doctorA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses booking in someone else's name", async () => {
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 1 });
    const [slot] = await slotsFor(asPatientA, ids.doctorA);
    await expect(
      asPatientA.query(
        `insert into public.appointments (patient_id, doctor_id, start_at, end_at)
         values ($1, $2, $3, $4)`,
        [ids.patientB, ids.doctorA, slot.slot_start, slot.slot_end],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("lets exactly one of two patients win the same slot", async () => {
    // The guarantee the whole booking flow rests on. Both callers pass every
    // application-level check; the exclusion constraint is what decides.
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 1 });
    const [slot] = await slotsFor(asPatientA, ids.doctorA);

    const book = (caller: AsUser, patientId: string) =>
      caller.query(
        `insert into public.appointments (patient_id, doctor_id, start_at, end_at)
         values ($1, $2, $3, $4)`,
        [patientId, ids.doctorA, slot.slot_start, slot.slot_end],
      );

    // Two separate connections, so the inserts genuinely race.
    const results = await Promise.allSettled([
      book(asPatientA, ids.patientA),
      book(new AsUser(rival, ids.patientB), ids.patientB),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(loser.reason)).toMatch(/no_overlapping_doctor_appointments|exclusion|conflict/i);

    const { rows } = await admin.query("select id from public.appointments");
    expect(rows).toHaveLength(1);
  });

  it("refuses a second booking overlapping the first by part of a slot", async () => {
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 2 });
    const slots = await slotsFor(asPatientA, ids.doctorA);
    await asPatientA.query(
      `insert into public.appointments (patient_id, doctor_id, start_at, end_at)
       values ($1, $2, $3, $4)`,
      [ids.patientA, ids.doctorA, slots[0].slot_start, slots[0].slot_end],
    );

    // A fifteen-minute overlap is still a clash.
    await expect(
      admin.query(
        `insert into public.appointments (patient_id, doctor_id, start_at, end_at)
         values ($1, $2, $3::timestamptz + interval '15 minutes',
                 $4::timestamptz + interval '15 minutes')`,
        [ids.patientB, ids.doctorA, slots[0].slot_start, slots[0].slot_end],
      ),
    ).rejects.toThrow(/no_overlapping_doctor_appointments|exclusion/i);
  });

  it("lets a patient cancel their own booking and nobody else's", async () => {
    await openAvailability({ doctorId: ids.doctorA, startsInHours: 24, lengthHours: 1 });
    const [slot] = await slotsFor(asPatientA, ids.doctorA);
    const {
      rows: [appointment],
    } = await admin.query<{ id: string }>(
      `insert into public.appointments (patient_id, doctor_id, start_at, end_at, status)
       values ($1, $2, $3, $4, 'confirmed') returning id`,
      [ids.patientA, ids.doctorA, slot.slot_start, slot.slot_end],
    );

    await asPatientB.query("update public.appointments set status = 'cancelled' where id = $1", [
      appointment.id,
    ]);
    let { rows } = await admin.query<{ status: string }>(
      "select status from public.appointments where id = $1",
      [appointment.id],
    );
    expect(rows[0].status).toBe("confirmed");

    await asPatientA.query("update public.appointments set status = 'cancelled' where id = $1", [
      appointment.id,
    ]);
    ({ rows } = await admin.query<{ status: string }>(
      "select status from public.appointments where id = $1",
      [appointment.id],
    ));
    expect(rows[0].status).toBe("cancelled");
  });
});

describe("opening consulting hours", () => {
  beforeEach(async () => {
    await admin.query("delete from public.appointments");
    await admin.query("delete from public.doctor_availability");
  });

  /**
   * Calls open_availability the way the screen does: the wall-clock times a
   * practitioner typed, already resolved to instants by the application, so
   * the zone conversion is exercised by the tests in
   * apps/web/lib/booking/wall-time.test.ts rather than here.
   */
  function open(
    caller: AsUser,
    options: {
      date: string;
      start: string;
      end: string;
      slotMinutes?: number;
      repeatWeeks?: number;
    },
  ) {
    const blocks = weeklyBlocks({
      date: options.date,
      start: options.start,
      end: options.end,
      weeks: options.repeatWeeks ?? 1,
    }).map((block) => ({ start: block.start.toISOString(), end: block.end.toISOString() }));

    return caller.query<{ id: string; start_at: Date; end_at: Date; slot_minutes: number }>(
      "select * from public.open_availability($1::jsonb, $2)",
      [JSON.stringify(blocks), options.slotMinutes ?? 30],
    );
  }

  /** A date far enough ahead that "in the past" never interferes. */
  function soon(daysAhead = 7): string {
    const date = new Date(Date.now() + daysAhead * 86_400_000);
    return date.toISOString().slice(0, 10);
  }

  it("opens a block the patient can then book into", async () => {
    const created = await open(asDoctorA, { date: soon(), start: "09:00", end: "13:00" });
    expect(created).toHaveLength(1);

    const slots = await asPatientA.query(
      "select * from public.available_slots($1, now(), 30)",
      [ids.doctorA],
    );
    expect(slots).toHaveLength(8);
  });

  it("stores exactly the instants it was given", async () => {
    // The wall-clock conversion is the application's job and is tested there;
    // what matters here is that nothing is reinterpreted on the way in. That
    // separation is deliberate: this server's own time-zone data is stale,
    // and letting the database resolve "09:00" would silently disagree with
    // what the interface displays.
    const [block] = weeklyBlocks({
      date: "2027-07-13",
      start: "09:00",
      end: "13:00",
      weeks: 1,
    });
    const [created] = await asDoctorA.query<{ start_at: Date; end_at: Date }>(
      "select * from public.open_availability($1::jsonb, 30)",
      [JSON.stringify([{ start: block.start.toISOString(), end: block.end.toISOString() }])],
    );
    expect(created.start_at.toISOString()).toBe(block.start.toISOString());
    expect(created.end_at.toISOString()).toBe(block.end.toISOString());
  });

  it("repeats a weekly pattern", async () => {
    const created = await open(asDoctorA, {
      date: soon(),
      start: "09:00",
      end: "12:00",
      repeatWeeks: 4,
    });
    expect(created).toHaveLength(4);

    // Each one lands exactly a week after the last.
    const starts = created.map((b) => b.start_at.getTime()).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBe(7 * 86_400_000);
    }
  });

  it("keeps the consultation length the practitioner chose", async () => {
    const [block] = await open(asDoctorA, {
      date: soon(),
      start: "09:00",
      end: "10:00",
      slotMinutes: 15,
    });
    expect(block.slot_minutes).toBe(15);

    const slots = await asPatientA.query(
      "select * from public.available_slots($1, now(), 30)",
      [ids.doctorA],
    );
    expect(slots).toHaveLength(4);
  });

  it("skips weeks already covered instead of failing the whole request", async () => {
    const date = soon();
    await open(asDoctorA, { date, start: "09:00", end: "12:00" });

    // Repeating from the same day: the first week clashes, the rest do not.
    const created = await open(asDoctorA, { date, start: "09:00", end: "12:00", repeatWeeks: 3 });
    expect(created).toHaveLength(2);

    const { rows } = await admin.query("select id from public.doctor_availability");
    expect(rows).toHaveLength(3);
  });

  it("refuses a block overlapping one already open", async () => {
    const date = soon();
    await open(asDoctorA, { date, start: "09:00", end: "13:00" });
    // 11:00-15:00 straddles the existing morning.
    expect(await open(asDoctorA, { date, start: "11:00", end: "15:00" })).toHaveLength(0);
  });

  it("allows a second block that merely touches the first", async () => {
    const date = soon();
    await open(asDoctorA, { date, start: "09:00", end: "13:00" });
    // An afternoon starting exactly when the morning ends is not an overlap.
    expect(await open(asDoctorA, { date, start: "13:00", end: "18:00" })).toHaveLength(1);
  });

  it("lets two doctors hold the same hours", async () => {
    const date = soon();
    await open(asDoctorA, { date, start: "09:00", end: "13:00" });
    expect(await open(asDoctorB, { date, start: "09:00", end: "13:00" })).toHaveLength(1);
  });

  it("skips a date that has already passed", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(await open(asDoctorA, { date: yesterday, start: "09:00", end: "13:00" })).toHaveLength(0);
  });

  it("reads an end before the start as an overnight block", async () => {
    // A night clinic running 22:00 to 02:00 is a real thing, so the
    // application resolves the end to the following day rather than refusing.
    const [block] = await open(asDoctorA, { date: soon(), start: "22:00", end: "02:00" });
    expect(block.end_at.getTime()).toBeGreaterThan(block.start_at.getTime());
  });

  it("refuses an inverted block submitted directly", async () => {
    // The application never produces one, but the database is the last word.
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const end = new Date(Date.now() + 3_600_000).toISOString();
    await expect(
      asDoctorA.query("select * from public.open_availability($1::jsonb, 30)", [
        JSON.stringify([{ start, end }]),
      ]),
    ).rejects.toThrow(/end after it starts/i);
  });

  it("refuses a block shorter than one consultation", async () => {
    await expect(
      open(asDoctorA, { date: soon(), start: "09:00", end: "09:20", slotMinutes: 30 }),
    ).rejects.toThrow(/shorter than one consultation/i);
  });

  it("refuses an implausible consultation length", async () => {
    await expect(
      open(asDoctorA, { date: soon(), start: "09:00", end: "17:00", slotMinutes: 1 }),
    ).rejects.toThrow(/between 5 and 240/i);
  });

  it("refuses anything that is not a list of blocks", async () => {
    await expect(
      asDoctorA.query("select * from public.open_availability($1::jsonb, 30)", ['{"start":"x"}']),
    ).rejects.toThrow(/list of blocks/i);
  });

  it("writes into the caller's own diary, never another doctor's", async () => {
    // The function takes no doctor id at all: it uses the signed-in user, so
    // there is nothing to tamper with.
    await open(asDoctorA, { date: soon(), start: "09:00", end: "13:00" });
    const { rows } = await admin.query<{ doctor_id: string }>(
      "select doctor_id from public.doctor_availability",
    );
    expect(rows.every((r) => r.doctor_id === ids.doctorA)).toBe(true);
  });

  it("refuses a patient opening consulting hours", async () => {
    // A patient has no doctor_profiles row, so the foreign key stops them even
    // before the policy would.
    await expect(
      open(asPatientA, { date: soon(), start: "09:00", end: "13:00" }),
    ).rejects.toThrow();
  });
});

describe("closing consulting hours", () => {
  beforeEach(async () => {
    await admin.query("delete from public.appointments");
    await admin.query("delete from public.doctor_availability");
  });

  async function openBlock(doctorId: string): Promise<string> {
    const {
      rows: [row],
    } = await admin.query<{ id: string }>(
      `insert into public.doctor_availability (doctor_id, start_at, end_at, slot_minutes)
       values ($1, date_trunc('minute', now()) + interval '24 hours',
               date_trunc('minute', now()) + interval '28 hours', 30)
       returning id`,
      [doctorId],
    );
    return row.id;
  }

  it("takes the slots off the board", async () => {
    const id = await openBlock(ids.doctorA);
    expect(
      await asPatientA.query("select * from public.available_slots($1, now(), 30)", [ids.doctorA]),
    ).toHaveLength(8);

    await asDoctorA.query("delete from public.doctor_availability where id = $1", [id]);
    expect(
      await asPatientA.query("select * from public.available_slots($1, now(), 30)", [ids.doctorA]),
    ).toHaveLength(0);
  });

  it("leaves appointments already booked standing", async () => {
    // Withdrawing opening hours must not quietly cancel people who already
    // have a place in the diary.
    const id = await openBlock(ids.doctorA);
    const [slot] = await asPatientA.query<{ slot_start: Date; slot_end: Date }>(
      "select * from public.available_slots($1, now(), 30)",
      [ids.doctorA],
    );
    await admin.query(
      `insert into public.appointments (patient_id, doctor_id, start_at, end_at, status)
       values ($1, $2, $3, $4, 'confirmed')`,
      [ids.patientA, ids.doctorA, slot.slot_start, slot.slot_end],
    );

    await asDoctorA.query("delete from public.doctor_availability where id = $1", [id]);

    const { rows } = await admin.query("select id from public.appointments");
    expect(rows).toHaveLength(1);
  });

  it("refuses to let one doctor close another's hours", async () => {
    const id = await openBlock(ids.doctorA);
    await asDoctorB.query("delete from public.doctor_availability where id = $1", [id]);
    const { rows } = await admin.query("select id from public.doctor_availability where id = $1", [
      id,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe("the whole loop", () => {
  beforeEach(async () => {
    await admin.query("delete from public.appointments");
    await admin.query("delete from public.doctor_availability");
  });

  it("a doctor opens hours, a patient books, the slot goes", async () => {
    const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const blocks = weeklyBlocks({ date, start: "09:00", end: "11:00", weeks: 1 }).map((b) => ({
      start: b.start.toISOString(),
      end: b.end.toISOString(),
    }));

    // The practitioner opens a morning.
    const opened = await asDoctorA.query(
      "select * from public.open_availability($1::jsonb, 30)",
      [JSON.stringify(blocks)],
    );
    expect(opened).toHaveLength(1);

    // The patient sees four half-hour consultations.
    const offered = await asPatientA.query<{ slot_start: Date; slot_end: Date }>(
      "select * from public.available_slots($1, now(), 30)",
      [ids.doctorA],
    );
    expect(offered).toHaveLength(4);

    // They take the second one.
    const chosen = offered[1];
    await asPatientA.query(
      `insert into public.appointments (patient_id, doctor_id, start_at, end_at, reason)
       values ($1, $2, $3, $4, 'Contrôle')`,
      [ids.patientA, ids.doctorA, chosen.slot_start, chosen.slot_end],
    );

    // It is gone for everyone else, and the rest remain.
    const afterwards = await asPatientB.query<{ slot_start: Date }>(
      "select * from public.available_slots($1, now(), 30)",
      [ids.doctorA],
    );
    expect(afterwards).toHaveLength(3);
    expect(afterwards.map((s) => s.slot_start.getTime())).not.toContain(
      chosen.slot_start.getTime(),
    );

    // The doctor sees the booking in their own diary.
    const diary = await asDoctorA.query("select id from public.appointments");
    expect(diary).toHaveLength(1);

    // And the patient can cancel, which puts the slot straight back.
    await asPatientA.query(
      "update public.appointments set status = 'cancelled' where patient_id = $1",
      [ids.patientA],
    );
    expect(
      await asPatientB.query("select * from public.available_slots($1, now(), 30)", [ids.doctorA]),
    ).toHaveLength(4);
  });
});

describe("closing time off", () => {
  beforeEach(async () => {
    await admin.query("delete from public.appointments");
    await admin.query("delete from public.doctor_availability");
    await admin.query("delete from public.doctor_absences");
  });

  /** Opens a four-hour block a week out, in whole minutes. */
  async function openMorning(doctorId = ids.doctorA): Promise<void> {
    await admin.query(
      `insert into public.doctor_availability (doctor_id, start_at, end_at, slot_minutes)
       values ($1, date_trunc('hour', now()) + interval '7 days',
               date_trunc('hour', now()) + interval '7 days' + interval '4 hours', 30)`,
      [doctorId],
    );
  }

  /** Closes a period relative to the start of that block. */
  function close(
    caller: AsUser,
    options: { fromHours: number; toHours: number; reason?: string },
  ) {
    return caller.query(
      `insert into public.doctor_absences (doctor_id, starts_at, ends_at, reason)
       values ($1,
               date_trunc('hour', now()) + interval '7 days' + ($2 || ' hours')::interval,
               date_trunc('hour', now()) + interval '7 days' + ($3 || ' hours')::interval,
               $4)
       returning id`,
      [ids.doctorA, options.fromHours, options.toHours, options.reason ?? null],
    );
  }

  const slotsFor = (caller: AsUser, doctorId = ids.doctorA) =>
    caller.query<{ slot_start: Date; slot_end: Date }>(
      "select * from public.available_slots($1, now(), 30)",
      [doctorId],
    );

  it("hides the slots it covers without touching the hours underneath", async () => {
    await openMorning();
    expect(await slotsFor(asPatientA)).toHaveLength(8);

    // Close the first two hours only.
    await close(asDoctorA, { fromHours: 0, toHours: 2, reason: "Conférence" });
    expect(await slotsFor(asPatientA)).toHaveLength(4);

    // The availability block itself survives, which is the whole point: the
    // practitioner gets their Tuesday back when the closure passes.
    const { rows } = await admin.query("select id from public.doctor_availability");
    expect(rows).toHaveLength(1);
  });

  it("closes a whole day when the period covers it", async () => {
    await openMorning();
    await close(asDoctorA, { fromHours: -1, toHours: 6, reason: "Aïd" });
    expect(await slotsFor(asPatientA)).toHaveLength(0);
  });

  it("hides a slot it only partly covers", async () => {
    await openMorning();
    // Straddling the 60-minute boundary touches the slots either side of it,
    // and a slot only partly closed is still unbookable.
    await close(asDoctorA, { fromHours: 0.75, toHours: 1.25 });
    expect(await slotsFor(asPatientA)).toHaveLength(6);
  });

  it("gives the time back when the closure is lifted", async () => {
    await openMorning();
    const [closure] = await close(asDoctorA, { fromHours: 0, toHours: 4 });
    expect(await slotsFor(asPatientA)).toHaveLength(0);

    await asDoctorA.query("delete from public.doctor_absences where id = $1", [
      (closure as { id: string }).id,
    ]);
    expect(await slotsFor(asPatientA)).toHaveLength(8);
  });

  it("only affects the practitioner who declared it", async () => {
    await openMorning(ids.doctorA);
    await openMorning(ids.doctorB);
    await close(asDoctorA, { fromHours: 0, toHours: 4 });

    expect(await slotsFor(asPatientA, ids.doctorA)).toHaveLength(0);
    expect(await slotsFor(asPatientA, ids.doctorB)).toHaveLength(8);
  });

  it("refuses a booking inside it, even from a stale page", async () => {
    await openMorning();
    const [slot] = await slotsFor(asPatientA);

    await close(asDoctorA, { fromHours: 0, toHours: 4 });

    // The patient still holds the slot they saw a moment ago.
    await expect(
      asPatientA.query(
        `insert into public.appointments (patient_id, doctor_id, start_at, end_at)
         values ($1, $2, $3, $4)`,
        [ids.patientA, ids.doctorA, slot.slot_start, slot.slot_end],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("leaves appointments already booked standing", async () => {
    // Closing a day must not silently cancel people who have a place in the
    // diary. They keep it; the practitioner is expected to call them.
    await openMorning();
    const [slot] = await slotsFor(asPatientA);
    await asPatientA.query(
      `insert into public.appointments (patient_id, doctor_id, start_at, end_at)
       values ($1, $2, $3, $4)`,
      [ids.patientA, ids.doctorA, slot.slot_start, slot.slot_end],
    );

    await close(asDoctorA, { fromHours: 0, toHours: 4 });

    const { rows } = await admin.query<{ status: string }>(
      "select status from public.appointments",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("requested");
    // And the patient still sees it.
    expect(await asPatientA.query("select id from public.appointments")).toHaveLength(1);
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(close(asDoctorA, { fromHours: 4, toHours: 1 })).rejects.toThrow(
      /check constraint|violates/i,
    );
  });

  it("is private to the practitioner", async () => {
    await openMorning();
    await close(asDoctorA, { fromHours: 0, toHours: 4, reason: "Raison médicale" });

    // A patient sees the slots vanish but never learns why.
    expect(await asPatientA.query("select id from public.doctor_absences")).toHaveLength(0);
    // Nor does another practitioner.
    expect(await asDoctorB.query("select id from public.doctor_absences")).toHaveLength(0);
    // The owner does.
    expect(await asDoctorA.query("select reason from public.doctor_absences")).toHaveLength(1);
  });

  it("cannot be declared on another practitioner's diary", async () => {
    await expect(
      asDoctorB.query(
        `insert into public.doctor_absences (doctor_id, starts_at, ends_at)
         values ($1, now() + interval '8 days', now() + interval '9 days')`,
        [ids.doctorA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot be lifted by another practitioner", async () => {
    await openMorning();
    const [closure] = await close(asDoctorA, { fromHours: 0, toHours: 4 });
    await asDoctorB.query("delete from public.doctor_absences where id = $1", [
      (closure as { id: string }).id,
    ]);
    expect(await asDoctorA.query("select id from public.doctor_absences")).toHaveLength(1);
  });
});

describe("who a closure would affect", () => {
  beforeEach(async () => {
    await admin.query("delete from public.appointments");
    await admin.query("delete from public.doctor_availability");
    await admin.query("delete from public.doctor_absences");
  });

  async function bookOne(patientId: string, hoursAhead: number): Promise<void> {
    await admin.query(
      `insert into public.appointments (patient_id, doctor_id, start_at, end_at, status)
       values ($1, $2, date_trunc('hour', now()) + ($3 || ' hours')::interval,
               date_trunc('hour', now()) + ($3 || ' hours')::interval + interval '30 minutes',
               'confirmed')`,
      [patientId, ids.doctorA, hoursAhead],
    );
  }

  const affected = (caller: AsUser, fromHours: number, toHours: number) =>
    caller.query<{ patient_name: string; patient_phone: string; start_at: Date }>(
      `select * from public.appointments_in_period(
         date_trunc('hour', now()) + ($1 || ' hours')::interval,
         date_trunc('hour', now()) + ($2 || ' hours')::interval)`,
      [fromHours, toHours],
    );

  it("names the patients who would need telling", async () => {
    // A practitioner marking a holiday needs to know who is already booked,
    // because those bookings survive the closure.
    await bookOne(ids.patientA, 24);
    await bookOne(ids.patientB, 25);
    await bookOne(ids.patientA, 200); // well outside the period

    const rows = await affected(asDoctorA, 23, 26);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.patient_name).sort()).toEqual(["Karim Tazi", "Salma Bennis"]);
    // With a number to call.
    expect(rows[0].patient_phone).toBeTruthy();
  });

  it("returns nothing when the period is clear", async () => {
    await bookOne(ids.patientA, 200);
    expect(await affected(asDoctorA, 23, 26)).toHaveLength(0);
  });

  it("shows only the caller's own diary", async () => {
    await bookOne(ids.patientA, 24);
    expect(await affected(asDoctorB, 23, 26)).toHaveLength(0);
  });

  it("ignores appointments already cancelled", async () => {
    await bookOne(ids.patientA, 24);
    await admin.query("update public.appointments set status = 'cancelled'");
    expect(await affected(asDoctorA, 23, 26)).toHaveLength(0);
  });
});

describe("deleting a document", () => {
  it("removes it from the patient's view and returns the object key", async () => {
    const id = await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    const rows = await asPatientA.query<{ soft_delete_document: string }>(
      "select public.soft_delete_document($1)",
      [id],
    );
    // The caller needs the key to delete the bytes from Storage.
    expect(rows[0].soft_delete_document).toMatch(new RegExp(`^${ids.patientA}/`));
    expect(await asPatientA.query("select id from public.documents")).toHaveLength(0);
  });

  it("keeps the row, so a doctor's record of the consultation stands", async () => {
    const id = await seedDocument({
      patientId: ids.patientA,
      uploadedBy: ids.patientA,
      appointmentId: ids.apptA,
    });
    await asPatientA.query("select public.soft_delete_document($1)", [id]);

    const { rows } = await admin.query<{ deleted_at: Date | null }>(
      "select deleted_at from public.documents where id = $1",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it("hides it from the doctor it had been shared with", async () => {
    const id = await seedDocument({
      patientId: ids.patientA,
      uploadedBy: ids.patientA,
      appointmentId: ids.apptA,
    });
    expect(await asDoctorA.query("select id from public.documents")).toHaveLength(1);
    await asPatientA.query("select public.soft_delete_document($1)", [id]);
    expect(await asDoctorA.query("select id from public.documents")).toHaveLength(0);
  });

  it("refuses to delete another patient's document", async () => {
    const id = await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    await expect(
      asPatientB.query("select public.soft_delete_document($1)", [id]),
    ).rejects.toThrow(/not found|not yours/i);
    expect(await asPatientA.query("select id from public.documents")).toHaveLength(1);
  });

  it("refuses a doctor deleting from a patient's record", async () => {
    const id = await seedDocument({
      patientId: ids.patientA,
      uploadedBy: ids.patientA,
      appointmentId: ids.apptA,
    });
    await expect(
      asDoctorA.query("select public.soft_delete_document($1)", [id]),
    ).rejects.toThrow(/not found|not yours/i);
  });

  it("is idempotent rather than silently re-deleting", async () => {
    const id = await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    await asPatientA.query("select public.soft_delete_document($1)", [id]);
    await expect(
      asPatientA.query("select public.soft_delete_document($1)", [id]),
    ).rejects.toThrow(/already deleted|not found/i);
  });

  it("cannot be undone by the patient editing the row back", async () => {
    const id = await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    await asPatientA.query("select public.soft_delete_document($1)", [id]);
    // The update policy excludes deleted rows, so this matches nothing.
    await asPatientA.query("update public.documents set deleted_at = null where id = $1", [id]);
    expect(await asPatientA.query("select id from public.documents")).toHaveLength(0);
  });
});

describe("the audit trail", () => {
  it("records creation, sharing and deletion", async () => {
    const id = await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    await asPatientA.query("update public.documents set appointment_id = $1 where id = $2", [
      ids.apptA,
      id,
    ]);
    await asPatientA.query("update public.documents set appointment_id = null where id = $1", [id]);
    await asPatientA.query("select public.soft_delete_document($1)", [id]);

    const { rows } = await admin.query<{ action: string }>(
      "select action from public.audit_logs where entity_id = $1 order by id",
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      "document.created",
      "document.shared",
      "document.unshared",
      "document.deleted",
    ]);
  });

  it("records who did it", async () => {
    const id = await seedDocument({ patientId: ids.patientA, uploadedBy: ids.patientA });
    await asPatientA.query("update public.documents set note = 'relu' where id = $1", [id]);

    const { rows } = await admin.query<{ actor_id: string | null }>(
      "select actor_id from public.audit_logs where entity_id = $1 order by id desc limit 1",
      [id],
    );
    expect(rows[0].actor_id).toBe(ids.patientA);
  });
});
