import { notFound } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { cancelAppointment } from "../../doctors/[id]/reserver/actions";
import { DocumentUploader } from "../../../components/document-uploader";
import { formatDayLong, formatTime } from "../../../lib/booking/slots";
import {
  canPatientCancel,
  isAppointmentStatus,
  isClosed,
  statusLabel,
  statusTone,
} from "../../../lib/booking/status";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mon rendez-vous · Tabib.ma", robots: { index: false } };

/**
 * One appointment, from the patient's side.
 *
 * Row-level security limits this to the patient's own, so another patient's
 * id simply returns nothing and becomes a 404 — the page never confirms that
 * an appointment exists.
 */
export default async function AppointmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const justBooked = query.nouveau === "1";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="container narrow">
        <h1>Mon rendez-vous</h1>
        <p>Connectez-vous pour voir ce rendez-vous.</p>
        <a className="button" href={`/login?next=/appointments/${id}`}>Se connecter</a>
      </main>
    );
  }

  const { data: appointment } = await supabase
    .from("appointments")
    .select("id,start_at,end_at,status,reason,doctor_id,doctor_profiles(display_name,specialty,city)")
    .eq("id", id)
    .maybeSingle();

  if (!appointment) notFound();

  const doctor = (appointment as unknown as {
    doctor_profiles: { display_name: string; specialty: string; city: string } | null;
  }).doctor_profiles;

  const start = new Date(appointment.start_at);
  const status = isAppointmentStatus(appointment.status) ? appointment.status : "requested";
  const cancelled = status === "cancelled";
  const settled = isClosed(status);
  // The same rule the database enforces: a patient may withdraw up to the
  // minute the consultation starts, and not afterwards. Offering the button
  // outside that window would only produce a refusal.
  const cancellable = canPatientCancel(status, start);

  return (
    <main className="container narrow">
      {justBooked && !cancelled && (
        <p className="notice success" role="status">
          Rendez-vous confirmé. Vous pouvez joindre vos analyses ci-dessous.
        </p>
      )}

      <h1>Mon rendez-vous</h1>

      <section className="card section">
        <p><strong>{doctor?.display_name ?? "Praticien"}</strong></p>
        <p className="muted">
          {doctor?.specialty}
          {doctor?.city ? ` · ${doctor.city}` : ""}
        </p>
        <p className={settled ? "muted struck" : "time"}>
          {formatDayLong(start)} à {formatTime(start)}
        </p>
        {appointment.reason && <p className="muted">{appointment.reason}</p>}
        <p className="chips">
          <span className={`chip ${statusTone(status) === "neutral" ? "" : statusTone(status)}`}>
            {statusLabel(status, "patient")}
          </span>
        </p>

        {status === "requested" && (
          <p className="muted">
            Le praticien doit encore confirmer ce rendez-vous. Présentez-vous à l&apos;heure
            prévue sauf avis contraire du cabinet.
          </p>
        )}
        {status === "no_show" && (
          <p className="muted">
            Le cabinet a noté que vous ne vous êtes pas présenté. Contactez-le si c&apos;est une
            erreur.
          </p>
        )}

        {cancellable ? (
          <form action={cancelAppointment}>
            <input type="hidden" name="appointmentId" value={appointment.id} />
            <button type="submit" className="danger-button">Annuler ce rendez-vous</button>
            <small className="muted">
              Annulez dès que vous le savez : le créneau repart aussitôt à un autre patient.
            </small>
          </form>
        ) : (
          !settled && (
            <p className="muted">
              Ce rendez-vous a déjà commencé : pour l&apos;annuler, appelez le cabinet.
            </p>
          )
        )}
      </section>

      {!settled && (
        <section className="card section">
          <h2>Joindre un document</h2>
          <p className="muted">
            Analyses ou radios à montrer au praticien. Il n&apos;aura accès qu&apos;aux documents
            rattachés à ce rendez-vous.
          </p>
          <DocumentUploader fixedAppointmentId={appointment.id} defaultKind="analysis" />
        </section>
      )}
    </main>
  );
}
