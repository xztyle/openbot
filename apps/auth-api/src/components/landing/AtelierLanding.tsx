import frauncesItalicFont from "@fontsource-variable/fraunces/files/fraunces-latin-wght-italic.woff2?url";
import frauncesFont from "@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2?url";
import instrumentSansFont from "@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2?url";
import { AtelierSymbol } from "@openbot/brand";
import { agentFaceSVG, type FaceState } from "@openbot/brand/faces";
import { createSignal, For, onSettled } from "solid-js";
import { ATELIER_CANVAS, ATELIER_FAQ } from "../../lib/atelier-home-head";
import css from "./atelier-landing.css?raw";

/** The Craft Studio type, served from this site. Only the Latin subsets: the page is Spanish. */
const FONT_FACES = `
@font-face{font-family:"Fraunces Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url(${frauncesFont}) format("woff2-variations")}
@font-face{font-family:"Fraunces Variable";font-style:italic;font-display:swap;font-weight:100 900;src:url(${frauncesItalicFont}) format("woff2-variations")}
@font-face{font-family:"Instrument Sans Variable";font-style:normal;font-display:swap;font-weight:400 700;src:url(${instrumentSansFont}) format("woff2-variations")}
`;

interface Teammate {
  id: string;
  name: string;
  role: string;
}

/** The example team. Each id is the seed of a real Atelier face, so the same person shows everywhere. */
const LUCIA: Teammate = { id: "landing-lucia", name: "Lucía", role: "Ventas" };
const MATEO: Teammate = { id: "landing-mateo", name: "Mateo", role: "Marketing" };
const SARA: Teammate = { id: "landing-sara", name: "Sara", role: "Soporte" };
const TOMAS: Teammate = { id: "landing-tomas", name: "Tomás", role: "Finanzas" };
const ANA: Teammate = { id: "landing-ana", name: "Ana", role: "Directora de operaciones" };

/**
 * A teammate's face, drawn by the app's own generator in the Craft Studio look. Both color schemes
 * are in the page and CSS shows the one that matches, so the server render is already right.
 */
function Face(props: { who: Teammate; size: number; state?: FaceState }) {
  const svg = (theme: "light" | "dark") =>
    agentFaceSVG({
      id: props.who.id,
      name: `${props.who.name} ${props.who.role}`,
      size: props.size,
      theme,
      state: props.state ?? "idle",
      brand: "craft",
    });
  return (
    <span class="al-face" style={{ "--al-face-size": `${props.size}px` }} aria-hidden="true">
      <span class="al-face-light" innerHTML={svg("light")} />
      <span class="al-face-dark" innerHTML={svg("dark")} />
    </span>
  );
}

const CHANNEL = [
  {
    who: ANA,
    state: "talking",
    time: "8:02",
    text: "Buenos días. Resumen: 14 leads nuevos, 2 tickets abiertos, campaña lista.",
  },
  { who: LUCIA, state: "working", time: "8:05", text: "Respondí a los 14. Tres piden cotización; las dejo en Motion." },
  { who: SARA, state: "success", time: "8:11", text: "Tickets cerrados. El cliente de Medellín quedó contento." },
] as const;

const BOARD = [
  { title: "Cotización Café Origen", who: LUCIA, column: "En curso" },
  { title: "Campaña de diciembre", who: MATEO, column: "Revisión" },
  { title: "Reporte semanal", who: ANA, column: "Hecho" },
] as const;

const PAINS = [
  {
    title: "Todo pasa por ti",
    body: "Respondes clientes, publicas, cobras y haces seguimiento. Si te detienes, el negocio se detiene.",
  },
  {
    title: "Herramientas sueltas",
    body: "Un chat aquí, una hoja allá, un recordatorio en el celular. Nadie ve el panorama completo.",
  },
  {
    title: "La IA olvida",
    body: "Cada conversación con un chatbot empieza de cero. Le explicas tu negocio una y otra vez.",
  },
] as const;

const STEPS = [
  {
    title: "Les escribes como a un colega",
    body: "“Lucía, responde hoy a los clientes nuevos y cotiza a los que pregunten.”",
  },
  {
    title: "Ellos se organizan",
    body: "La tarea aparece en Motion con dueño y estado. Si hace falta, se reparten el trabajo.",
  },
  {
    title: "Tú revisas lo importante",
    body: "Mensajes cortos y resultados claros. Sin perseguir a nadie para saber en qué va.",
  },
] as const;

const FEATURES = [
  {
    icon: "chat",
    title: "Un espacio tipo Slack",
    body: "Canales, hilos y mensajes directos. Tu equipo IA trabaja donde ya conversas.",
  },
  {
    icon: "board",
    title: "Tablero Motion",
    body: "Cada tarea en un solo tablero: quién la tiene, en qué va y qué sigue.",
  },
  {
    icon: "loop",
    title: "Loops",
    body: "Rutinas que corren solas: el reporte de la mañana, los seguimientos, el cierre semanal.",
  },
  {
    icon: "stack",
    title: "Varios negocios",
    body: "Un equipo por negocio, cada uno con su contexto, sus canales y su memoria.",
  },
  {
    icon: "face",
    title: "Con nombre y cara",
    body: "Cada compañero tiene su cara y su oficio. Sabes quién hizo qué, de un vistazo.",
  },
  {
    icon: "home",
    title: "En tu servidor",
    body: "Atelier es autoalojado. Tus conversaciones y archivos se quedan contigo.",
  },
] as const;

