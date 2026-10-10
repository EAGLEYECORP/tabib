/**
 * Moroccan mobile numbers.
 *
 * Patients are identified by their phone, so the same person must not end up
 * with two accounts because they typed their number differently on two days.
 * Everything is normalised to E.164 before it reaches Supabase Auth.
 *
 * Subscriber numbering (ANRT plan): the national significant number is nine
 * digits, of which the first identifies the service —
 *   6, 7  mobile
 *   5     fixed line
 *   8     toll-free and special rate, which cannot receive an SMS
 */

const COUNTRY_CODE = "212";

export type PhoneRejection = "EMPTY" | "CHARSET" | "LENGTH" | "NOT_MOBILE";

export type ParsedPhone =
  | { readonly ok: true; readonly e164: string; readonly national: string }
  | { readonly ok: false; readonly reason: PhoneRejection };

/**
 * Accepts every shape a patient realistically types — "0612345678",
 * "06 12 34 56 78", "+212 6 12 34 56 78", "00212612345678" — and the
 * Arabic-Indic digits an Arabic keyboard produces by default.
 */
export function parseMoroccanMobile(input: string): ParsedPhone {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "EMPTY" };

  // Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits to ASCII.
  const ascii = trimmed.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });

  // Tolerate the separators people use, but refuse letters, so a mistyped
  // email never silently becomes a phone number.
  if (/[^\d\s()+.\-/]/.test(ascii)) return { ok: false, reason: "CHARSET" };

  let digits = ascii.replace(/\D/g, "");

  if (digits.startsWith("00" + COUNTRY_CODE)) {
    digits = digits.slice(2 + COUNTRY_CODE.length);
  } else if (digits.startsWith(COUNTRY_CODE) && digits.length > 9) {
    digits = digits.slice(COUNTRY_CODE.length);
  }

  // The national trunk prefix, absent from the international form. Stripped
  // whenever it is there rather than only at the exact expected length, so a
  // number with a digit missing is reported as too short rather than as an
  // unsupported prefix — which is the error the patient can act on.
  if (digits.startsWith("0")) digits = digits.slice(1);

  if (digits.length !== 9) return { ok: false, reason: "LENGTH" };

  // 5 is a landline; 8 and 9 are special-rate or unassigned. None can receive
  // a login code, so none of them is an account.
  if (digits[0] !== "6" && digits[0] !== "7") return { ok: false, reason: "NOT_MOBILE" };

  return { ok: true, e164: `+${COUNTRY_CODE}${digits}`, national: digits };
}

/** National display form, as written on a Moroccan business card. */
export function formatNational(national: string): string {
  return `0${national[0]} ${national.slice(1, 3)} ${national.slice(3, 5)} ${national.slice(
    5,
    7,
  )} ${national.slice(7, 9)}`;
}

/**
 * Masks the middle digits for display on a screen someone else may be looking
 * at — a reception desk, a shared phone.
 */
export function maskNational(national: string): string {
  return `0${national[0]} •• •• •• ${national.slice(7, 9)}`;
}
