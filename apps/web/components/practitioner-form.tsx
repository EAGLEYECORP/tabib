"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  registerPractitioner,
  type RegistrationState,
} from "../app/pro/inscription/actions";
import { CITIES, SPECIALTIES } from "../lib/morocco/directory";

/**
 * A practitioner's own details.
 *
 * Specialty and city are chosen from lists rather than typed, because a
 * patient searching for "Cardiologie" has to match what the practitioner
 * wrote — free text means "Cardiologue", "cardio" and "Cardiologie " are
 * three different specialties and two of them are unfindable.
 */
export function PractitionerForm({
  existing,
}: {
  existing?: {
    displayName: string;
    specialty: string;
    city: string;
    bio: string | null;
  };
}) {
  const [state, action] = useActionState<RegistrationState, FormData>(
    registerPractitioner,
    {},
  );

  return (
    <form action={action} className="card section">
      {state.error && (
        <p className="notice danger" role="alert">
          {state.error}
        </p>
      )}
      {state.saved && (
        <p className="notice success" role="status">
          {existing ? "Vos informations sont à jour." : "Votre demande est enregistrée."}
        </p>
      )}

      <div className="fields">
        <div className="wide">
          <label htmlFor="displayName">Nom affiché aux patients</label>
          <input
            id="displayName"
            name="displayName"
            required
            maxLength={120}
            defaultValue={existing?.displayName ?? ""}
            placeholder="Dr Amina Benali"
          />
        </div>

        <div>
          <label htmlFor="specialty">Spécialité</label>
          <select id="specialty" name="specialty" required defaultValue={existing?.specialty ?? ""}>
            <option value="" disabled>
              Choisissez…
            </option>
            {SPECIALTIES.map((specialty) => (
              <option key={specialty} value={specialty}>
                {specialty}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="city">Ville</label>
          <select id="city" name="city" required defaultValue={existing?.city ?? ""}>
            <option value="" disabled>
              Choisissez…
            </option>
            {CITIES.map((city) => (
              <option key={city} value={city}>
                {city}
              </option>
            ))}
          </select>
        </div>

        <div className="wide">
          <label htmlFor="bio">Présentation (facultatif)</label>
          <textarea
            id="bio"
            name="bio"
            rows={4}
            maxLength={1000}
            defaultValue={existing?.bio ?? ""}
            placeholder="Langues parlées, conventions, tiers payant…"
          />
        </div>
      </div>

      <Submit existing={Boolean(existing)} />
    </form>
  );
}

function Submit({ existing }: { existing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="button" type="submit" disabled={pending}>
      {pending
        ? "Enregistrement…"
        : existing
          ? "Mettre à jour"
          : "Demander mon inscription"}
    </button>
  );
}
