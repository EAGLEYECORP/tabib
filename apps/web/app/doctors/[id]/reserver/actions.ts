"use server";

import { redirect } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";

/**
 * Confirming a booking.
 *
 * The slot is re-checked by the database on the way in — the insert policy
 * requires it to fall inside an open availability block and to respect the
 * lead time, and the exclusion constraint refuses anything overlapping a live
 * appointment. So this action does not re-validate the time itself; it
 * submits, and turns the two refusals that matter into something a patient can
 * act on.
 */

export interface BookingState {
  readonly error?: string;
}

/** PostgreSQL raises this when the no-overlap exclusion constraint is hit. */
const EXCLUSION_VIOLATION = "23P01";
/** Supabase surfaces a row-level security refusal under this code. */
const RLS_VIOLATION = "42501";

export async function bookSlot(
  _previous: BookingState,
  formData: FormData,
): Promise<BookingState> {
  const doctorId = String(formData.get("doctorId") ?? "");
  const startAt = String(formData.get("start") ?? "");
  const endAt = String(formData.get("end") ?? "");
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
  const fullName = String(formData.get("fullName") ?? "").trim().slice(0, 120);

  if (!doctorId || !startAt || !endAt) {
    return { error: "Ce créneau n'est plus valide. Choisissez-en un autre." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = `/doctors/${doctorId}/reserver?start=${encodeURIComponent(
      startAt,
    )}&end=${encodeURIComponent(endAt)}`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  // A patient signing in for the first time has a profile with no name on it;
  // the cabinet needs one to call out in the waiting room.
  if (fullName) {
    await supabase.from("profiles").update({ full_name: fullName }).eq("id", user.id);
  }

  const { data, error } = await supabase
    .from("appointments")
    .insert({
      patient_id: user.id,
      doctor_id: doctorId,
      start_at: startAt,
      end_at: endAt,
      reason: reason || null,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === EXCLUSION_VIOLATION) {
      return { error: "Ce créneau vient d'être réservé. Choisissez-en un autre." };
    }
    if (error.code === RLS_VIOLATION) {
      return {
        error:
          "Ce créneau n'est plus proposé par le praticien. Revenez à son profil pour en choisir un autre.",
      };
    }
    return { error: "La réservation a échoué. Veuillez réessayer." };
  }

  // redirect throws, so it stays outside the block above or it would be
  // reported as a booking failure.
  redirect(`/appointments/${data.id}?nouveau=1`);
}

/**
 * Cancelling frees the slot immediately: available_slots ignores it at once.
 *
 * The database refuses this once the consultation has started, or once it
 * already has an outcome — see `guard_appointment_update`. The refusal is not
 * turned into a message here because the only way to reach it is a page left
 * open: the redirect re-renders it with the real status and the line that
 * explains what to do instead, which is more use than an error about a button
 * that should no longer have been there.
 */
export async function cancelAppointment(formData: FormData): Promise<void> {
  const appointmentId = String(formData.get("appointmentId") ?? "");
  if (!appointmentId) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", appointmentId);

  redirect(`/appointments/${appointmentId}`);
}
