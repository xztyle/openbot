/** The page canvas of Craft Studio, which the browser's bars take on. */
export const ATELIER_CANVAS = { light: "#F6F1E7", dark: "#171411" } as const;

/** The title and description of the Atelier landing, in Spanish like the page. */
export const ATELIER_HOME_TITLE = "Atelier: un equipo de IA con nombre y cara que lleva tus negocios";
export const ATELIER_HOME_DESCRIPTION =
  "Compañeros de trabajo IA que venden, atienden, publican y reportan en un espacio tipo Slack, en tu propio servidor. Solo te piden permiso cuando hay dinero de por medio.";

/** The landing's questions, shown on the page and given to search engines as a `FAQPage`. */
export const ATELIER_FAQ = [
  {
    q: "¿Los agentes pueden gastar mi dinero?",
    a: "No sin tu permiso. Pagar y lanzar anuncios siempre espera tu aprobación. Todo lo demás lo hacen solos.",
  },
  {
    q: "¿Dónde quedan mis datos?",
    a: "En tu propio servidor. Atelier es autoalojado: nada pasa por la nube de un tercero salvo el modelo de IA que tú elijas.",
  },
  {
    q: "¿Necesito saber programar?",
    a: "No. Les escribes en español, como a un colega, y ellos se organizan en el tablero.",
  },
  {
    q: "¿Puedo llevar más de un negocio?",
    a: "Sí. Cada negocio tiene su propio equipo, sus canales y su memoria, y pasas de uno a otro en un toque.",
  },
  {
    q: "¿Funciona en el celular?",
    a: "Sí. Atelier está pensado primero para el teléfono, con tema claro y oscuro.",
  },
] as const;

const ATELIER_FAQ_STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  inLanguage: "es",
  mainEntity: ATELIER_FAQ.map((entry) => ({
    "@type": "Question",
    name: entry.q,
    acceptedAnswer: { "@type": "Answer", text: entry.a },
  })),
};

/** The head of `/`: its own title, description, social card text and canonical address on the serving site. */
export function atelierHomeHead(siteUrl: string) {
  const url = new URL("/", siteUrl).toString();
  return {
    meta: [
      { title: ATELIER_HOME_TITLE },
      { name: "description", content: ATELIER_HOME_DESCRIPTION },
      { name: "color-scheme", content: "light dark" },
      // The router keeps one tag per name, so the page adds the dark one itself.
      { name: "theme-color", content: ATELIER_CANVAS.light, media: "(prefers-color-scheme: light)" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Atelier" },
      { property: "og:locale", content: "es_CO" },
      { property: "og:url", content: url },
      { property: "og:title", content: ATELIER_HOME_TITLE },
      { property: "og:description", content: ATELIER_HOME_DESCRIPTION },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: ATELIER_HOME_TITLE },
      { name: "twitter:description", content: ATELIER_HOME_DESCRIPTION },
      { "script:ld+json": ATELIER_FAQ_STRUCTURED_DATA },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}
