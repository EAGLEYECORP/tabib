import { createHash, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../lib/supabase/server";
import {
  DOCUMENTS_BUCKET,
  isDocumentKind,
  type DocumentKind,
} from "../../../lib/documents/kinds";
import {
  MAX_FILES_PER_UPLOAD,
  MAX_FILE_BYTES,
  inspectUpload,
} from "../../../lib/documents/file-types";

/**
 * Uploading medical documents.
 *
 * A route handler rather than a direct browser-to-Storage upload, for one
 * reason: the file's type has to be decided by reading its bytes, and only the
 * server can be trusted to do that. The bucket's own MIME allowlist believes
 * the Content-Type the client declares, so a renamed HTML page would satisfy
 * it. Here the bytes are inspected first and the declared type is discarded.
 *
 * Everything still runs through the caller's own session, so row-level
 * security applies to the Storage write and the row insert exactly as it would
 * from the browser. This route adds a check; it does not bypass any.
 */

export const runtime = "nodejs";

interface Rejection {
  readonly filename: string;
  readonly reason: string;
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "NOT_AUTHENTICATED" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "MALFORMED_UPLOAD" }, { status: 400 });
  }

  const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "NO_FILES" }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_UPLOAD) {
    return NextResponse.json({ error: "TOO_MANY_FILES" }, { status: 400 });
  }

  const kindValue = String(form.get("kind") ?? "other");
  const kind: DocumentKind = isDocumentKind(kindValue) ? kindValue : "other";
  const note = String(form.get("note") ?? "").slice(0, 500).trim();
  const appointmentId = String(form.get("appointmentId") ?? "").trim() || null;

  // Whose record this lands in depends on who is uploading. A patient files
  // into their own; a doctor files into the record of the patient whose
  // appointment they named. The appointment is checked here so the request
  // fails early with a clear reason, and checked again by the row-level
  // policies, which are what actually decide.
  let patientId = user.id;
  if (appointmentId) {
    const { data: appointment } = await supabase
      .from("appointments")
      .select("id, patient_id, doctor_id")
      .eq("id", appointmentId)
      .maybeSingle();

    if (!appointment) {
      return NextResponse.json({ error: "APPOINTMENT_NOT_FOUND" }, { status: 404 });
    }
    if (appointment.doctor_id === user.id) {
      patientId = appointment.patient_id;
    } else if (appointment.patient_id !== user.id) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }
  }

  const uploaded: { id: string; filename: string }[] = [];
  const failed: Rejection[] = [];

  for (const file of files) {
    // Refuse on the declared size before reading the body into memory.
    if (file.size > MAX_FILE_BYTES) {
      failed.push({ filename: file.name, reason: "TOO_LARGE" });
      continue;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const inspection = inspectUpload(bytes, file.name);
    if (!inspection.ok) {
      failed.push({ filename: file.name, reason: inspection.reason });
      continue;
    }

    // The key puts the file in the owning patient's folder, which is what the
    // Storage policies key off. The name is generated, never derived from the
    // uploaded filename, so a crafted name has nothing to escape.
    const storagePath = `${patientId}/${randomUUID()}`;

    const { error: uploadError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(storagePath, bytes, {
        contentType: inspection.file.mimeType,
        upsert: false,
      });

    if (uploadError) {
      failed.push({ filename: file.name, reason: "STORAGE_FAILED" });
      continue;
    }

    const { data: row, error: insertError } = await supabase
      .from("documents")
      .insert({
        patient_id: patientId,
        uploaded_by: user.id,
        appointment_id: appointmentId,
        storage_path: storagePath,
        filename: inspection.file.filename,
        mime_type: inspection.file.mimeType,
        size_bytes: inspection.file.sizeBytes,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        kind,
        note: note || null,
      })
      .select("id, filename")
      .single();

    if (insertError || !row) {
      // Never leave bytes in the bucket that no row points at.
      await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath]);
      failed.push({ filename: file.name, reason: "REJECTED" });
      continue;
    }

    uploaded.push(row);
  }

  // A partial success is reported as one: refusing the whole batch because the
  // tenth photo was a screenshot would throw away the nine good ones.
  return NextResponse.json(
    { uploaded, failed },
    { status: uploaded.length > 0 ? 201 : 400 },
  );
}
