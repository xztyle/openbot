import { agentFaceSVG } from "@openbot/brand/faces";
import { For } from "solid-js";
import css from "./atelier-landing.css?raw";
import { LandingFooter } from "./LandingFooter";

/** The teammates shown on the landing: the real Atelier faces in the Craft Studio look. */
const TEAM = [
  { id: "landing-lucia", name: "Lucía", role: "Ventas", note: "Respondió 14 leads esta mañana" },
  { id: "landing-mateo", name: "Mateo", role: "Marketing", note: "Programó la campaña de diciembre" },
  { id: "landing-sara", name: "Sara", role: "Soporte", note: "Cerró 9 tickets, 0 pendientes" },
  { id: "landing-tomas", name: "Tomás", role: "Finanzas", note: "Te pide aprobar un pago de $120" },
] as const;

function Face(props: { id: string; name: string; size: number; state?: "idle" | "working" | "waiting" }) {
  const svg = (theme: "light" | "dark") =>
    agentFaceSVG({
      id: props.id,
      name: props.name,
      size: props.size,
      theme,
      state: props.state ?? "idle",
      brand: "craft",
    });
  return (
    <span class="al-face" style={{ width: `${props.size}px`, height: `${props.size}px` }} aria-hidden="true">
      <span class="al-face-light" innerHTML={svg("light")} />
      <span class="al-face-dark" innerHTML={svg("dark")} />
    </span>
  );
}

const FEATURES = [
  {
    title: "Un espacio como Slack",
    body: "Canales, hilos y mensajes directos. Tus compañeros IA trabajan donde tú ya conversas.",
  },
  { title: "Tablero Motion", body: "Cada tarea en un solo tablero: quién la tiene, en qué va y qué sigue." },
  { title: "Loops", body: "Rutinas que se repiten solas: reportes diarios, seguimientos, revisiones semanales." },
  {
    title: "Varios negocios",
    body: "Un equipo por negocio, cada uno con su contexto, sus canales y su memoria.",
  },
] as const;

const FAQ = [
  {
    q: "¿Los agentes pueden gastar mi dinero?",
    a: "No sin ti. Solo te piden permiso para gastar (pagos, anuncios). Todo lo demás lo hacen solos.",
  },
  {
    q: "¿Dónde quedan mis datos?",
    a: "En tu propio servidor. Atelier es autoalojado: tus conversaciones y archivos no salen de tu máquina.",
  },
  {
    q: "¿Necesito saber programar?",
    a: "No. Les escribes como a un colega y ellos se organizan en el tablero.",
  },
  {
    q: "¿Funciona en el celular?",
    a: "Sí. Atelier está pensado primero para el teléfono, con tema claro y oscuro.",
  },
] as const;

export function AtelierLanding() {
  return (
    <div class="al" lang="es">
      <style>{css}</style>
      <a class="al-skip" href="#al-main">
        Saltar al contenido
      </a>
      <header class="al-header">
        <a class="al-brand" href="/" aria-label="Atelier, inicio">
          <Face id="landing-lucia" name="Lucía" size={28} />
          <span>Atelier</span>
        </a>
        <a class="al-btn al-btn-small" href="/app">
          Entrar
        </a>
      </header>

      <main id="al-main">
        <section class="al-hero" aria-labelledby="al-title">
          <p class="al-eyebrow">Autoalojado · Privado · Tuyo</p>
          <h1 id="al-title">Un equipo de IA con cara y nombre que lleva tus negocios.</h1>
          <p class="al-lead">
            Atelier te da compañeros de trabajo IA que venden, atienden, publican y reportan en un espacio tipo Slack.
            Tú decides; ellos hacen. Solo te preguntan cuando hay dinero de por medio.
          </p>
          <div class="al-cta">
            <a class="al-btn" href="/app">
              Abrir mi espacio
            </a>
            <a class="al-btn al-btn-ghost" href="#al-como">
              Ver cómo funciona
            </a>
          </div>

          <ul class="al-team" aria-label="Tu equipo hoy">
            <For each={TEAM}>
              {(member, index) => (
                <li class="al-member">
                  <Face id={member.id} name={member.name} size={48} state={index() === 3 ? "waiting" : "working"} />
                  <div>
                    <p class="al-member-name">
                      {member.name} <span>{member.role}</span>
                    </p>
                    <p class="al-member-note">{member.note}</p>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </section>

        <section id="al-como" class="al-section" aria-labelledby="al-como-title">
          <h2 id="al-como-title">Así trabaja tu equipo</h2>
          <ol class="al-steps">
            <li>
              <strong>Escribe como a un colega.</strong> “Lucía, responde a los clientes nuevos de hoy.”
            </li>
            <li>
              <strong>Ellos se organizan.</strong> La tarea aparece en Motion, con dueño y estado.
            </li>
            <li>
              <strong>Tú revisas lo importante.</strong> Mensajes cortos, resultados claros, sin perseguir a nadie.
            </li>
          </ol>
        </section>

        <section class="al-section" aria-labelledby="al-features-title">
          <h2 id="al-features-title">Todo en un solo lugar</h2>
          <div class="al-grid">
            <For each={FEATURES}>
              {(feature) => (
                <article class="al-card">
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              )}
            </For>
          </div>
        </section>

        <section class="al-section al-trust" aria-labelledby="al-trust-title">
          <h2 id="al-trust-title">Confianza simple: el dinero lo apruebas tú</h2>
          <div class="al-approval" role="img" aria-label="Ejemplo: Tomás pide aprobar un pago de 120 dólares">
            <Face id="landing-tomas" name="Tomás" size={40} state="waiting" />
            <div>
              <p class="al-member-name">
                Tomás <span>Finanzas</span>
              </p>
              <p>¿Apruebo el pago de $120 al proveedor de empaques?</p>
              <p class="al-approval-actions">
                <span class="al-chip al-chip-yes">Aprobar</span>
                <span class="al-chip">Ahora no</span>
              </p>
            </div>
          </div>
        </section>

        <section class="al-section" aria-labelledby="al-faq-title">
          <h2 id="al-faq-title">Preguntas frecuentes</h2>
          <For each={FAQ}>
            {(item) => (
              <details class="al-faq">
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            )}
          </For>
        </section>

        <section class="al-section al-final" aria-labelledby="al-final-title">
          <h2 id="al-final-title">Tu equipo ya te está esperando.</h2>
          <a class="al-btn" href="/app">
            Abrir Atelier
          </a>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
