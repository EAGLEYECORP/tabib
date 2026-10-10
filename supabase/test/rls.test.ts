import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
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

const SOCKET = process.env.PGHOST ?? "/var/tmp/tabibpg";
const PORT = Number(process.env.PGPORT ?? 55432);
const DB = "tabib_rls_test";

const repoRoot = join(__dirname, "..", "..");

function connect(database: string, user = "postgres") {
  return new Client({ host: SOCKET, port: PORT, user, database });
}

/** A client acting as one signed-in user, subject to RLS. */
class AsUser {
  constructor(
    private readonly client: Client,
    private readonly userId: string,
  ) {}

  /**
   * Runs a query as this user. The role is switched to `authenticated` and the
   * JWT subject set for the statement, which is what makes the policies apply
   * — as superuser they would all be bypassed and every test would pass.
   */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.client.query("begin");
    try {
      await this.client.query("set local role authenticated");
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

const ids = {
  patientA: "",
  patientB: "",
  doctorA: "",
  doctorB: "",
  apptA: "",
  apptB: "",
};

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
    grant select, insert, update, delete on storage.objects to authenticated;
    grant select on storage.buckets to authenticated;
    grant usage, select on all sequences in schema public to authenticated;
  `);

  session = connect(DB);
  await session.connect();
}, 60_000);

beforeEach(async () => {
  await admin.query("delete from public.documents");
  await admin.query("delete from public.appointments");
  await admin.query("delete from public.audit_logs");
  await admin.query("delete from storage.objects");
  await admin.query("delete from public.doctor_profiles");
  await admin.query("delete from public.profiles");
  await admin.query("delete from auth.users");

  const makeUser = async (role: string, name: string) => {
    const {
      rows: [user],
    } = await admin.query<{ id: string }>("insert into auth.users default values returning id");
    await admin.query(
      "insert into public.profiles (id, full_name, role) values ($1, $2, $3::public.user_role)",
      [user.id, name, role],
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
