// The human view of Motion content, end to end against a Motion stand-in over real HTTP: which
// objects are for the owner, the no-dropped-facts check with its one retry, an agent's request on a
// page that is not for the owner, a ticket, a version an agent wrote, a small edit against a material
// change, the owner-linked pages, the backfill, and the chat preview of a Motion link, which draws
// the human version. Agents' text is never changed: the host writes only `human.save`.
//
// `bun scripts/motion-human-views-e2e.ts`. Writes .openbot-build/motion-human-views-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ConversationSnapshot } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { humanViewHtml } from "../src/backend/agent/human-view-preview";
import { OwnerTools } from "../src/backend/agent/owner-tools";
import {
  collectionOf,
  fingerprint,
  type HumanQueueItem,
  missingFacts,
  motionPageOfUrl,
  ownerFacing,
} from "../src/main/motion-events/motion-human-text";
import { MotionHumanViews } from "../src/main/motion-events/motion-human-views";

const OUT = resolve(import.meta.dirname, "../.openbot-build/motion-human-views-e2e");
const checks: string[] = [];
const check = (name: string, run: () => void) => {
  run();
  checks.push(name);
};
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const WS = "01a1e29f-0783-7510-85f9-dfff3540deeb";

// ── Detection and the facts check, as pure rules ───────────────────────────────────────────────
const item = (over: Partial<HumanQueueItem>): HumanQueueItem => ({
  kind: "page",
  objectId: randomUUID(),
  workspaceId: WS,
  workspaceName: "Universidad Online",
  pageId: "",
  title: "Notas",
  path: ["Equipo de ventas"],
  changedAt: 1,
  rev: "r1",
  issueKey: null,
  human: null,
  ...over,
});

check("detection", () => {
  const dossier = item({ title: "Dossier EVE-20 · Globos para Fiestas y Eventos (K49159512U)", path: ["Ventas"] });
  assert.equal(collectionOf(dossier), "dossier");
  assert.equal(ownerFacing(dossier, new Set()), true, "A dossier is for the owner.");
  const report = item({ title: "Semana 47", path: ["Operaciones", "Reportes"] });
  assert.equal(collectionOf(report), "reportes", "A row of the Reportes list.");
  assert.equal(collectionOf(item({ title: "Inicio — empieza aquí" })), "inicio", "Any dash and accents.");
  assert.equal(collectionOf(item({ title: "Cap. 3", path: ["Manual del CSO"] })), "manual");
  assert.equal(collectionOf(item({ title: "Decisiones" })), "decisiones");
  assert.equal(collectionOf(item({ title: "Equipo" })), "equipo");
  assert.equal(collectionOf(item({ title: "Equipo de ventas" })), null, "Only the Equipo page itself.");
  const plain = item({ title: "Notas sueltas", path: ["Ideas"] });
  assert.equal(ownerFacing(plain, new Set()), false, "A page nobody linked is not for the owner.");
  assert.equal(ownerFacing({ ...plain, pageId: "p-1" }, new Set(["p-1"])), true, "Linked to the owner.");
  assert.equal(ownerFacing({ ...plain, issueKey: "EVE-20" }, new Set(["EVE-20"])), true, "A ticket linked by its key.");
  const comment = item({ kind: "comment", pageId: "p-9", title: "Comentario" });
  assert.equal(ownerFacing(comment, new Set(["p-9"])), true, "A comment goes with its page.");
  assert.equal(
    ownerFacing(
      { ...plain, human: { sourceRev: "r0", fingerprint: null, requested: true, origin: "generated" } },
      new Set(),
    ),
    true,
    "An agent's or the owner's request.",
  );
  assert.equal(
    motionPageOfUrl(`https://motion.delynith.com/w/${WS}/p/01a20e29-46b6-7376-af8f-0290db7db3ba`),
    "01a20e29-46b6-7376-af8f-0290db7db3ba",
  );
});

const ORIGINAL = `## Resumen
Producto K49159512U (EVE-20). Precio $99 USD, comisión neta 70,64 USD por venta. CTR 2,35%.
## Números
| Métrica | Valor |
|---|---|
| Ventas mes | 1.240 |
| Gravity | 48.5 |
## Decisión
GO para la campaña desde 2026-11-28. Presupuesto 15 USD/día.
## Riesgos
Reembolsos 12% en octubre.`;

