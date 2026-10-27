export default function Home() {
  return (
    <main className="hero">
      <small>SANTÉ · MAROC</small>
      <h1>
        Trouvez votre médecin.
        <br />
        Prenez rendez-vous.
      </h1>
      <p>
        Recherchez un praticien vérifié, consultez ses disponibilités, et partagez vos analyses
        ou vos radios avec lui avant la consultation.
      </p>
      <a className="button" href="/search">Rechercher un médecin</a>
      <a className="secondary spaced" href="/documents">Mes documents médicaux</a>
      <p className="muted">
        Vous êtes praticien ?{" "}
        <a href="/pro/inscription">Inscrivez votre cabinet</a>.
      </p>
    </main>
  );
}