const NOT_THIS = [
  "No es un chatbot que olvida: tu equipo recuerda tu negocio y sus pendientes.",
  "No es un servicio en la nube de otra empresa: corre en tu propio servidor.",
  "No es un producto en venta: es un estudio privado, sin planes ni suscripciones.",
] as const;

/** The small line icons of the feature cards, drawn in the current text color. */
const ICONS: Record<(typeof FEATURES)[number]["icon"], string> = {
  chat: "M4 5h16v10H9l-5 4V5Z",
  board: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  loop: "M17 4l3 3-3 3M20 7H9a5 5 0 0 0 0 10h1M7 20l-3-3 3-3M4 17h11a5 5 0 0 0 0-10h-1",
  stack: "M12 3l9 5-9 5-9-5 9-5ZM3 13l9 5 9-5",
  face: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9 10h.01M15 10h.01M8.5 14.5a5 5 0 0 0 7 0",
  home: "M4 11l8-7 8 7v9H4v-9ZM10 20v-5h4v5",
};

function Icon(props: { path: string }) {
  return (
    <svg class="al-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={props.path} />
    </svg>
  );
}

/** The main call to action: every one opens the app. */
function OpenApp(props: { class?: string; label?: string }) {
  return (
    <a class={`al-btn ${props.class ?? ""}`} href="/app">
      {props.label ?? "Abrir mi espacio"}
      <svg class="al-arrow" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </a>
  );
}

