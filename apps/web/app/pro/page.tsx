import { createClient } from "../../lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Espace praticien · Tabib.ma", robots: { index: false } };

/**
 * The practitioner's day.
 *
 * Deliberately narrow: who is coming, when, and whether they sent anything
 * ahead. A doctor opening this between two patients needs the next name and
 * whether there is a scan to look at, not a dashboard.
 *
 * The appointment rows come back filtered by row-level security to this
 * doctor's own, and the document counts with them — a doctor cannot see a
 * consultation, or a file, that is not theirs.
 */
export default async function PractitionerPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="container">
        <h1>Espace praticien</h1>
        <p>Connectez-vous avec le mobile enregistré auprès de Tabib.ma.</p>
        <a className="button" href="/login?next=/pro">
          Se connecter
        </a>
      </main>
    );
  }

  const { data: profile } = await supabase
    .from("doctor_profiles")
    .select("id,display_name,specialty,city")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    return (
      <main className="container">
        <h1>Espace praticien</h1>
        <p className="notice danger">
          Ce compte n&apos;est pas rattaché à un profil praticien. Contactez Tabib.ma si vous
          pensez qu&apos;il s&apos;agit d&apos;une erreur.
        </p>
      </main>
    );
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const { data: appointments } = await supabase
    .from("appointments")
    .select("id,start_at,end_at,status,reason,patient_id,profiles!appointments_patient_id_fkey(full_name,phone)")
    .gte("start_at", startOfDay.toISOString())
    .lt("start_at", endOfDay.toISOString())
    .in("status", ["requested", "confirmed"])
    .order("start_at", { ascending: true });

  type Row = {
    id: string;
    start_at: string;
    status: string;
    reason: string | null;
    profiles: { full_name: string | null; phone: string | null } | null;
  };
  const today = (appointments ?? []) as unknown as Row[];

  // One query for the documents shared across today's consultations, rather
  // than one per row.
  const { data: documents } = await supabase
    .from("documents")
    .select("id,appointment_id")
    .in("appointment_id", today.length > 0 ? today.map((a) => a.id) : ["none"]);

  const counts = new Map<string, number>();
  for (const document of documents ?? []) {
    if (!document.appointment_id) continue;
    counts.set(document.appointment_id, (counts.get(document.appointment_id) ?? 0) + 1);
  }

  return (
    <main className="container">
      <h1>Espace praticien</h1>
      <p className="muted">
        {profile.display_name} · {profile.specialty} · {profile.city}
      </p>
      <p className="row">
        <a className="secondary" href="/pro/disponibilites">Mes disponibilités</a>
        <a className="secondary" href={`/doctors/${profile.id}`}>Mon profil public</a>
      </p>

      <section className="section">
        <h2>
          {new Date().toLocaleDateString("fr-FR", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </h2>
        <p className="muted">
          {today.length === 0
            ? "Aucun rendez-vous aujourd'hui."
            : today.length === 1
              ? "1 consultation"
              : `${today.length} consultations`}
        </p>

        <ul className="documents">
          {today.map((appointment) => {
            const shared = counts.get(appointment.id) ?? 0;
            return (
              <li key={appointment.id} className="card">
                <div className="doc-head">
                  <div>
                    <strong className="time">
                      {new Date(appointment.start_at).toLocaleTimeString("fr-FR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </strong>
                    <p>
                      <strong>{appointment.profiles?.full_name ?? "Patient"}</strong>
                    </p>
                    {appointment.profiles?.phone && (
                      <p className="muted">{appointment.profiles.phone}</p>
                    )}
                    {appointment.reason && <p className="muted">{appointment.reason}</p>}
                    <p className="chips">
                      <span className="chip">{appointment.status}</span>
                      {shared > 0 && (
                        <span className="chip success">
                          {shared === 1 ? "1 document" : `${shared} documents`}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="doc-actions">
                    <a className="secondary" href={`/pro/consultation/${appointment.id}`}>
                      Ouvrir
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
