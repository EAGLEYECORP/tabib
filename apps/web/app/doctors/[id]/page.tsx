import { notFound } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import {
  dayLabel,
  formatTime,
  groupByDay,
  nextAvailability,
  toSlots,
} from "../../../lib/booking/slots";

export const dynamic = "force-dynamic";

/** Two weeks is as far ahead as a cabinet's diary is usually meaningful. */
const HORIZON_DAYS = 14;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("doctor_profiles")
    .select("display_name,specialty,city")
    .eq("id", id)
    .maybeSingle();

  if (!data) return { title: "Praticien · Tabib.ma" };
  return {
    title: `${data.display_name} — ${data.specialty}, ${data.city} · Tabib.ma`,
    description: `Prendre rendez-vous avec ${data.display_name}, ${data.specialty} à ${data.city}.`,
  };
}

/**
 * A practitioner's profile and their free slots.
 *
 * Availability is public, so this page works signed out — someone comparing
 * doctors should not have to create an account to see who has something free
 * this week. Signing in is asked for at the moment of booking, not before.
 *
 * The slots come from the `available_slots` function rather than from a query
 * here, because working out what is free means knowing which times are taken,
 * and a patient must not be able to read other patients' appointments. The
 * function runs as its owner and returns times only, never who holds them.
 */
export default async function DoctorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: doctor } = await supabase
    .from("doctor_profiles")
    .select("id,display_name,specialty,city,bio,verified")
    .eq("id", id)
    .maybeSingle();

  if (!doctor) notFound();

  const { data: rows } = await supabase.rpc("available_slots", {
    p_doctor_id: id,
    p_days: HORIZON_DAYS,
  });

  const slots = toSlots(rows as { slot_start: string; slot_end: string }[] | null);
  const days = groupByDay(slots);
  const soonest = nextAvailability(slots);

  return (
    <main className="container">
      <a className="muted" href="/search">
        ← Tous les praticiens
      </a>

      <header className="section">
        <h1>{doctor.display_name}</h1>
        <p className="muted">
          {doctor.specialty} · {doctor.city}
        </p>
        <p className="chips">
          {doctor.verified && <span className="chip success">Praticien vérifié</span>}
          {soonest ? (
            <span className="chip accent">
              Prochaine disponibilité : {dayLabel(soonest.start)} à {formatTime(soonest.start)}
            </span>
          ) : (
            <span className="chip">Aucune disponibilité en ligne</span>
          )}
        </p>
        {doctor.bio && <p>{doctor.bio}</p>}
      </header>

      <section className="section">
        <h2>Prendre rendez-vous</h2>

        {days.length === 0 ? (
          <div className="card empty">
            <p>
              <strong>Aucun créneau disponible dans les {HORIZON_DAYS} prochains jours.</strong>
            </p>
            <p className="muted">
              Ce praticien n&apos;a pas ouvert de créneaux en ligne pour le moment. Contactez le
              cabinet directement.
            </p>
          </div>
        ) : (
          <div className="days">
            {days.map((day) => (
              <section key={day.date} className="day">
                <h3>{dayLabel(day.anchor)}</h3>
                <ul className="slots">
                  {day.slots.map((slot) => {
                    const query = new URLSearchParams({
                      start: slot.start.toISOString(),
                      end: slot.end.toISOString(),
                    });
                    return (
                      <li key={slot.start.toISOString()}>
                        {/* A link, not a button: the slot is a place, so it
                            can be opened in a new tab or shared, and it works
                            before any JavaScript has loaded. */}
                        <a className="slot" href={`/doctors/${doctor.id}/reserver?${query}`}>
                          {formatTime(slot.start)}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
