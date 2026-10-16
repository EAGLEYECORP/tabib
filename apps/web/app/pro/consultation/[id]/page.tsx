import { notFound } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";
import { DocumentUploader } from "../../../../components/document-uploader";
import { DocumentList, type DocumentListItem } from "../../../../components/document-list";
import type { DocumentKind } from "../../../../lib/documents/kinds";
import { AppointmentDecision } from "../../../../components/appointment-decision";
import { isAppointmentStatus, statusLabel, statusTone } from "../../../../lib/booking/status";
import { formatDayLong, formatTime } from "../../../../lib/booking/slots";

export const dynamic = "force-dynamic";
export const metadata = { title: "Consultation · Tabib.ma", robots: { index: false } };

/**
 * One consultation, from the practitioner's side.
 *
 * The documents listed here are only those the patient attached to this
 * appointment — not their whole record. That limit is enforced by row-level
 * security rather than by the query, so it holds even if this page is wrong.
 */
export default async function ConsultationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="container">
        <h1>Consultation</h1>
        <p>Connectez-vous pour accéder à cette consultation.</p>
        <a className="button" href={`/login?next=/pro/consultation/${id}`}>
          Se connecter
        </a>
      </main>
    );
  }

  // Scoped by policy to this doctor's own appointments: another doctor's id
  // simply returns nothing, which becomes a 404 rather than a permission
  // error, so the page never confirms that the appointment exists.
  const { data: appointment } = await supabase
    .from("appointments")
    .select(
      "id,start_at,end_at,status,reason,patient_id,profiles!appointments_patient_id_fkey(full_name,phone)",
    )
    .eq("id", id)
    .maybeSingle();

  if (!appointment) notFound();

  const patient = (appointment as unknown as {
    profiles: { full_name: string | null; phone: string | null } | null;
  }).profiles;

  const start = new Date(appointment.start_at);
  // An unrecognised status would be a schema change this page has not caught
  // up with; treating it as a fresh request is the reading that offers the
  // practitioner the most to do about it.
  const status = isAppointmentStatus(appointment.status) ? appointment.status : "requested";

  const { data: documents } = await supabase
    .from("documents")
    .select(
      "id,patient_id,appointment_id,uploaded_by,storage_path,filename,mime_type,size_bytes,kind,note,created_at",
    )
    .eq("appointment_id", id)
    .order("created_at", { ascending: false });

  const items: DocumentListItem[] = (documents ?? []).map((row) => ({
    ...(row as DocumentListItem),
    kind: row.kind as DocumentKind,
    sharedWith: null,
    fromDoctor: row.uploaded_by === user.id ? "vous" : null,
  }));

  return (
    <main className="container">
      <a className="muted" href="/pro">
        ← Espace praticien
      </a>

      <h1>{patient?.full_name ?? "Patient"}</h1>
      <p className="muted">
        {formatDayLong(start)} à {formatTime(start)}
        {patient?.phone ? " · " : ""}
        {patient?.phone && <a href={`tel:${patient.phone}`}>{patient.phone}</a>}
      </p>
      <p className="chips">
        <span className={`chip ${statusTone(status) === "neutral" ? "" : statusTone(status)}`}>
          {statusLabel(status, "doctor")}
        </span>
      </p>
      {appointment.reason && <p>{appointment.reason}</p>}

      <section className="card section">
        <h2>Ce rendez-vous</h2>
        <AppointmentDecision
          appointmentId={appointment.id}
          status={status}
          startAt={appointment.start_at}
        />
      </section>

      <section className="section">
        <h2>Documents du patient</h2>
        <p className="muted">
          Uniquement les documents que le patient a rattachés à ce rendez-vous.
        </p>
        <DocumentList documents={items} readOnly />
      </section>

      <section className="card section">
        <h2>Envoyer un document au patient</h2>
        <p className="muted">
          Ordonnance, compte rendu ou lettre d&apos;orientation. Le document apparaît aussitôt
          dans l&apos;espace du patient.
        </p>
        <DocumentUploader fixedAppointmentId={appointment.id} defaultKind="prescription" />
      </section>
    </main>
  );
}
