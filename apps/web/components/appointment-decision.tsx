"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  doctorActions,
  statusLabel,
  type DoctorAction,
} from "../lib/booking/status";
import type { AppointmentStatus } from "../lib/booking/status";
import {
  setAppointmentStatus,
  type DecisionState,
} from "../app/pro/consultation/[id]/actions";

/**
 * The practitioner's answer to a booking.
 *
 * Which buttons appear comes from `doctorActions`, which mirrors the database
 * trigger — so "effectuée" and "absent" only show once the consultation has
 * started, and nothing shows at all once the appointment is closed.
 *
 * Cancelling and marking a patient absent ask twice. Both are final in the
 * database, and cancelling now sends the patient a text message, so a
 * mis-click is not something that can be quietly taken back.
 */
export function AppointmentDecision({
  appointmentId,
  status,
  startAt,
}: {
  appointmentId: string;
  status: AppointmentStatus;
  startAt: string;
}) {
  const [state, action] = useActionState<DecisionState, FormData>(setAppointmentStatus, {});
  const [confirming, setConfirming] = useState<DoctorAction | null>(null);

  // The server action revalidates, so after a successful decision the page
  // re-renders with the new status and a different set of buttons; `done` is
  // only used to say what just happened.
  const available = doctorActions(status, new Date(startAt));

  return (
    <form action={action} className="decision">
      <input type="hidden" name="appointmentId" value={appointmentId} />

      {state.error && (
        <p className="notice danger" role="alert">
          {state.error}
        </p>
      )}
      {state.done && (
        <p className="notice success" role="status">
          {statusLabel(state.done, "doctor")}.
          {state.done === "cancelled" && " Le patient est prévenu par SMS."}
        </p>
      )}

      {available.length === 0 ? (
        <p className="muted">Ce rendez-vous est clos : son issue ne change plus.</p>
      ) : (
        available.map((item) => {
          const isConfirming = confirming === item.action;

          if (item.destructive && !isConfirming) {
            return (
              <div key={item.action} className="decision-row">
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => setConfirming(item.action)}
                >
                  {item.label}
                </button>
                {item.hint && <small className="muted">{item.hint}</small>}
              </div>
            );
          }

          if (item.destructive) {
            return (
              <div key={item.action} className="decision-row confirming">
                <p>
                  <strong>
                    {item.action === "no_show"
                      ? "Noter ce patient comme absent ?"
                      : "Annuler définitivement ce rendez-vous ?"}
                  </strong>
                </p>
                <p className="muted">
                  C&apos;est définitif.
                  {item.action === "cancel"
                    ? " Le patient reçoit aussitôt un SMS."
                    : " Le patient n'en est pas informé."}
                </p>
                <div className="row">
                  <Submit name="status" value={item.status} className="danger-button">
                    Oui, {item.label.toLowerCase()}
                  </Submit>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setConfirming(null)}
                  >
                    Revenir
                  </button>
                </div>
              </div>
            );
          }

          return (
            <div key={item.action} className="decision-row">
              <Submit name="status" value={item.status} className="button">
                {item.label}
              </Submit>
              {item.hint && <small className="muted">{item.hint}</small>}
            </div>
          );
        })
      )}
    </form>
  );
}

function Submit({
  name,
  value,
  className,
  children,
}: {
  name: string;
  value: string;
  className: string;
  children: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} className={className} disabled={pending}>
      {pending ? "…" : children}
    </button>
  );
}
