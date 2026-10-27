/**
 * The vocabulary the directory is searchable in.
 *
 * Specialty and city are chosen from these lists rather than typed, on both
 * sides. It is tempting to let a practitioner write their own: it is one
 * fewer list to maintain, and it is also how a directory stops working. A
 * patient searching "Cardiologie" has to match what the practitioner wrote,
 * and free text gives you "Cardiologue", "cardio", "Cardiologie " and
 * "CARDIOLOGIE" — four specialties, three of them unfindable.
 *
 * French, because the interface is. Arabic is a real gap and a presentation
 * change: these keys would stay as they are and gain labels.
 */

export const SPECIALTIES = [
  "Médecine générale",
  "Allergologie",
  "Anesthésie-réanimation",
  "Cardiologie",
  "Chirurgie dentaire",
  "Chirurgie générale",
  "Chirurgie orthopédique",
  "Chirurgie plastique",
  "Dermatologie",
  "Endocrinologie-diabétologie",
  "Gastro-entérologie",
  "Gynécologie-obstétrique",
  "Hématologie",
  "Kinésithérapie",
  "Médecine du travail",
  "Médecine interne",
  "Néphrologie",
  "Neurologie",
  "Nutrition-diététique",
  "Oncologie",
  "Ophtalmologie",
  "Orthodontie",
  "Orthophonie",
  "Oto-rhino-laryngologie",
  "Pédiatrie",
  "Pneumologie",
  "Psychiatrie",
  "Psychologie",
  "Radiologie",
  "Rhumatologie",
  "Sage-femme",
  "Urologie",
] as const;

export const CITIES = [
  "Agadir",
  "Al Hoceïma",
  "Béni Mellal",
  "Berrechid",
  "Casablanca",
  "Dakhla",
  "El Jadida",
  "Errachidia",
  "Essaouira",
  "Fès",
  "Guelmim",
  "Kénitra",
  "Khémisset",
  "Khouribga",
  "Laâyoune",
  "Larache",
  "Marrakech",
  "Meknès",
  "Mohammedia",
  "Nador",
  "Ouarzazate",
  "Oujda",
  "Rabat",
  "Safi",
  "Salé",
  "Settat",
  "Tanger",
  "Taza",
  "Témara",
  "Tétouan",
] as const;

export type Specialty = (typeof SPECIALTIES)[number];
export type City = (typeof CITIES)[number];

export function isSpecialty(value: string): value is Specialty {
  return (SPECIALTIES as readonly string[]).includes(value);
}

export function isCity(value: string): value is City {
  return (CITIES as readonly string[]).includes(value);
}

/**
 * Reads a filter off the query string.
 *
 * Anything not in the list is dropped rather than passed to the database: a
 * filter nobody can have matches nothing, and showing every practitioner in
 * Morocco is a better answer to a mangled URL than showing none.
 */
export function readFilter<T extends string>(
  value: string | string[] | undefined,
  allowed: (candidate: string) => candidate is T,
): T | null {
  const single = Array.isArray(value) ? value[0] : value;
  if (!single) return null;
  return allowed(single) ? single : null;
}

/**
 * Normalises a name typed into the search box so that accents and case do not
 * decide whether a practitioner is findable. "benali", "Bénali" and "BENALI"
 * all have to reach Dr Amina Benali — a patient half-remembering a name is
 * the normal case, not the exception.
 */
export function normaliseName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}
