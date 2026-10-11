"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { openAvailability, type AvailabilityState } from "../app/pro/disponibilites/actions";
import { slotsInBlock, validateBlock } from "../lib/booking/wall-time";

/**
 * Opening consulting hours.
 *
 * A practitioner thinks in blocks — "Tuesday mornings, nine to one, twenty
 * minutes each" — so that is what the form asks for, with the resulting
 * number of consultations shown as they type. Getting that count wrong by a
 * misread field is the sort of mistake that only surfaces when a waiting room
 * fills up.
 */
export function AvailabilityForm({ today }: { today: string }) {
  const [state, action] = useActionState<AvailabilityState, FormData>(openAvailability, {});

  const [date, setDate] = useState(today);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("13:00");
  const [slotMinutes, setSlotMinutes] = useState(30);
  const [weeks, setWeeks] = useState(1);

  const problem = validateBlock({ date, start, end, slotMinutes });
  const perWeek = problem ? 0 : slotsInBlock(start, end, slotMinutes);

  return (
    <form action={action} className="card section">
      {state.error && (
        <p className="notice danger" role="alert">
          {state.error}
        </p>
      )}

      {state.opened !== undefined && !state.error && (
        <p className="notice success" role="status">
          {state.opened === 0
            ? "Aucune plage ajoutée : ces horaires sont déjà ouverts."
            : `${state.opened === 1 ? "1 plage ouverte" : `${state.opened} plages ouvertes`}.`}
          {state.skipped ? ` ${state.skipped} semaine(s) déjà couverte(s).` : ""}
        </p>
      )}

      <div className="fields">
        <div>
          <label htmlFor="date">Date</label>
          <input
            id="date"
            name="date"
            type="date"
            required
            min={today}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor="start">Début</label>
          <input
            id="start"
            name="start"
            type="time"
            required
            step={300}
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor="end">Fin</label>
          <input
            id="end"
            name="end"
            type="time"
            required
            step={300}
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor="slotMinutes">Durée d&apos;une consultation</label>
          <select
            id="slotMinutes"
            name="slotMinutes"
            value={slotMinutes}
            onChange={(event) => setSlotMinutes(Number(event.target.value))}
          >
            {[10, 15, 20, 30, 45, 60].map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} minutes
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="weeks">Répéter chaque semaine</label>
          <select
            id="weeks"
            name="weeks"
            value={weeks}
            onChange={(event) => setWeeks(Number(event.target.value))}
          >
            <option value={1}>Cette date uniquement</option>
            {[2, 4, 8, 12, 26].map((count) => (
              <option key={count} value={count}>
                {count} semaines
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="muted">
        {problem === "ENDS_BEFORE_START"
          ? "La plage doit se terminer après son début."
          : problem === "SHORTER_THAN_SLOT"
            ? "La plage est plus courte qu'une consultation."
            : problem
              ? "Vérifiez la date et les horaires."
              : `${perWeek} consultation${perWeek > 1 ? "s" : ""} par semaine` +
                (weeks > 1 ? `, soit ${perWeek * weeks} au total.` : ".")}
      </p>
      <p className="muted">
        Les horaires sont ceux du cabinet (heure du Maroc), quel que soit le fuseau de votre
        appareil.
      </p>

      <Submit disabled={problem !== null} />
    </form>
  );
}

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="button" type="submit" disabled={pending || disabled}>
      {pending ? "Ouverture…" : "Ouvrir ces créneaux"}
    </button>
  );
}
