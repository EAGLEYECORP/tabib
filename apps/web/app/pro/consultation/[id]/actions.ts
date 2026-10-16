"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "../../../../lib/supabase/server";
import { isAppointmentStatus, type AppointmentStatus } from "../../../../lib/booking/status";

/**
 * Answering a booking request.
 *
 * Which changes of status a practitioner may make is decided by
 * `guard_appointment_update` in the database, not here — this action submits
 * and turns the two refusals a practitioner can actually hit into something
 * worth reading. The common one is a race: a patient cancels while the
 * practitioner is looking at the page, and the appointment is already closed
 * by the time they click.
 */

/** PostgreSQL's check_violation, raised by the guard trigger. */
const CHECK_VIOLATION = "23514";
/** A row-level security refusal, or the trigger's "not a party". */
const RLS_VIOLATION = "42501";

/** Statuses a practitioner may set. Anything else is not theirs to decide. */
const DOCTOR_SETTABLE: readonly AppointmentStatus[] = [
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
];

export interface DecisionState {
  readonly error?: string;
  readonly done?: AppointmentStatus;
}

export async function setAppointmentStatus(
  _previous: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const appointmentId = String(formData.get("appointmentId") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!appointmentId || !isAppointmentStatus(status)) {
    return { error: "Action inconnue." };
  }
  if (!DOCTOR_SETTABLE.includes(status)) {
    return { error: "Action inconnue." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/pro/consultation/${appointmentId}`);

  const { error } = await supabase
    .from("appointments")
    .update({ status })
    .eq("id", appointmentId);

  if (error) {
    if (error.code === CHECK_VIOLATION) {
      // The trigger's message says which rule was broken, but it is written
      // for whoever reads the logs. The practitioner gets the reason that
      // actually applies to a page left open for a while.
      return {
        error:
          "Ce rendez-vous a changé entre-temps — il a peut-être été annulé par le patient. Rechargez la page.",
      };
    }
    if (error.code === RLS_VIOLATION) {
      return { error: "Ce rendez-vous n'est pas dans votre agenda." };
    }
    return { error: "La mise à jour a échoué. Veuillez réessayer." };
  }

  revalidatePath(`/pro/consultation/${appointmentId}`);
  revalidatePath("/pro");
  return { done: status };
}
