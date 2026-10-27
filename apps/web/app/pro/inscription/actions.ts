"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "../../../lib/supabase/server";

/**
 * Registering as a practitioner.
 *
 * A request, not an admission: `register_practitioner` always writes the
 * profile unverified, and `guard_doctor_profile_update` stops anyone waving
 * themselves through afterwards. Until an administrator verifies it, the
 * profile is out of search and cannot be booked.
 *
 * The same action edits an existing profile, so a practitioner correcting
 * their city does not need a second screen.
 */

export interface RegistrationState {
  readonly error?: string;
  readonly saved?: boolean;
}

const CHECK_VIOLATION = "23514";

export async function registerPractitioner(
  _previous: RegistrationState,
  formData: FormData,
): Promise<RegistrationState> {
  const displayName = String(formData.get("displayName") ?? "").trim().slice(0, 120);
  const specialty = String(formData.get("specialty") ?? "").trim().slice(0, 80);
  const city = String(formData.get("city") ?? "").trim().slice(0, 80);
  const bio = String(formData.get("bio") ?? "").trim().slice(0, 1000);

  if (!displayName || !specialty || !city) {
    return { error: "Renseignez votre nom, votre spécialité et votre ville." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/pro/inscription");

  const { error } = await supabase.rpc("register_practitioner", {
    p_display_name: displayName,
    p_specialty: specialty,
    p_city: city,
    p_bio: bio || null,
  });

  if (error) {
    if (error.code === CHECK_VIOLATION) {
      return { error: "Renseignez votre nom, votre spécialité et votre ville." };
    }
    return { error: "L'enregistrement a échoué. Veuillez réessayer." };
  }

  revalidatePath("/pro");
  revalidatePath("/pro/inscription");
  return { saved: true };
}
