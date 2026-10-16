"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "../../../lib/supabase/server";
import { validateBlock, weeklyBlocks, wallTimeToInstant } from "../../../lib/booking/wall-time";

/**
 * Opening and closing consulting hours.
 *
 * The wall-clock times a practitioner types are resolved to instants here,
 * against the same time-zone data the interface uses to display them back.
 * The database is handed absolute moments and never reinterprets them.
 */

export interface AvailabilityState {
  readonly error?: string;
  readonly opened?: number;
  readonly skipped?: number;
}

const MESSAGES: Record<string, string> = {
  INVALID_TIME: "Vérifiez la date, les horaires et la durée de consultation.",
  ENDS_BEFORE_START: "La plage doit se terminer après son début.",
  SHORTER_THAN_SLOT: "La plage est plus courte qu'une consultation.",
};

export async function openAvailability(
  _previous: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  const date = String(formData.get("date") ?? "");
  const start = String(formData.get("start") ?? "");
  const end = String(formData.get("end") ?? "");
  const slotMinutes = Number(formData.get("slotMinutes") ?? 30);
  const weeks = Number(formData.get("weeks") ?? 1);

  const problem = validateBlock({ date, start, end, slotMinutes });
  if (problem) return { error: MESSAGES[problem] ?? MESSAGES.INVALID_TIME };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/pro/disponibilites");

  const blocks = weeklyBlocks({ date, start, end, weeks }).map((block) => ({
    start: block.start.toISOString(),
    end: block.end.toISOString(),
  }));

  const { data, error } = await supabase.rpc("open_availability", {
    p_blocks: blocks,
    p_slot_minutes: slotMinutes,
  });

  if (error) {
    return { error: error.message || "L'ouverture des créneaux a échoué." };
  }

  const opened = Array.isArray(data) ? data.length : 0;
  revalidatePath("/pro/disponibilites");

  // Weeks already covered are skipped rather than refused, so say so plainly
  // instead of reporting a silent partial success.
  return { opened, skipped: blocks.length - opened };
}

export async function closeAvailability(formData: FormData): Promise<void> {
  const blockId = String(formData.get("blockId") ?? "");
  if (!blockId) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/pro/disponibilites");

  // Scoped by policy to the caller's own rows; appointments already booked
  // into this block are untouched, because withdrawing opening hours must not
  // quietly cancel people who already have a place in the diary.
  await supabase.from("doctor_availability").delete().eq("id", blockId);

  revalidatePath("/pro/disponibilites");
}


// ---------------------------------------------------------------------------
// Closures
// ---------------------------------------------------------------------------

export interface AffectedAppointment {
  readonly appointmentId: string;
  readonly startAt: string;
  readonly patientName: string | null;
  readonly patientPhone: string | null;
}

export interface ClosureState {
  readonly error?: string;
  readonly closed?: boolean;
  /**
   * Patients already booked inside the closure. Their appointments survive it
   * — closing a day must not silently cancel people who have a place in the
   * diary — so the practitioner is handed the list to call.
   */
  readonly affected?: readonly AffectedAppointment[];
}

export async function closePeriod(
  _previous: ClosureState,
  formData: FormData,
): Promise<ClosureState> {
  const fromDate = String(formData.get("fromDate") ?? "");
  const toDate = String(formData.get("toDate") ?? "") || fromDate;
  const allDay = formData.get("allDay") === "on";
  const fromTime = allDay ? "00:00" : String(formData.get("fromTime") ?? "00:00");
  const toTime = allDay ? "00:00" : String(formData.get("toTime") ?? "00:00");
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { error: "Vérifiez les dates." };
  }

  const startsAt = wallTimeToInstant(fromDate, fromTime);

  // A whole-day closure runs to midnight at the end of the last day, so the
  // final afternoon is covered rather than stopping at 00:00 that morning.
  let endDate = toDate;
  if (allDay) {
    const [year, month, day] = toDate.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day));
    next.setUTCDate(next.getUTCDate() + 1);
    endDate = next.toISOString().slice(0, 10);
  }
  const endsAt = wallTimeToInstant(endDate, toTime);

  if (endsAt.getTime() <= startsAt.getTime()) {
    return { error: "La fermeture doit se terminer après son début." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/pro/disponibilites");

  // Who is already booked, asked before the closure exists so the answer is
  // about the period rather than about what survived it.
  const { data: affectedRows } = await supabase.rpc("appointments_in_period", {
    p_starts_at: startsAt.toISOString(),
    p_ends_at: endsAt.toISOString(),
  });

  const { error } = await supabase.from("doctor_absences").insert({
    doctor_id: user.id,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    reason: reason || null,
  });

  if (error) return { error: "La fermeture n'a pas pu être enregistrée." };

  revalidatePath("/pro/disponibilites");

  const affected = ((affectedRows ?? []) as {
    appointment_id: string;
    start_at: string;
    patient_name: string | null;
    patient_phone: string | null;
  }[]).map((row) => ({
    appointmentId: row.appointment_id,
    startAt: row.start_at,
    patientName: row.patient_name,
    patientPhone: row.patient_phone,
  }));

  return { closed: true, affected };
}

export async function reopenPeriod(formData: FormData): Promise<void> {
  const closureId = String(formData.get("closureId") ?? "");
  if (!closureId) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/pro/disponibilites");

  // Scoped by policy to the caller's own closures; lifting one puts the
  // underlying hours straight back on offer.
  await supabase.from("doctor_absences").delete().eq("id", closureId);
  revalidatePath("/pro/disponibilites");
}
