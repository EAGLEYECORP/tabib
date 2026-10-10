"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "../../lib/supabase/client";
import { parseMoroccanMobile } from "../../lib/morocco/phone";

/**
 * Signing in with a phone number.
 *
 * Patients here are reached by SMS, not email — many have no email address at
 * all, and the number is already how a cabinet identifies them. Supabase sends
 * and checks the one-time code; this page's job is to normalise what the
 * patient typed into E.164 first, so "06 12 34 56 78" and "+212612345678"
 * reach the same account instead of creating two.
 */
export default function LoginPage() {
  // useSearchParams needs a Suspense boundary to be prerenderable; without one
  // the whole page is forced to render on demand.
  return (
    <Suspense fallback={<main className="container narrow"><h1>Accéder à mon espace</h1></main>}>
      <LoginFlow />
    </Suspense>
  );
}

function LoginFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";

  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = parseMoroccanMobile(phone);
    if (!parsed.ok) {
      setError(
        parsed.reason === "NOT_MOBILE"
          ? "Un numéro de mobile est nécessaire pour recevoir le code."
          : "Numéro de mobile marocain invalide.",
      );
      return;
    }

    setBusy(true);
    const supabase = createClient();
    const { error: sendError } = await supabase.auth.signInWithOtp({ phone: parsed.e164 });
    setBusy(false);

    if (sendError) {
      setError(sendError.message);
      return;
    }
    setSentTo(parsed.e164);
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!sentTo) return;
    setError(null);
    setBusy(true);

    const supabase = createClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({
      phone: sentTo,
      token: code.trim(),
      type: "sms",
    });
    setBusy(false);

    if (verifyError) {
      setError("Code incorrect ou expiré.");
      return;
    }

    router.push(next);
    router.refresh();
  }

  return (
    <main className="container narrow">
      <h1>Accéder à mon espace</h1>

      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}

      {!sentTo ? (
        <form onSubmit={sendCode} className="card section">
          <p className="muted">
            Entrez votre numéro de mobile. Nous vous envoyons un code à six chiffres par SMS.
          </p>
          <label htmlFor="phone">Numéro de mobile</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            dir="ltr"
            placeholder="06 12 34 56 78"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          <button className="button" type="submit" disabled={busy}>
            {busy ? "Envoi…" : "Recevoir le code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="card section">
          <p className="muted">Code envoyé au {sentTo}</p>
          <label htmlFor="code">Code à six chiffres</label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            dir="ltr"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <button className="button" type="submit" disabled={busy}>
            {busy ? "Vérification…" : "Valider"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setSentTo(null);
              setCode("");
            }}
          >
            Changer de numéro
          </button>
        </form>
      )}
    </main>
  );
}
