import { createClient } from "../../../lib/supabase/server";
import { PractitionerForm } from "../../../components/practitioner-form";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Inscription praticien · Tabib.ma",
  robots: { index: false },
};

/**
 * Where a practitioner joins, and where they later correct their details.
 *
 * Registering is a request. The profile is created unverified — out of
 * search, unbookable — and only an administrator can change that, which the
 * page says plainly rather than leaving someone to wonder why no patients
 * arrive.
 */
export default async function PractitionerRegistrationPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="container narrow">
        <h1>Inscription praticien</h1>
        <p>
          Connectez-vous d&apos;abord avec votre numéro de mobile : c&apos;est lui qui
          identifiera votre compte.
        </p>
        <a className="button" href="/login?next=/pro/inscription">
          Se connecter
        </a>
      </main>
    );
  }

  const { data: existing } = await supabase
    .from("doctor_profiles")
    .select("display_name,specialty,city,bio,verified")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <main className="container narrow">
      {existing && (
        <a className="muted" href="/pro">
          ← Espace praticien
        </a>
      )}

      <h1>{existing ? "Mes informations" : "Inscription praticien"}</h1>

      {existing?.verified === false && (
        <p className="notice warn">
          <strong>Votre profil est en cours de vérification.</strong> Il n&apos;apparaît pas
          encore dans la recherche et ne peut pas recevoir de rendez-vous. Vous pouvez déjà
          préparer vos disponibilités.
        </p>
      )}

      {!existing && (
        <p className="muted">
          Votre profil est créé puis vérifié par Tabib.ma avant d&apos;apparaître dans la
          recherche. Vous pourrez ouvrir vos disponibilités dès maintenant.
        </p>
      )}

      <PractitionerForm
        existing={
          existing
            ? {
                displayName: existing.display_name,
                specialty: existing.specialty,
                city: existing.city,
                bio: existing.bio,
              }
            : undefined
        }
      />
    </main>
  );
}
