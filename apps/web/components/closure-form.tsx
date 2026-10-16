"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { closePeriod, type ClosureState } from "../app/pro/disponibilites/actions";

/**
 * Closing time off.
 *
 * A closure hides free slots without touching the opening hours underneath,
 * so a practitioner keeps their Tuesday mornings after a week away. What it
 * deliberately does *not* do is cancel appointments already booked inside it:
 * those people have a place in the diary and are owed a phone call, not a
 * silent disappearance. The form hands back their names and numbers so that
 * call can actually happen.
 */
export function ClosureForm({ today }: { today: string }) {
  const [state, action] = useActionState<ClosureState, FormData>(closePeriod, {});

  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [allDay, setAllDay] = useState(true);

  return (
    <form action={action} className="card section">
      {state.error && (
        <p className="notice danger" role="alert">
          {state.error}
        </p>
      )}

      {state.closed && (
        <div role="status">
          <p className="notice success">Fermeture enregistrée.</p>
          {state.affected && state.affected.length > 0 && (
            <div className="notice warn">
              <p>
                <strong>
                  {state.affected.length === 1
                    ? "1 rendez-vous déjà pris tombe dans cette période."
                    : `${state.affected.length} rendez-vous déjà pris tombent dans cette période.`}
                </strong>
              </p>
              <p>
                Ils restent valables : à vous de prévenir ces patients et de les reprogrammer.
              </p>
              <ul className="affected">
                {state.affected.map((appointment) => (
                  <li key={appointment.appointmentId}>
                    <strong>{appointment.patientName || "Patient"}</strong>
                    {" — "}
                    {new Date(appointment.startAt).toLocaleString("fr-FR", {
                      timeZone: "Africa/Casablanca",
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                    {appointment.patientPhone && (
                      <>
                        {" — "}
                        <a href={`tel:${appointment.patientPhone}`}>{appointment.patientPhone}</a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="fields">
        <div>
          <label htmlFor="fromDate">Du</label>
          <input
            id="fromDate"
            name="fromDate"
            type="date"
            required
            min={today}
            value={fromDate}
            onChange={(event) => {
              setFromDate(event.target.value);
              // Keeping the end in step avoids the most common slip: a closure
              // that ends before it starts.
              if (event.target.value > toDate) setToDate(event.target.value);
            }}
          />
        </div>

        <div>
          <label htmlFor="toDate">Au</label>
          <input
            id="toDate"
            name="toDate"
            type="date"
            required
            min={fromDate}
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
          />
        </div>

        {!allDay && (
          <>
            <div>
              <label htmlFor="fromTime">Heure de début</label>
              <input id="fromTime" name="fromTime" type="time" step={300} defaultValue="12:00" />
            </div>
            <div>
              <label htmlFor="toTime">Heure de fin</label>
              <input id="toTime" name="toTime" type="time" step={300} defaultValue="18:00" />
            </div>
          </>
        )}

        <div className="wide">
          <label htmlFor="reason">Motif (facultatif, visible de vous seul)</label>
          <input
            id="reason"
            name="reason"
            maxLength={200}
            placeholder="Ex. : congé, conférence, Aïd"
          />
        </div>
      </div>

      <label className="inline">
        <input
          type="checkbox"
          name="allDay"
          checked={allDay}
          onChange={(event) => setAllDay(event.target.checked)}
        />
        Journée(s) entière(s)
      </label>

      <p className="muted">
        Les créneaux concernés disparaissent de votre profil. Vos horaires habituels sont
        conservés et reviennent une fois la fermeture passée.
      </p>

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="button" type="submit" disabled={pending}>
      {pending ? "Enregistrement…" : "Fermer cette période"}
    </button>
  );
}
