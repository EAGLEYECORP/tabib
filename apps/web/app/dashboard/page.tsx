import { createClient } from '../../lib/supabase/server';
import { dayLabel, formatTime } from '../../lib/booking/slots';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Mes rendez-vous · Tabib.ma', robots: { index: false } };

export default async function Dashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="container">
        <h1>Mes rendez-vous</h1>
        <p>Connectez-vous pour accéder à vos rendez-vous.</p>
        <a className="button" href="/login?next=/dashboard">Se connecter</a>
      </main>
    );
  }

  const { data } = await supabase
    .from('appointments')
    .select('id,start_at,status,reason,doctor_profiles(display_name,specialty,city)')
    .order('start_at', { ascending: true });

  type Row = {
    id: string;
    start_at: string;
    status: string;
    reason: string | null;
    doctor_profiles: { display_name: string; specialty: string; city: string } | null;
  };

  const all = (data ?? []) as unknown as Row[];
  const now = Date.now();
  const upcoming = all.filter(
    (a) => new Date(a.start_at).getTime() >= now && a.status !== 'cancelled',
  );
  const past = all
    .filter((a) => new Date(a.start_at).getTime() < now || a.status === 'cancelled')
    .reverse();

  return (
    <main className="container">
      <h1>Mes rendez-vous</h1>

      <section className="section">
        <h2>À venir</h2>
        {upcoming.length === 0 ? (
          <div className="card empty">
            <p><strong>Aucun rendez-vous à venir.</strong></p>
            <a className="button" href="/search">Trouver un praticien</a>
          </div>
        ) : (
          <ul className="documents">
            {upcoming.map((appointment) => (
              <li key={appointment.id} className="card">
                <Appointment appointment={appointment} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {past.length > 0 && (
        <section className="section">
          <h2>Passés</h2>
          <ul className="documents">
            {past.slice(0, 20).map((appointment) => (
              <li key={appointment.id} className="card muted-card">
                <Appointment appointment={appointment} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Appointment({
  appointment,
}: {
  appointment: {
    id: string;
    start_at: string;
    status: string;
    reason: string | null;
    doctor_profiles: { display_name: string; specialty: string; city: string } | null;
  };
}) {
  const start = new Date(appointment.start_at);
  const cancelled = appointment.status === 'cancelled';

  return (
    <div className="doc-head">
      <div>
        <strong>{appointment.doctor_profiles?.display_name ?? 'Praticien'}</strong>
        <p className="muted">
          {appointment.doctor_profiles?.specialty}
          {appointment.doctor_profiles?.city ? ` · ${appointment.doctor_profiles.city}` : ''}
        </p>
        <p className={cancelled ? 'muted struck' : ''}>
          {dayLabel(start)} à {formatTime(start)}
        </p>
        {appointment.reason && <p className="muted">{appointment.reason}</p>}
        <p className="chips">
          <span className={cancelled ? 'chip' : 'chip success'}>{appointment.status}</span>
        </p>
      </div>
      <div className="doc-actions">
        <a className="secondary" href={`/appointments/${appointment.id}`}>Ouvrir</a>
      </div>
    </div>
  );
}
