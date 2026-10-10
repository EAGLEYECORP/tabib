import './globals.css';

export const metadata = {
  title: 'Tabib.ma',
  description: 'Rendez-vous médicaux au Maroc',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <header className="nav">
          <a className="brand" href="/">tabib.ma</a>
          <nav>
            <a href="/search">Médecins</a>
            <a href="/dashboard">Mes rendez-vous</a>
            <a href="/documents">Mes documents</a>
            <a href="/pro">Praticiens</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