const GOOD = `# Globos para fiestas
## En resumen
Producto de globos. Precio: 99 dólares; tú ganas unos 71 por venta. De cada 100 personas que ven el anuncio, 2,35 hacen clic.
## Números
| Qué | Cuánto |
|---|---|
| Ventas del mes | 1.240 |
| Popularidad en la tienda | 48,5 |
## Decisión
Seguimos adelante con la campaña desde el 28 de noviembre de 2026. Gasto: 15 dólares al día.
## Riesgos
En octubre se devolvió el dinero al 12% de los compradores.`;

check("no-dropped-facts", () => {
  assert.deepEqual(missingFacts(ORIGINAL, GOOD), [], "Every fact kept; codes and keys need not be.");
  const dropped = GOOD.replace("1.240", "muchas").replace("12%", "algunos").replace("Seguimos adelante", "Vemos");
  const missing = missingFacts(ORIGINAL, dropped);
  assert.ok(missing.includes("1.240"), "A dropped number.");
  assert.ok(missing.includes("12"), "A dropped percentage.");
  assert.ok(missing.includes("GO"), "A dropped decision.");
  assert.ok(!missing.some((fact) => fact.includes("49159512")), "A product code is no fact.");
  assert.ok(!missing.includes("20"), "An issue key is no fact.");
});

// ── A Motion stand-in over HTTP ────────────────────────────────────────────────────────────────
interface StoredObject {
  kind: "page" | "comment" | "database";
  id: string;
  title: string;
  text: string;
  rev: number;
  path: string[];
  issueKey: string | null;
  changedAt: number;
  human: {
    title: string | null;
    markdown: string;
    sourceRev: string;
    fingerprint: string | null;
    requested: boolean;
    origin: "generated" | "written";
  } | null;
}
const objects = new Map<string, StoredObject>();
const writes: string[] = [];
let clock = 1_000;
const put = (object: Omit<StoredObject, "changedAt" | "rev" | "human"> & Partial<StoredObject>) => {
  clock += 1;
  const stored: StoredObject = { rev: 1, human: null, ...object, changedAt: clock };
  objects.set(stored.id, stored);
  return stored;
};
const find = (reference: string) =>
  objects.get(reference) ?? [...objects.values()].find((object) => object.issueKey === reference);

async function body(request: IncomingMessage): Promise<DynamicRecord> {
  let text = "";
  for await (const chunk of request) text += chunk;
  const value = JSON.parse(text || "{}");
  return isDynamicRecord(value) ? value : {};
}

