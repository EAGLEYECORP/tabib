import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The upload route's orchestration.
 *
 * Who may read or write a document is decided by row-level security and is
 * tested against a real PostgreSQL server in supabase/test/rls.test.ts. What
 * is tested here is the part that sits above those rules and cannot be
 * expressed in them: that bytes are inspected before anything is stored, that
 * a doctor's upload is filed into the right patient's record, and that a
 * failed insert never leaves an orphaned object in the bucket.
 *
 * The Supabase client is stubbed for that reason — not to stand in for the
 * policies, but to isolate the sequencing around them.
 */

const storage = {
  uploaded: [] as { path: string; contentType: string }[],
  removed: [] as string[],
  failNextUpload: false,
};

const database = {
  inserted: [] as Record<string, unknown>[],
  failNextInsert: false,
  appointment: null as null | { id: string; patient_id: string; doctor_id: string },
};

let currentUser: { id: string } | null = null;

vi.mock("../../../lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: currentUser } }),
    },
    from(table: string) {
      if (table === "appointments") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: database.appointment }),
            }),
          }),
        };
      }
      return {
        insert: (row: Record<string, unknown>) => {
          if (!database.failNextInsert) database.inserted.push(row);
          return {
            select: () => ({
              single: async () =>
                database.failNextInsert
                  ? { data: null, error: { message: "rls" } }
                  : { data: { id: "doc-1", filename: row.filename }, error: null },
            }),
          };
        },
      };
    },
    storage: {
      from: () => ({
        upload: async (path: string, _bytes: unknown, options: { contentType: string }) => {
          if (storage.failNextUpload) return { error: { message: "nope" } };
          storage.uploaded.push({ path, contentType: options.contentType });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          storage.removed.push(...paths);
          return { error: null };
        },
      }),
    },
  }),
}));

const { POST } = await import("./route");

const PDF = new Uint8Array([...Buffer.from("%PDF-1.7\n"), ...Buffer.alloc(32)]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(32)]);
const HTML = new Uint8Array(Buffer.from("<html><script>alert(1)</script></html>"));

const PATIENT = "11111111-1111-1111-1111-111111111111";
const DOCTOR = "22222222-2222-2222-2222-222222222222";

function upload(
  files: { name: string; bytes: Uint8Array }[],
  extra: Record<string, string> = {},
) {
  const form = new FormData();
  for (const file of files) {
    form.append("files", new File([file.bytes as BlobPart], file.name));
  }
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return POST(new Request("http://localhost/api/documents", { method: "POST", body: form }) as never);
}

beforeEach(() => {
  storage.uploaded = [];
  storage.removed = [];
  storage.failNextUpload = false;
  database.inserted = [];
  database.failNextInsert = false;
  database.appointment = null;
  currentUser = { id: PATIENT };
});

describe("who may upload", () => {
  it("refuses a caller who is not signed in", async () => {
    currentUser = null;
    const response = await upload([{ name: "a.pdf", bytes: PDF }]);
    expect(response.status).toBe(401);
    expect(storage.uploaded).toHaveLength(0);
  });

  it("files a patient's upload into their own record", async () => {
    const response = await upload([{ name: "analyse.pdf", bytes: PDF }]);
    expect(response.status).toBe(201);
    expect(database.inserted[0]).toMatchObject({
      patient_id: PATIENT,
      uploaded_by: PATIENT,
      appointment_id: null,
    });
  });
});

describe("what may be uploaded", () => {
  it("records the type it found in the bytes, not the one claimed", async () => {
    // A JPEG sent under a .pdf name is stored and labelled as the image it is.
    await upload([{ name: "radio.pdf", bytes: JPEG }]);
    expect(database.inserted[0]).toMatchObject({
      mime_type: "image/jpeg",
      filename: "radio.jpg",
    });
    expect(storage.uploaded[0].contentType).toBe("image/jpeg");
  });

  it("refuses content that is not a medical document format", async () => {
    const response = await upload([{ name: "page.pdf", bytes: HTML }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      failed: [{ filename: "page.pdf", reason: "UNSUPPORTED_TYPE" }],
    });
    // Nothing reached the bucket.
    expect(storage.uploaded).toHaveLength(0);
    expect(database.inserted).toHaveLength(0);
  });

  it("keeps the good files when one in a batch is refused", async () => {
    const response = await upload([
      { name: "bon.pdf", bytes: PDF },
      { name: "mauvais.pdf", bytes: HTML },
    ]);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.uploaded).toHaveLength(1);
    expect(body.failed).toHaveLength(1);
  });

  it("stores under a generated key in the owner's folder", async () => {
    await upload([{ name: "../../escape.pdf", bytes: PDF }]);
    const path = storage.uploaded[0].path;
    expect(path.startsWith(`${PATIENT}/`)).toBe(true);
    expect(path).not.toContain("..");
    expect(path).not.toContain("escape");
  });

  it("records a checksum of the contents", async () => {
    await upload([{ name: "a.pdf", bytes: PDF }]);
    expect(database.inserted[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a doctor sending a document", () => {
  beforeEach(() => {
    currentUser = { id: DOCTOR };
    database.appointment = { id: "appt-1", patient_id: PATIENT, doctor_id: DOCTOR };
  });

  it("files it into the patient's record, attached to the appointment", async () => {
    const response = await upload([{ name: "ordonnance.pdf", bytes: PDF }], {
      appointmentId: "appt-1",
      kind: "prescription",
    });
    expect(response.status).toBe(201);
    expect(database.inserted[0]).toMatchObject({
      patient_id: PATIENT,
      uploaded_by: DOCTOR,
      appointment_id: "appt-1",
      kind: "prescription",
    });
    // And into the patient's folder, not the doctor's.
    expect(storage.uploaded[0].path.startsWith(`${PATIENT}/`)).toBe(true);
  });

  it("is refused when the appointment belongs to neither party", async () => {
    database.appointment = {
      id: "appt-2",
      patient_id: "33333333-3333-3333-3333-333333333333",
      doctor_id: "44444444-4444-4444-4444-444444444444",
    };
    const response = await upload([{ name: "x.pdf", bytes: PDF }], { appointmentId: "appt-2" });
    expect(response.status).toBe(403);
    expect(storage.uploaded).toHaveLength(0);
  });

  it("is refused when the appointment does not exist", async () => {
    database.appointment = null;
    const response = await upload([{ name: "x.pdf", bytes: PDF }], { appointmentId: "ghost" });
    expect(response.status).toBe(404);
  });
});

describe("when something goes wrong", () => {
  it("leaves no object behind if the row is rejected", async () => {
    // The row insert is where row-level security has the final say; if it
    // refuses, the bytes must not linger in the bucket.
    database.failNextInsert = true;
    const response = await upload([{ name: "a.pdf", bytes: PDF }]);

    expect(response.status).toBe(400);
    expect(storage.uploaded).toHaveLength(1);
    expect(storage.removed).toEqual([storage.uploaded[0].path]);
  });

  it("reports a storage failure without writing a row", async () => {
    storage.failNextUpload = true;
    const response = await upload([{ name: "a.pdf", bytes: PDF }]);
    expect(response.status).toBe(400);
    expect(database.inserted).toHaveLength(0);
    expect(await response.json()).toMatchObject({
      failed: [{ reason: "STORAGE_FAILED" }],
    });
  });

  it("refuses an empty submission", async () => {
    const response = await upload([]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "NO_FILES" });
  });
});
