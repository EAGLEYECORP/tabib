import { createClient } from "../../../lib/supabase/server";
import { AvailabilityForm } from "../../../components/availability-form";
import { closeAvailability } from "./actions";
import { dayLabel, formatTime, localDate, MOROCCO_TIME_ZONE } from "../../../lib/booking/slots";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mes disponibilités · Tabib.ma", robots: { index: false } };

/**
 * A practitioner's opening hours.
 *
 * Blocks are shown with the number of consultations each yields and how many
 * are already taken, because that is what a doctor actually wants to know
 * before closing one. Withdrawing a block never cancels an appointment
 * already booked into it — those people keep their place, and the page says
 * so where it matters.
 */
export default async function AvailabilityPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="container">
        <h1>Mes disponibilités</h1>
        <p>Connectez-vous avec le mobile enregistré auprès de Tabib.ma.</p>
        <a className="button" href="/login?next=/pro/disponibilites">Se connecter</a>
      </main>
    );
  }

  const { data: profile } = await supabase
    .from("doctor_profiles")
    .select("id,display_name")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    return (
      <main className="container">
        <h1>Mes disponibilités</h1>
        <p className="notice danger">
          Ce compte n&apos;est pas rattaché à un profil praticien.
        </p>
      </main>
    );
  }

  const now = new Date();

  const [{ data: blocks }, { data: appointments }] = await Promise.all([
    supabase
      .from("doctor_availability")
      .select("id,start_at,end_at,slot_minutes,status")
      .gte("end_at", now.toISOString())
      .order("start_at", { ascending: true }),
    supabase
      .from("appointments")
      .select("id,start_at")
      .gte("start_at", now.toISOString())
      .in("status", ["requested", "confirmed"]),
  ]);

  type Block = {
    id: string;
    start_at: string;
    end_at: string;
    slot_minutes: number;
    status: string;
  };

  const upcoming = (blocks ?? []) as Block[];
  const booked = (appointments ?? []).map((a) => new Date(a.start_at).getTime());

  /** How many of this block's consultations are already taken. */
  const bookedIn = (block: Block) => {
    const from = new Date(block.start_at).getTime();
    const to = new Date(block.end_at).getTime();
    return booked.filter((at) => at >= from && at < to).length;
  };

  const capacity = (block: Block) => {
    const minutes = (new Date(block.end_at).getTime() - new Date(block.start_at).getTime()) / 60000;
    return Math.floor(minutes / block.slot_minutes);
  };

  // The form's minimum date is today in the cabinet's zone, not the
  // practitioner's device, so a doctor travelling cannot be offered yesterday.
  const todayLocal = localDate(now, MOROCCO_TIME_ZONE);

  return (
    <main className="container">
      <a className="muted" href="/pro">← Espace praticien</a>

      <h1>Mes disponibilités</h1>
      <p className="muted">
        Ouvrez des plages de consultation : elles deviennent des créneaux réservables sur votre
        profil public.
      </p>

      <section className="section">
        <h2>Ouvrir des créneaux</h2>
        <AvailabilityForm today={todayLocal} />
      </section>

      <section className="section">
        <h2>Plages à venir</h2>
        {upcoming.length === 0 ? (
          <div className="card empty">
            <p><strong>Aucune plage ouverte.</strong></p>
            <p className="muted">
              Tant qu&apos;aucune plage n&apos;est ouverte, votre profil indique qu&apos;aucun
              créneau n&apos;est disponible en ligne.
            </p>
          </div>
        ) : (
          <ul className="documents">
            {upcoming.map((block) => {
              const start = new Date(block.start_at);
              const end = new Date(block.end_at);
              const taken = bookedIn(block);
              const total = capacity(block);

              return (
                <li key={block.id} className="card">
                  <div className="doc-head">
                    <div>
                      <strong>{dayLabel(start)}</strong>
                      <p className="time">
                        {formatTime(start)} – {formatTime(end)}
                      </p>
                      <p className="muted">
                        {total} consultation{total > 1 ? "s" : ""} de {block.slot_minutes} minutes
                      </p>
                      <p className="chips">
                        {taken > 0 ? (
                          <span className="chip success">
                            {taken} réservée{taken > 1 ? "s" : ""}
                          </span>
                        ) : (
                          <span className="chip">Aucune réservation</span>
                        )}
                        {block.status !== "open" && <span className="chip">{block.status}</span>}
                      </p>
                    </div>

                    <div className="doc-actions">
                      <form action={closeAvailability}>
                        <input type="hidden" name="blockId" value={block.id} />
                        <button type="submit" className="danger-button">
                          Retirer
                        </button>
                      </form>
                      {taken > 0 && (
                        <small className="muted">
                          Les rendez-vous déjà pris sont conservés.
                        </small>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
