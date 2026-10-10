"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { bookSlot, type BookingState } from "../app/doctors/[id]/reserver/actions";

/**
 * The last step before an appointment exists.
 *
 * Only what the cabinet needs to hold the slot: a name to call out, and
 * optionally why the patient is coming. Nothing clinical is collected — a
 * booking page is not the place to gather medical history.
 */
export function BookingForm({
  doctorId,
  start,
  end,
  knownName,
}: {
  doctorId: string;
  start: string;
  end: string;
  /** Already on the patient's profile, so they are not asked twice. */
  knownName: string | null;
}) {
  const [state, action] = useActionState<BookingState, FormData>(bookSlot, {});

  return (
    <form action={action} className="card section">
      <input type="hidden" name="doctorId" value={doctorId} />
      <input type="hidden" name="start" value={start} />
      <input type="hidden" name="end" value={end} />

      {state.error && (
        <p className="notice danger" role="alert">
          {state.error}
        </p>
      )}

      {!knownName && (
        <div>
          <label htmlFor="fullName">Nom et prénom</label>
          <input id="fullName" name="fullName" required autoComplete="name" maxLength={120} />
        </div>
      )}

      <div>
        <label htmlFor="reason">Motif de la consultation (facultatif)</label>
        <input
          id="reason"
          name="reason"
          maxLength={500}
          placeholder="Ex. : contrôle de tension"
        />
      </div>

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="button" type="submit" disabled={pending}>
      {pending ? "Confirmation…" : "Confirmer le rendez-vous"}
    </button>
  );
}
