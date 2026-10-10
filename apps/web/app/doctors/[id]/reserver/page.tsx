import { notFound, redirect } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";
import { BookingForm } from "../../../../components/booking-form";
import { formatDayLong, formatTime } from "../../../../lib/booking/slots";

export const dynamic = "force-dynamic";
export const metadata = { title: "Confirmer le rendez-vous · Tabib.ma", robots: { index: false } };

/**
 * Confirming one slot.
 *
 * The slot is checked against live availability before the form is shown, so
 * a patient does not fill in their details for a time that went while they
 * were deciding. The database checks again on submit, which is what actually
 * decides; this is only about not wasting their time.
 */
export default async function ReservePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const startParam = typeof query.start === "string" ? query.start : "";
  const endParam = typeof query.end === "string" ? query.end : "";
  const start = new Date(startParam);
  const end = new Date(endParam);

  if (!startParam || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    redirect(`/doctors/${id}`);
  }

  const supabase = await createClient();

  const { data: doctor } = await supabase
    .from("doctor_profiles")
    .select("id,display_name,specialty,city")
    .eq("id", id)
    .maybeSingle();

  if (!doctor) notFound();

  const { data: rows } = await supabase.rpc("available_slots", {
    p_doctor_id: id,
    p_days: 60,
  });

  const stillFree = ((rows ?? []) as { slot_start: string }[]).some(
    (row) => new Date(row.slot_start).getTime() === start.getTime(),
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let knownName: string | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();
    knownName = profile?.full_name ?? null;
  }

  return (
    <main className="container narrow">
      <a className="muted" href={`/doctors/${id}`}>
        ← Retour au profil
      </a>

      <h1>Confirmer votre rendez-vous</h1>

      <section className="card section">
        <p>
          <strong>{doctor.display_name}</strong>
        </p>
        <p className="muted">
          {doctor.specialty} · {doctor.city}
        </p>
        <p className="time">
          {formatDayLong(start)} à {formatTime(start)}
        </p>
        <p className="muted">
          Heure de {doctor.city}. Durée : {Math.round((end.getTime() - start.getTime()) / 60000)}{" "}
          minutes.
        </p>
      </section>

      {!stillFree ? (
        <section className="card section">
          <p className="notice danger">
            Ce créneau vient d&apos;être réservé ou n&apos;est plus proposé.
          </p>
          <a className="button" href={`/doctors/${id}`}>
            Choisir un autre créneau
          </a>
        </section>
      ) : !user ? (
        <section className="card section">
          <p>Connectez-vous pour confirmer ce rendez-vous. Le créneau vous sera réservé ensuite.</p>
          <a
            className="button"
            href={`/login?next=${encodeURIComponent(
              `/doctors/${id}/reserver?start=${startParam}&end=${endParam}`,
            )}`}
          >
            Se connecter
          </a>
        </section>
      ) : (
        <BookingForm
          doctorId={id}
          start={start.toISOString()}
          end={end.toISOString()}
          knownName={knownName}
        />
      )}
    </main>
  );
}
