// Checks that an agent's Markdown mail goes out as a formatted HTML part with a plain-text part beside
// it. Runs the real host mailboxes (`src/main/agent-mail`) and the real mail Worker (`apps/email-app`):
// the host's signed `/send` request goes into the Worker's `handleSend`, whose Email Sending binding
// is a fake that keeps what it would send.
// The check asserts that a Markdown report has a real table, headings, a checklist, a callout and a
// button for its Motion link; that the plain-text part is present and readable; that scripts,
// event handlers, `javascript:` links, remote images and raw HTML are gone; that a plain-text mail
// stays text-only; and that the Worker drops an HTML part with active content. It renders the mail
// at 390 px and 800 px, light and dark, with Playwright.
// `bun scripts/agent-mail-html-e2e.ts [--markdown=<file>]`. Writes .openbot-build/agent-mail-html-e2e/
// (report.json, mail.html, mail.txt and the screenshots).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { handleSend, type MailSender } from "../apps/email-app/src/index";
import { AgentMail } from "../src/main/agent-mail/agent-mail";

const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-mail-html-e2e");
mkdirSync(OUT, { recursive: true });
const option = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const REPORT = `# Reporte CSO · 26 de noviembre, noche

[Ver el reporte completo en Motion](https://motion.delynith.com/w/delynith/p/reporte-cso-2026-11-26)

> [!IMPORTANT]
> **Necesito 2 decisiones tuyas antes del viernes.** Las ventas van un 18 % por encima de la semana pasada; el anuncio nuevo funciona y quiero subirle el presupuesto.

## Números clave

| Indicador | Hoy | Semana pasada | Cambio |
|---|--:|--:|--:|
| Ventas | 14 | 11 | +27 % |
| Ingresos | 1.260 € | 1.068 € | +18 % |
| Coste por venta | 21 € | 26 € | −19 % |
| Visitas a la página | 2.430 | 2.180 | +11 % |

## Decisiones que necesito de ti

1. **Subir el presupuesto del anuncio nuevo a 40 € al día.** Plazo: jueves 27, 12:00.
2. **Aprobar el descuento del 15 % para el lanzamiento del curso.** Plazo: viernes 28, 18:00.

## Ya resuelto

| Tema | Resultado |
|---|---|
| Página de pago | Funciona otra vez desde las 10:40 |
| Correos de bienvenida | Enviados a los 14 compradores |

## Próximos pasos

- [x] Revisar las respuestas de los clientes de hoy
- [ ] Preparar el texto del descuento (si dices que sí)
- [ ] Medir el anuncio nuevo durante 48 horas más

> [!💡] Una buena noticia: tres clientes preguntaron por el curso avanzado.

<details>
<summary>Ver evidencia: de dónde vienen las ventas</summary>

| Origen | Ventas |
|---|--:|
| Anuncio nuevo | 9 |
| Buscadores | 3 |
| Recomendación | 2 |

</details>
`;

/** Everything an attacker might try in a mail body: none of it may reach the HTML part. */
const HOSTILE = `## Prueba

<script>alert("x")</script>
<img src="https://tracker.example/pixel.gif" onerror="alert(1)">
<iframe src="https://evil.example"></iframe>
<a href="javascript:alert(1)">clic</a>

Un [otro](javascript:alert(2)) y [bien](https://example.org/ok)

![seguimiento](https://tracker.example/open.gif)

<style>body{display:none}</style>

| A | B |
|---|---|
| <b onclick="x()">negrita</b> | "comillas" & <u>ampersand</u> |
`;

const markdownFile = option("markdown");
const report = markdownFile ? readFileSync(markdownFile, "utf8") : REPORT;

const root = await mkdtemp(join(tmpdir(), "agent-mail-html-"));
const sentByWorker: Parameters<MailSender["send"]>[0][] = [];
const workerEnv = {
  HOST_INBOX_URL: "https://connect.example.com/hooks/mail_x",
  MAIL_SECRET: "",
  SENDER_DOMAINS: "aprendivo.com",
  EMAIL: {
    send: async (message: Parameters<MailSender["send"]>[0]) => {
      sentByWorker.push(message);
      return { messageId: `cf-${sentByWorker.length}@aprendivo.com` };
    },
  },
};

const mail = new AgentMail({
  file: join(root, "mailboxes.json"),
  cipher: { encrypt: (value) => Buffer.from(`enc:${value}`), decrypt: (value) => value.toString().slice(4) },
  gateway: { listening: () => true, publicUrl: () => "https://connect.example.com" },
  hooks: {
    agent: (agentId) => (agentId === "cso" ? { id: "cso", name: "CSO - Director de Ventas", spaceId: "s1" } : null),
    deliver: async () => undefined,
    loopCard: () => undefined,
  },
  // The host's request goes straight into the real Worker.
  fetch: (url, init) => handleSend(new Request(url, init), workerEnv),
});