const server = createServer(async (request, response) => {
  const operation = request.url?.replace("/api/v1/", "") ?? "";
  const input = await body(request);
  const answer = (status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (request.headers["x-motion-agent"]) return answer(403, { error: { code: "forbidden" } });
  writes.push(operation);
  if (operation === "human.queue") {
    const since = Number(input.since ?? 0);
    const items = [...objects.values()]
      .filter((object) => object.changedAt > since || object.human?.requested)
      .sort((a, b) => a.changedAt - b.changedAt)
      .map((object) => ({
        kind: object.kind,
        object_id: object.id,
        workspace_id: WS,
        workspace_name: "Universidad Online",
        page_id: object.id,
        title: object.title,
        path: object.path,
        changed_at: object.changedAt,
        rev: String(object.rev),
        issue_key: object.issueKey,
        human: object.human
          ? {
              source_rev: object.human.sourceRev,
              fingerprint: object.human.fingerprint,
              requested: object.human.requested,
              origin: object.human.origin,
            }
          : null,
      }));
    return answer(200, { items, next_since: clock });
  }
  const object = isString(input.object_id) ? find(input.object_id) : undefined;
  if (!object) return answer(404, { error: { code: "not_found" } });
  if (operation === "human.source")
    return answer(200, {
      kind: object.kind,
      object_id: object.id,
      workspace_id: WS,
      page_id: object.id,
      title: object.title,
      text: object.text,
      rev: String(object.rev),
      path: object.path,
      url: `https://motion.test/w/${WS}/p/${object.id}`,
    });
  if (operation === "human.get")
    return answer(
      200,
      object.human ? { ...object.human, stale: object.human.sourceRev !== String(object.rev) } : { exists: false },
    );
  if (operation === "human.save") {
    const keep = input.keep === true;
    object.human = {
      title: keep ? (object.human?.title ?? null) : isString(input.title) ? input.title : null,
      markdown: keep ? (object.human?.markdown ?? "") : String(input.markdown),
      sourceRev: String(input.source_rev),
      fingerprint: isString(input.fingerprint) ? input.fingerprint : null,
      requested: false,
      origin: "generated",
    };
    return answer(200, { saved: true, stale: false });
  }
  return answer(404, { error: { code: "unknown_operation" } });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("The stand-in has no port.");
const base = `http://127.0.0.1:${address.port}`;

// The generation stand-in: a rewrite that drops a number the first time when asked to.
const prompts: string[] = [];
let dropFirst = false;
const generate = async ({ prompt }: { prompt: string }) => {
  prompts.push(prompt);
  const original = prompt.split("--- original ---\n")[1]?.split("\n--- end of original ---")[0] ?? "";
  if (original.includes("Precio $99")) {
    if (dropFirst) {
      dropFirst = false;
      return GOOD.replace("1.240", "muchas");
    }
    return GOOD;
  }
  return `# Versión para personas\n\n${original.replace(/\b[A-Z]{2,}-\d+\b/gu, "la tarea")}`;
};

const directory = mkdtempSync(join(tmpdir(), "motion-human-"));
const logs: string[] = [];
const human = new MotionHumanViews({
  call: async (operation, input) => {
    const response = await fetch(`${base}/api/v1/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Motion answered ${response.status}`);
    return response.json();
  },
  generate,
  agentId: () => "agent-a",
  language: () => "Spanish",
  available: () => true,
  stateFile: join(directory, "state.json"),
  log: (message) => logs.push(message),
});

const dossier = put({
  kind: "page",
  id: "01a20e29-46b6-7376-af8f-0290db7db3ba",
  title: "Dossier EVE-20 · Globos para Fiestas y Eventos (K49159512U)",
  text: ORIGINAL,
  path: ["Universidad Online", "Dossiers"],
  issueKey: null,
});
const notes = put({
  kind: "page",
  id: randomUUID(),
  title: "Notas sueltas",
  text: "Idea: CPA < 5 USD.",
  path: ["Ideas"],
  issueKey: null,
});

// 1. A pass: the dossier is for the owner and gets one; the loose notes do not. One retry for a dropped fact.
dropFirst = true;
const first = await human.pass();
check("retry once on a dropped fact", () => {
  const outcome = first.find((entry) => entry.objectId === dossier.id);
  assert.equal(outcome?.status, "generated");
  assert.equal(outcome?.missing, undefined, "The second try kept every fact.");
  const dossierPrompts = prompts.filter((prompt) => prompt.includes("Precio $99"));
  assert.equal(dossierPrompts.length, 2, "Exactly one more try.");
  assert.match(dossierPrompts[1] ?? "", /dropped these facts[^\n]*1\.240/u, "The retry names the missing fact.");
  assert.match(dossierPrompts[0] ?? "", /Do NOT add a summary/u, "No summary on top.");
  assert.equal(objects.get(dossier.id)?.human?.title, "Globos para fiestas");
  assert.equal(notes.human, null, "A page that is not for the owner gets none.");
});

// 2. An agent asks for a human view of a page that is not for the owner (`human_view` generate in Motion).
notes.human = { title: null, markdown: "", sourceRev: "", fingerprint: null, requested: true, origin: "generated" };
await human.pass();
check("agent request on a non-owner page", () => {
  assert.equal(notes.human?.requested, false);
  assert.match(notes.human?.markdown ?? "", /Idea/u);
  assert.equal(notes.text, "Idea: CPA < 5 USD.", "The agent text stays as it is.");
});

// 3. A ticket: its prompt says what the status means and what is pending.
const ticket = put({
  kind: "page",
  id: randomUUID(),
  title: "Lanzar anuncios de Globos",
  text: "Status: Blocked\nHandoff: esperando token Meta.",
  path: ["Ventas", "Tareas"],
  issueKey: "EVE-31",
});
human.noteOwnerText("Mira EVE-31 cuando puedas.");
await human.pass();
check("ticket linked to the owner", () => {
  assert.ok(ticket.human?.markdown, "A ticket the agent linked to the owner gets one.");
  assert.ok(prompts.some((prompt) => prompt.includes("work ticket") && prompt.includes("Lanzar anuncios")));
});

// 4. A small edit only stamps the new revision; a material change writes it again.
const generatedBefore = prompts.length;
dossier.text = `${ORIGINAL} `;
dossier.rev += 1;
clock += 1;
dossier.changedAt = clock;
await human.pass();
check("small edit restamps", () => {
  assert.equal(prompts.length, generatedBefore, "No generation for a small edit.");
  assert.equal(dossier.human?.sourceRev, String(dossier.rev));
});
dossier.text = ORIGINAL.replace("15 USD/día", "25 USD/día");
dossier.rev += 1;
clock += 1;
dossier.changedAt = clock;
check("fingerprint sees the change", () =>
  assert.notEqual(fingerprint(dossier.title, ORIGINAL), fingerprint(dossier.title, dossier.text)),
);
await human.pass();
check("material change regenerates", () => assert.ok(prompts.length > generatedBefore));

// 5. A version an agent wrote is kept until someone asks for a new one.
const written = put({ kind: "page", id: randomUUID(), title: "Decisiones", text: "GO", path: [], issueKey: null });
written.human = {
  title: "Decisiones",
  markdown: "Escrita por el agente.",
  sourceRev: "0",
  fingerprint: null,
  requested: false,
  origin: "written",
};
await human.pass();
check("written version kept", () => assert.equal(written.human?.markdown, "Escrita por el agente."));

// 6. Agents' text untouched: the host only ever wrote human versions.
check("agent text untouched", () => {
  const reads = new Set(["human.get", "human.queue", "human.source"]);
  assert.deepEqual(
    [...new Set(writes.filter((operation) => !reads.has(operation)))],
    ["human.save"],
    "Only human.save writes.",
  );
  assert.equal(notes.text, "Idea: CPA < 5 USD.");
});

// 7. The chat preview of a Motion link draws the human version, not the agent text.
const drawn: string[] = [];
const shown: string[] = [];
const snapshot: ConversationSnapshot = JSON.parse(
  JSON.stringify({ agentId: "agent-a", threadId: "thread-a", messages: [], revision: 0 }),
);
const tools = new OwnerTools({
  ownerAway: null,
  thumbnails: { drawNow: () => Effect.succeed(null) },
  visualPreview: {
    capture: ({ html }) => {
      drawn.push(html);
      return Effect.succeed({ imageUrl: `data:image/png;base64,${ONE_PIXEL_PNG}`, contentHeight: 300, console: [] });
    },
  },
  attachments: { openSources: () => Effect.succeed([]) },
  mailbox: {
    // This check sends no file with a message to the owner.
    stageGeneratedAttachments: () => Effect.succeed([]),
    stageGeneratedBytes: (input) =>
      Effect.succeed({
        id: `file-${randomUUID()}`,
        name: input.name,
        size: input.bytes.byteLength,
        kind: "image",
        mimeType: input.mimeType,
        previewKind: "image",
        previewUrl: null,
      }),
    persistGeneratedAttachmentsWithConversation: (current) => {
      shown.push(current.messages.at(-1)?.text ?? "");
      return current;
    },
    discardStagedGeneratedAttachments: () => Effect.void,
  },
  conversation: {
    ensureSnapshot: () => snapshot,
    publishConversation: () => undefined,
    isExecutionThread: () => false,
  },
  teamChannel: () => null,
  ownerText: (_agentId, text) => human.noteOwnerText(text),
  motionPreview: {
    isMotionPage: (url) => motionPageOfUrl(url) !== null,
    humanVersion: (url) => human.preview(url),
  },
});
const link = `https://motion.delynith.com/w/${WS}/p/${dossier.id}`;
const shared = await Effect.runPromise(
  tools.handle(
    {
      threadId: "thread-a",
      turnId: randomUUID(),
      callId: randomUUID(),
      namespace: "openbot",
      tool: "share_preview",
      arguments: { url: link, caption: "El dossier de globos" },
    },
    "agent-a",
    "thread-a",
  ),
);
check("chat preview uses the human version", () => {
  assert.equal(shared?.success, true);
  const html = drawn.at(-1) ?? "";
  assert.match(html, /Globos para fiestas/u, "The human title.");
  assert.doesNotMatch(html, /K49159512U|EVE-20/u, "No codes or keys.");
  assert.match(shown.at(-1) ?? "", new RegExp(link.replaceAll(".", "\\.")), "The link stays in the message.");
  assert.ok(human.linked().has(dossier.id), "A shared page is linked to the owner.");
  assert.match(humanViewHtml("T", "| a | b |\n|---|---|\n| 1 | 2 |"), /<table>/u, "Tables stay tables.");
});

// 8. The backfill: Decisiones and the linked dossier of Universidad Online.
const backfill = await human.backfill({
  workspaceName: "Universidad Online",
  days: 7,
  seedLinks: [`Revisa ${link}`],
  progress: () => undefined,
});
check("backfill", () => {
  const ids = backfill.outcomes.map((outcome) => outcome.objectId);
  assert.ok(ids.includes(dossier.id), "The linked dossier.");
  assert.ok(ids.includes(written.id), "Decisiones.");
  assert.ok(!ids.includes(notes.id), "Not a page outside the collections.");
});

server.close();
rmSync(directory, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "report.json"),
  `${JSON.stringify({ ok: true, checks, generations: prompts.length }, null, 2)}\n`,
);
process.stdout.write(`motion-human-views-e2e: ok (${checks.length} checks)\n`);