export function AtelierLanding() {
  const [barShown, setBarShown] = createSignal(false);
  let heroCta: HTMLDivElement | undefined;
  let finalCta: HTMLElement | undefined;
  // The browser's bars take the dark canvas in dark mode. The head has the light one: the router keeps one tag per name.
  onSettled(() => {
    const darkThemeColor = document.createElement("meta");
    darkThemeColor.name = "theme-color";
    darkThemeColor.content = ATELIER_CANVAS.dark;
    darkThemeColor.media = "(prefers-color-scheme: dark)";
    document.head.appendChild(darkThemeColor);
    return () => darkThemeColor.remove();
  });
  // The phone's bottom bar shows once the hero's buttons scroll away, and hides again at the last call to action.
  onSettled(() => {
    const hero = heroCta;
    const last = finalCta;
    if (!hero || !last || !("IntersectionObserver" in window)) return;
    const visible = new Map<Element, boolean>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visible.set(entry.target, entry.isIntersecting);
      setBarShown(visible.get(hero) === false && visible.get(last) !== true);
    });
    observer.observe(hero);
    observer.observe(last);
    return () => observer.disconnect();
  });

  return (
    <div class="al" lang="es">
      <style>{FONT_FACES + css}</style>
      <a class="al-skip" href="#al-main">
        Saltar al contenido
      </a>

      <header class="al-header">
        <div class="al-wrap al-header-row">
          <a class="al-brand" href="/" aria-label="Atelier, inicio">
            <AtelierSymbol theme="craft" class="al-symbol" />
            <span>Atelier</span>
          </a>
          <nav class="al-nav" aria-label="Secciones">
            <a href="#al-como">Cómo funciona</a>
            <a href="#al-incluye">Qué incluye</a>
            <a href="#al-preguntas">Preguntas</a>
          </nav>
          <a class="al-btn al-btn-small" href="/app">
            Entrar
          </a>
        </div>
      </header>

      <main id="al-main">
        <section class="al-wrap al-hero" aria-labelledby="al-title">
          <div class="al-hero-copy">
            <p class="al-eyebrow">Autoalojado · privado · tuyo</p>
            <h1 id="al-title">
              Un equipo de IA con nombre y cara que <em>lleva tus negocios.</em>
            </h1>
            <p class="al-lead">
              Compañeros de trabajo que venden, atienden, publican y te reportan en un espacio tipo Slack. Tú decides;
              ellos hacen. Solo te preguntan cuando hay dinero de por medio.
            </p>
            <div ref={heroCta} class="al-cta">
              <OpenApp />
              <a class="al-btn al-btn-ghost" href="#al-como">
                Ver cómo funciona
              </a>
            </div>
          </div>

          <figure class="al-demo" aria-label="Ejemplo del espacio de trabajo: el canal de ventas y el tablero Motion">
            <div class="al-demo-bar">
              <span class="al-demo-channel"># ventas</span>
              <span class="al-demo-faces">
                <Face who={ANA} size={24} />
                <Face who={LUCIA} size={24} />
                <Face who={SARA} size={24} />
              </span>
            </div>
            <ol class="al-messages">
              <For each={CHANNEL}>
                {(message) => (
                  <li class="al-message">
                    <Face who={message.who} size={40} state={message.state} />
                    <div>
                      <p class="al-message-head">
                        <strong>{message.who.name}</strong> <span>{message.time}</span>
                      </p>
                      <p>{message.text}</p>
                    </div>
                  </li>
                )}
              </For>
            </ol>
            <ul class="al-board" aria-label="Tablero Motion">
              <For each={BOARD}>
                {(card) => (
                  <li class="al-board-card">
                    <span class="al-board-column">{card.column}</span>
                    <span class="al-board-title">{card.title}</span>
                    <Face who={card.who} size={24} />
                  </li>
                )}
              </For>
            </ul>
          </figure>
        </section>

        <section class="al-wrap al-section" aria-labelledby="al-pains-title">
          <p class="al-kicker">El problema</p>
          <h2 id="al-pains-title">Tu negocio crece, pero tu día no.</h2>
          <div class="al-grid al-grid-3">
            <For each={PAINS}>
              {(pain) => (
                <article class="al-card">
                  <h3>{pain.title}</h3>
                  <p>{pain.body}</p>
                </article>
              )}
            </For>
          </div>
        </section>

        <section id="al-como" class="al-wrap al-section" aria-labelledby="al-como-title">
          <p class="al-kicker">Cómo funciona</p>
          <h2 id="al-como-title">Le hablas a tu equipo. Tu equipo hace el trabajo.</h2>
          <ol class="al-steps">
            <For each={STEPS}>
              {(step, index) => (
                <li class="al-step">
                  <span class="al-step-number" aria-hidden="true">
                    {index() + 1}
                  </span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                </li>
              )}
            </For>
          </ol>
          <OpenApp class="al-btn-inline" />
        </section>

        <section id="al-incluye" class="al-wrap al-section" aria-labelledby="al-incluye-title">
          <p class="al-kicker">Qué incluye</p>
          <h2 id="al-incluye-title">Todo tu equipo en un solo lugar.</h2>
          <div class="al-grid al-grid-3">
            <For each={FEATURES}>
              {(feature) => (
                <article class="al-card">
                  <Icon path={ICONS[feature.icon]} />
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              )}
            </For>
          </div>
        </section>

        <section class="al-wrap al-section al-trust" aria-labelledby="al-trust-title">
          <div>
            <p class="al-kicker">Confianza</p>
            <h2 id="al-trust-title">Trabajan solos. El dinero lo apruebas tú.</h2>
            <p class="al-lead">
              Tu equipo no te llena de preguntas. Escribe, organiza, publica y hace seguimiento por su cuenta. Solo se
              detiene antes de pagar o lanzar anuncios, y te pregunta con un mensaje claro.
            </p>
          </div>
          <div class="al-approval" role="img" aria-label="Ejemplo: Tomás pide aprobar un pago de 120 dólares">
            <Face who={TOMAS} size={44} state="waiting" />
            <div>
              <p class="al-message-head">
                <strong>Tomás</strong> <span>Finanzas</span>
              </p>
              <p>¿Apruebo el pago de USD 120 al proveedor de empaques? La factura está en el hilo.</p>
              <p class="al-approval-actions">
                <span class="al-chip al-chip-yes">Aprobar</span>
                <span class="al-chip">Ahora no</span>
              </p>
            </div>
          </div>
        </section>

        <section class="al-wrap al-section" aria-labelledby="al-not-title">
          <p class="al-kicker">Para que no haya dudas</p>
          <h2 id="al-not-title">Qué no es Atelier.</h2>
          <ul class="al-not">
            <For each={NOT_THIS}>{(line) => <li>{line}</li>}</For>
          </ul>
        </section>

        <section id="al-preguntas" class="al-wrap al-section" aria-labelledby="al-faq-title">
          <p class="al-kicker">Preguntas frecuentes</p>
          <h2 id="al-faq-title">Lo que suelen preguntar.</h2>
          <div class="al-faqs">
            <For each={ATELIER_FAQ}>
              {(item) => (
                <details class="al-faq">
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              )}
            </For>
          </div>
        </section>

        <section ref={finalCta} class="al-wrap al-section al-final" aria-labelledby="al-final-title">
          <span class="al-final-faces">
            <Face who={ANA} size={48} state="talking" />
            <Face who={LUCIA} size={48} />
            <Face who={MATEO} size={48} />
            <Face who={SARA} size={48} />
            <Face who={TOMAS} size={48} />
          </span>
          <h2 id="al-final-title">Tu equipo ya te está esperando.</h2>
          <OpenApp label="Abrir Atelier" />
        </section>
      </main>

      <footer class="al-footer">
        <div class="al-wrap al-footer-row">
          <span class="al-brand al-brand-small">
            <AtelierSymbol theme="craft" class="al-symbol" />
            <span>Atelier</span>
          </span>
          <nav class="al-footer-links" aria-label="Legal">
            <a href="/privacy-policy">Privacidad</a>
            <a href="/terms">Términos</a>
            <a href="/app">Entrar</a>
          </nav>
        </div>
      </footer>

      <div class="al-bar" data-shown={barShown() ? "true" : "false"} aria-hidden={barShown() ? undefined : "true"}>
        <a class="al-btn" href="/app" tabindex={barShown() ? undefined : -1}>
          Abrir mi espacio
        </a>
      </div>
    </div>
  );
}
