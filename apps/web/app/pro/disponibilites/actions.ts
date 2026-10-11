"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "../../../lib/supabase/server";
import { validateBlock, weeklyBlocks } from "../../../lib/booking/wall-time";

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