const checks: Record<string, boolean> = {};
try {
  workerEnv.MAIL_SECRET = (await mail.newSecret()).secret;
  await mail.setWorker("https://atelier-mail.example.workers.dev/");
  await mail.saveMailbox({
    address: "cso@aprendivo.com",
    agentId: "cso",
    mode: "write-first",
    displayName: "CSO Aprendivo",
  });

  const send = async (key: string, text: string, format?: "text" | "markdown") => {
    const result = await mail.port.send(
      "cso",
      {
        tool: "email_send",
        input: { to: "delynith@proton.me", subject: "Reporte CSO", text, ...(format ? { format } : {}) },
      },
      { approved: true, key },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const message = sentByWorker.at(-1);
    assert.ok(message);
    return message;
  };

  // 1. A Markdown report, detected without `format`.
  const formatted = await send("r:1", report);
  const html = formatted.html ?? "";
  writeFileSync(join(OUT, "mail.html"), html);
  writeFileSync(join(OUT, "mail.txt"), formatted.text);
  checks.htmlPart = html.length > 0;
  checks.realTable =
    /<table class="m-table"[\s\S]*?<th [^>]*>Indicador<\/th>/u.test(html) && /<td [^>]*>1\.260 €<\/td>/u.test(html);
  checks.numbersRightAligned = /<td [^>]*text-align:right[^>]*>14<\/td>/u.test(html);
  checks.headings = /<h2 [^>]*>Números clave<\/h2>/u.test(html) && /<h1 class="m-title"[^>]*>Reporte CSO/u.test(html);
  checks.motionLinkIsTopButton =
    html.indexOf('class="m-btn-a" href="https://motion.delynith.com/') > 0 &&
    html.indexOf('class="m-btn-a"') < html.indexOf("Números clave");
  checks.callout = html.includes("m-plate-purple") && html.includes("❗");
  checks.checklist = html.includes("&#10003;") && html.includes("text-decoration:line-through");
  checks.numberedDecisions = /<span [^>]*>1\.<\/span>[\s\S]*Subir el presupuesto/u.test(html);
  checks.details = html.includes("Ver evidencia: de dónde vienen las ventas");
  checks.inlineCss = !/<link\b/u.test(html) && /style="/u.test(html);
  checks.plainTextPart =
    formatted.text.startsWith(report.match(/^# (.+)$/mu)?.[1] ?? "Reporte CSO") &&
    /^Indicador +\| /mu.test(formatted.text) &&
    formatted.text.includes("1. Subir el presupuesto") &&
    formatted.text.includes("[ ] Preparar") &&
    !/[<>]{2}|<\/?[a-z]/iu.test(formatted.text);
  checks.plainTextLink = formatted.text.includes("(https://motion.delynith.com/w/delynith/p/reporte-cso-2026-11-26)");
  checks.optOutInBoth = html.includes("responde «baja»") && formatted.text.includes("responde «baja»");

  // 2. Sanitisation.
  const hostile = await send("r:2", HOSTILE, "markdown");
  const dirty = hostile.html ?? "";
  writeFileSync(join(OUT, "hostile.html"), dirty);
  checks.sanitisedHasHtml = dirty.includes('<table class="m-table"');
  checks.noScript = !/<script|alert\("x"\)/iu.test(dirty);
  checks.noHandlers = !/\son[a-z]+\s*=/iu.test(dirty);
  checks.noJavascriptLinks =
    !/href="(?!https?:|mailto:)/iu.test(dirty) &&
    !/javascript:/iu.test(dirty) &&
    dirty.includes('href="https://example.org/ok"');
  checks.noRemoteImages = !/<img\b/iu.test(dirty) && !/tracker\.example/u.test(dirty.replace(/\[seguimiento\]/u, ""));
  checks.noIframeOrStyleLeak = !/<iframe/iu.test(dirty) && !dirty.includes("display:none");
  checks.escapedText = dirty.includes("&quot;comillas&quot; &amp; ampersand");

  // 3. Plain text stays plain.
  const plain = await send("r:3", "Hola Ana, gracias por escribir. Mañana te mando el enlace.");
  checks.plainStaysText = plain.html === undefined && plain.text.startsWith("Hola Ana");

  // 4. The Worker refuses active content in an HTML part from anyone.
  const { decodeOutboundMail } = await import("@openbot/contracts/agent-mail");
  const decoded = decodeOutboundMail({
    version: 1,
    from: { address: "cso@aprendivo.com", name: null },
    to: "a@example.org",
    subject: "x",
    text: "x",
    html: '<p onclick="x()">x</p>',
    inReplyTo: null,
    references: [],
    listUnsubscribe: null,
  });
  checks.workerDropsActiveHtml = decoded?.html === null && decoded.text === "x";

  // 5. Screenshots.
  const browser = await chromium.launch({ executablePath: option("browser-executable") ?? undefined });
  const shots: string[] = [];
  try {
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [390, 800]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: scheme,
          javaScriptEnabled: false,
        });
        const page = await context.newPage();
        // No network: a mail that loads anything remote fails here.
        const remote: string[] = [];
        await page.route("**/*", (route) => {
          remote.push(route.request().url());
          return route.abort();
        });
        await page.setContent(html, { waitUntil: "load" });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        checks[`noSideScroll${width}${scheme}`] = overflow <= 0;
        checks[`noRemoteLoads${width}${scheme}`] = remote.length === 0;
        const file = join(OUT, `mail-${width}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  writeFileSync(
    join(OUT, "report.json"),
    `${JSON.stringify({ ok: failed.length === 0, checks, htmlBytes: html.length, textBytes: formatted.text.length, shots }, null, 2)}\n`,
  );
  assert.deepEqual(failed, [], `Failed: ${failed.map(([name]) => name).join(", ")}`);
  process.stdout.write(`agent-mail-html-e2e: ${Object.keys(checks).length} checks passed. ${OUT}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
