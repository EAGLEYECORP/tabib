import { createClient } from "../../lib/supabase/server";
import {
  CITIES,
  SPECIALTIES,
  isCity,
  isSpecialty,
  readFilter,
} from "../../lib/morocco/directory";

export const metadata = {
  title: "Trouver un praticien · Tabib.ma",
  description: "Praticiens vérifiés au Maroc, par spécialité et par ville.",
};

/**
 * Finding a practitioner.
 *
 * The filters are in the URL rather than in component state, so a search can
 * be sent to someone, bookmarked, or reached from a link — "cardiologues à
 * Casablanca" is a page, not a sequence of clicks. It also means this stays a
 * server component with nothing to hydrate.
 */
export default async function Search({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const specialty = readFilter(query.specialite, isSpecialty);
  const city = readFilter(query.ville, isCity);
  const name = (Array.isArray(query.nom) ? query.nom[0] : query.nom)?.slice(0, 80) ?? "";

  const supabase = await createClient();
  const { data } = await supabase.rpc("search_practitioners", {
    p_specialty: specialty,
    p_city: city,
    p_name: name || null,
  });

  type Practitioner = {
    id: string;
    display_name: string;
    specialty: string;
    city: string;
    bio: string | null;
  };
  const results = (data ?? []) as Practitioner[];
  const filtered = Boolean(specialty || city || name);

  return (
    <main className="container">
      <h1>Trouver un praticien</h1>
      <p className="muted">Praticiens vérifiés par Tabib.ma.</p>

      {/* A plain GET form: submitting it puts the filters in the URL. */}
      <form className="card section" method="get">
        <div className="fields">
          <div>
            <label htmlFor="specialite">Spécialité</label>
            <select id="specialite" name="specialite" defaultValue={specialty ?? ""}>
              <option value="">Toutes</option>
              {SPECIALTIES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="ville">Ville</label>
            <select id="ville" name="ville" defaultValue={city ?? ""}>
              <option value="">Toutes</option>
              {CITIES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="nom">Nom du praticien</label>
            <input id="nom" name="nom" defaultValue={name} placeholder="Benali" />
          </div>
        </div>

        <div className="row">
          <button className="button" type="submit">
            Rechercher
          </button>
          {filtered && (
            <a className="secondary" href="/search">
              Tout afficher
            </a>
          )}
        </div>
      </form>

      <section className="section">
        <h2>
          {results.length === 0
            ? "Aucun résultat"
            : results.length === 1
              ? "1 praticien"
              : `${results.length} praticiens`}
        </h2>

        {results.length === 0 ? (
          <div className="card empty">
            <p>
              <strong>Aucun praticien ne correspond à cette recherche.</strong>
            </p>
            <p className="muted">
              {filtered
                ? "Essayez une ville voisine, ou retirez un filtre."
                : "Aucun praticien vérifié n'est encore inscrit."}
            </p>
            {filtered && (
              <a className="button" href="/search">
                Tout afficher
              </a>
            )}
          </div>
        ) : (
          <div className="grid">
            {results.map((practitioner) => (
              <article className="card" key={practitioner.id}>
                <h3>{practitioner.display_name}</h3>
                <p>
                  {practitioner.specialty} · {practitioner.city}
                </p>
                <p className="muted">{practitioner.bio || "Profil professionnel"}</p>
                <a href={`/doctors/${practitioner.id}`}>Voir les disponibilités →</a>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
