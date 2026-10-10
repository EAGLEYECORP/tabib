import { createClient } from "../../lib/supabase/server";
import { DocumentUploader } from "../../components/document-uploader";
import { DocumentList, type DocumentListItem } from "../../components/document-list";
import type { DocumentKind } from "../../lib/documents/kinds";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mes documents · Tabib.ma", robots: { index: false } };

/**
 * A patient's medical documents.
 *
 * Every query here runs as the signed-in patient, so row-level security is
 * what limits the page to their own record — the page itself has no filtering
 * to forget.
 */
export default async function DocumentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="container">
        <h1>Mes documents</h1>
        <p>Connectez-vous pour consulter et partager vos documents médicaux.</p>
        <a className="button" href="/login?next=/documents">
          Se connecter
        </a>
      </main>
    );
  }

  const [{ data: documents }, { data: appointments }] = await Promise.all([
    supabase
      .from("documents")
      .select(
        "id,patient_id,appointment_id,uploaded_by,storage_path,filename,mime_type,size_bytes,kind,note,created_at",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("appointments")
      .select("id,start_at,doctor_id,status,doctor_profiles(display_name,specialty)")
      .gte("start_at", new Date().toISOString())
      .in("status", ["requested", "confirmed"])
      .order("start_at", { ascending: true }),
  ]);

  type AppointmentRow = {
    id: string;
    start_at: string;
    doctor_id: string;
    doctor_profiles: { display_name: string; specialty: string } | null;
  };

  const upcoming = (appointments ?? []) as unknown as AppointmentRow[];

  // Only future appointments are offered: attaching an analysis to a
  // consultation that already happened helps nobody.
  const shareTargets = upcoming.map((appointment) => ({
    appointmentId: appointment.id,
    label: `${appointment.doctor_profiles?.display_name ?? "Praticien"} — ${new Date(
      appointment.start_at,
    ).toLocaleDateString("fr-FR")}`,
  }));

  const doctorByAppointment = new Map(
    upcoming.map((a) => [a.id, a.doctor_profiles?.display_name ?? "Praticien"]),
  );

  const items: DocumentListItem[] = (documents ?? []).map((row) => ({
    ...(row as DocumentListItem),
    kind: row.kind as DocumentKind,
    sharedWith: row.appointment_id
      ? (doctorByAppointment.get(row.appointment_id) ?? "votre praticien")
      : null,
    fromDoctor: row.uploaded_by !== user.id ? "votre praticien" : null,
  }));

  return (
    <main className="container">
      <h1>Mes documents</h1>
      <p className="muted">
        Analyses, radios, ordonnances. Partagez-les avec un praticien en les rattachant à un
        rendez-vous — et retirez le partage quand vous le souhaitez.
      </p>

      <section className="card section">
        <h2>Ajouter un document</h2>
        <DocumentUploader shareTargets={shareTargets} />
      </section>

      <section className="section">
        <h2>Tous mes documents</h2>
        <DocumentList documents={items} shareTargets={shareTargets} />
      </section>
    </main>
  );
}
