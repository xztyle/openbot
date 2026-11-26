// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_MOTION_EVENTS } from "@openbot/contracts/ipc";
import { decodeAttentionItems } from "@openbot/contracts/team-protocol/attention-items-v1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeMotionEvent, type MotionEvent } from "./motion-event";
import { keptOwnerOnly, MotionEventsService, type WaitingTicket } from "./motion-events-service";
import { missingLine } from "./motion-grader";
import {
  fallbackReason,
  nothingAsked,
  ownerHasNothingToDo,
  parseWaitingAsks,
  routeWithoutOwner,
  waitingAsksPrompt,
  waitingChat,
  waitingComments,
} from "./motion-waiting-asks";

const dev = { id: "u-dev", name: "Dev", kind: "agent", agent_key: "agent-dev", role: "member" };
const ana = { id: "u-ana", name: "Ana", kind: "person", agent_key: null, role: "owner" };

function waitingEvent(): MotionEvent {
  const decoded = decodeMotionEvent({
    id: `evt-${Math.random()}`,
    type: "issue.waiting_on_person",
    at: 1,
    workspace: { name: "W" },
    issue: {
      id: "issue-41",
      key: "COC-41",
      title: "Rehacer el copy de los anuncios de Cena Navideña",
      url: "https://motion.test/w/p/41",
      status: { name: "Blocked", category: "in_progress" },
      assignees: [ana],
    },
    actor: dev,
    recipients: [ana],
  });
  if (!decoded) throw new Error("not decoded");
  return decoded;
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "motion-asks-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function service() {
  const shown: (readonly WaitingTicket[])[] = [];
  const classified: string[] = [];
  const events = new MotionEventsService({
    settings: () => ({ ...DEFAULT_WORKSPACE_MOTION_EVENTS, quietHours: { enabled: false, start: 0, end: 0 } }),
    agents: () => [{ id: "agent-dev", name: "Dev" }],
    deliver: async () => undefined,
    showWaiting: (tickets) => shown.push(tickets),
    classify: (ticket) => classified.push(ticket.key),
    notifyOwner: () => undefined,
    timeZone: () => "UTC",
    stateFile: join(root, "events.json"),
    log: () => undefined,
    now: () => 1_000_000,
  });
  return { events, shown, classified };
}

describe("why a ticket waits on the owner", () => {
  it("asks the host to read a new waiting ticket, and keeps what it read", async () => {
    const { events, shown, classified } = service();
    await events.receive(waitingEvent());
    expect(classified).toEqual(["COC-41"]);
    await events.setAsks("issue-41", "approval", "  Aprobar el copy v0.5;\n falta la licencia CC0 de la foto  ");
    expect(events.waiting()[0]).toMatchObject({
      asks: "approval",
      reason: "Aprobar el copy v0.5; falta la licencia CC0 de la foto",
    });
    // Until the host knows who answers it, and when its manager does, it is not in Needs you.
    expect(shown.at(-1)).toEqual([]);
    await events.setApprover("issue-41", "manager");
    expect(shown.at(-1)).toEqual([]);
    await events.setApprover("issue-41", "owner", { by: "Lead", reason: "It needs a contract signed." });
    expect(shown.at(-1)?.[0]).toMatchObject({ asks: "approval", approver: "owner", escalatedBy: "Lead" });
    const saved = JSON.parse(await readFile(join(root, "events.json"), "utf8"));
    expect(saved.waiting[0].asks).toBe("approval");
  });

  it("reads the tickets of before once at start", async () => {
    const first = service();
    await first.events.receive(waitingEvent());
    const second = service();
    await second.events.start();
    expect(second.classified).toEqual(["COC-41"]);
    await second.events.setAsks("issue-41", "blocked", "Falta el acceso");
    // A ticket of before the approval model, with asks but no approver, is read again once.
    const migrated = service();
    await migrated.events.start();
    expect(migrated.classified).toEqual(["COC-41"]);
    await migrated.events.setApprover("issue-41", "manager");
    const third = service();
    await third.events.start();
    expect(third.classified).toEqual([]);
  });

  it("reads again a ticket that went to the owner under the first rules, unless a manager escalated it", async () => {
    const first = service();
    await first.events.receive(waitingEvent());
    await first.events.setApprover("issue-41", "owner");
    const saved = JSON.parse(await readFile(join(root, "events.json"), "utf8"));
    saved.waiting[0] = { ...saved.waiting[0], asks: "review-escalated", ownerOnly: "money", rules: undefined };
    await writeFile(join(root, "events.json"), JSON.stringify(saved));
    const second = service();
    await second.events.start();
    expect(second.events.waiting()[0]?.approver).toBeUndefined();
    expect(second.classified).toEqual(["COC-41"]);
    expect(second.shown.at(-1)).toEqual([]);
    await second.events.setApprover("issue-41", "owner", { by: "Lead", reason: "Needs a contract." });
    const third = service();
    await third.events.start();
    expect(third.events.waiting()[0]?.approver).toBe("owner");
  });

  it("keeps a ticket with the owner only for a real spend or a real credential", () => {
    expect(keptOwnerOnly("review-escalated", "Copys de anuncios, presupuesto 70 USD", "money")).toBeNull();
    expect(keptOwnerOnly("approval", "Pagar 70 USD en anuncios", "money")).toBe("money");
    expect(
      keptOwnerOnly("blocked", "Faltan el REF/OFFER/PRODUCT_ID de la oferta y una foto con licencia", "credentials"),
    ).toBeNull();
    expect(keptOwnerOnly("blocked", "Necesito la contraseña de Hotmart", "credentials")).toBe("credentials");
  });

  it("marks a ticket the grader gave up on as an escalated review with what it misses", async () => {
    const { events, classified } = service();
    await events.start();
    events.escalate(
      {
        issueId: "issue-44",
        agentId: "agent-dev",
        key: "COC-44",
        title: "Biblioteca de anuncios",
        url: "https://m/44",
      },
      "COC-44 still misses its criteria after 3 reviews.",
      missingLine("La evidencia no basta.\nMissing:\n- Cursos anunciados\n- Textos y días activos"),
    );
    expect(events.waiting()[0]).toMatchObject({
      asks: "review-escalated",
      reason: "Cursos anunciados; Textos y días activos",
    });
    // Its approver is read next: the manager, not the owner, unless only the owner may decide it.
    expect(classified).toEqual(["COC-44"]);
    expect(events.waiting()[0]?.approver).toBeUndefined();
    // Its save ends before the folder goes.
    await events.setApprover("issue-44", "manager");
  });

  it("parses the judge's answer and falls back to the last comment", () => {
    expect(parseWaitingAsks('Sure: {"asks": "approval", "reason": "Aprobar el copy"}')).toEqual({
      asks: "approval",
      reason: "Aprobar el copy",
      ownerOnly: null,
      plain: null,
      ownerAction: true,
      signIn: null,
    });
    expect(
      parseWaitingAsks(
        '{"asks": "blocked", "reason": "Falta la contraseña", "owner_only": "credentials", "plain": {"asks": "Necesita tu contraseña de Meta.", "why": "Sin ella no puede seguir.", "if_yes": "Sigue hoy.", "if_no": "Se queda parado."}}',
      ),
    ).toMatchObject({ asks: "blocked", ownerOnly: "credentials", plain: { asks: "Necesita tu contraseña de Meta." } });
    // Accepting reviewed ad copy commits no money, whatever the judge says.
    expect(
      parseWaitingAsks(
        '{"asks": "review-escalated", "reason": "Copys de anuncios, presupuesto 70 USD", "owner_only": "money"}',
      )?.ownerOnly,
    ).toBeNull();
    expect(parseWaitingAsks('{"asks": "publish"}')).toBeNull();
    expect(parseWaitingAsks("no json")).toBeNull();
    const comments = waitingComments({
      items: [{ body: "old" }, { body: "\nSalida con aprobación escrita de Alejandro.\nMás" }],
    });
    expect(fallbackReason(comments)).toBe("Salida con aprobación escrita de Alejandro.");
    expect(waitingAsksPrompt({ key: "COC-41", title: "Copy", comments })).toContain("aprobación escrita");
  });

  it("carries asks and reason on the wire and refuses an unknown kind", () => {
    const base = {
      kind: "question",
      requestId: "motion:issue-41",
      agentId: "agent-dev",
      threadId: "thread-dev",
      turnId: "motion",
      createdAt: new Date(0).toISOString(),
      url: "https://motion.test/w/p/41",
    };
    expect(decodeAttentionItems([{ ...base, asks: "approval", reason: "Aprobar el copy" }])[0]).toMatchObject({
      asks: "approval",
      reason: "Aprobar el copy",
    });
    expect(() => decodeAttentionItems([{ ...base, asks: "pay" }])).toThrow();
  });

  // Failure mode: "Te espera en Motion" cards that said "No se le pide nada" (EVE-35) or "No hace falta
  // que decida nada" (MAN-10) sat in Needs you with Accept / Send back buttons, while MAN-10's real
  // blocker, a Hotmart sign-in, was only in the agent's chat.
  it("re-routes a ticket whose summary asks the owner nothing, away from the owner", async () => {
    const plain = {
      asks: "No se le pide nada: el trabajo ya fue aprobado por su equipo de ventas y puede cerrarse.",
      why: "Sirve para decidir en qué países anunciar.",
      if_yes: "Se cierra el trabajo.",
      if_no: "Nada cambia.",
    };
    // The judge said there is an action, but its own summary says there is none: the check wins.
    const judged = parseWaitingAsks(
      JSON.stringify({ asks: "review-escalated", reason: "x", owner_action: "yes", plain }),
    );
    expect(judged && ownerHasNothingToDo(judged)).toBe(true);
    expect(nothingAsked("No hace falta que decida nada: la página de regalos sigue en pausa.")).toBe(true);
    expect(nothingAsked("¿Cerramos este trabajo ya aprobado?")).toBe(false);
    const none = parseWaitingAsks('{"asks": "other", "reason": "Pausada", "owner_action": "none"}');
    expect(none && ownerHasNothingToDo(none)).toBe(true);

    // With a manager, the manager answers it; the owner never sees it.
    const routed: unknown[] = [];
    const first = service();
    await first.events.receive(waitingEvent());
    const ticket = first.events.waiting()[0];
    if (!ticket) throw new Error("no ticket");
    const told: string[] = [];
    const tell = async (_agent: string, text: string) => void told.push(text);
    expect(
      await routeWithoutOwner({
        ticket,
        evidence: "",
        approvalId: "ticket:issue-41",
        approvals: {
          route: async (request) => {
            routed.push(request);
            return { approver: "manager", agentId: "agent-lead" };
          },
        },
        events: first.events,
        tell,
      }),
    ).toBe("manager");
    expect(routed).toHaveLength(1);
    expect(first.events.waiting()[0]?.approver).toBe("manager");
    expect(first.shown.at(-1)).toEqual([]);

    // With no agent that may answer it, it leaves the list, and its agent hears why.
    const second = service();
    await second.events.receive(waitingEvent());
    const again = second.events.waiting()[0];
    if (!again) throw new Error("no ticket");
    expect(
      await routeWithoutOwner({
        ticket: again,
        evidence: "",
        approvalId: "ticket:issue-41",
        approvals: { route: async () => ({ approver: "owner" }) },
        events: second.events,
        tell,
      }),
    ).toBe("dismissed");
    expect(second.events.waiting()).toEqual([]);
    expect(told.at(-1)).toContain("asks the owner nothing");
  });

  it("makes a sign-in blocker a sign-in card that stays with the owner", async () => {
    const judged = parseWaitingAsks(
      JSON.stringify({
        asks: "other",
        reason: "Ninguna decisión pedida",
        owner_action: "yes",
        owner_only: "none",
        sign_in: { site: "Hotmart", url: "https://sso.hotmart.com/login" },
        plain: {
          asks: "Inicia sesión en Hotmart con la cuenta de Seminarios.Online para que podamos afiliar los cursos.",
          why: "Sin la sesión no hay enlaces de compra.",
          if_yes: "El agente abre la página y tú inicias sesión.",
          if_no: "Las páginas siguen sin enlace de compra.",
        },
      }),
    );
    expect(judged?.signIn).toEqual({ site: "Hotmart", url: "https://sso.hotmart.com/login" });
    expect(judged && ownerHasNothingToDo(judged)).toBe(false);
    // An address that is not a web page is dropped; the site stays.
    expect(
      parseWaitingAsks('{"asks": "blocked", "reason": "x", "sign_in": {"site": "Hotmart", "url": "javascript:x"}}')
        ?.signIn,
    ).toEqual({
      site: "Hotmart",
    });

    const { events, shown } = service();
    await events.receive(waitingEvent());
    await events.setAsks("issue-41", judged?.asks ?? "other", judged?.reason ?? "", {
      ownerOnly: judged?.ownerOnly ?? null,
      plain: judged?.plain ?? null,
      signIn: judged?.signIn ?? null,
    });
    expect(events.waiting()[0]).toMatchObject({ ownerOnly: "credentials", signIn: { site: "Hotmart" } });
    await events.setApprover("issue-41", "owner");
    expect(shown.at(-1)?.[0]?.signIn?.site).toBe("Hotmart");
    // The wire keeps it; a bad one fails closed.
    const base = {
      kind: "question",
      requestId: "motion:issue-41",
      agentId: "agent-dev",
      threadId: "thread-dev",
      turnId: "motion",
      createdAt: new Date(0).toISOString(),
    };
    expect(decodeAttentionItems([{ ...base, signIn: { site: "Hotmart" } }])[0]?.signIn).toEqual({ site: "Hotmart" });
    expect(() => decodeAttentionItems([{ ...base, signIn: { site: "" } }])).toThrow();
  });

  it("reads the agent's chat lines that name the ticket, and its newest answers", () => {
    const message = (author: "assistant" | "user" | "system", text: string) => ({
      id: `m-${Math.random()}`,
      author,
      text,
      createdAt: new Date(0).toISOString(),
    });
    const chat = waitingChat(
      [
        message("assistant", "MAN-10 espera que Alejandro inicie sesión en Hotmart."),
        message("assistant", "Otra cosa 1"),
        message("user", "MAN-10 del dueño"),
        message("system", "MAN-10 nota del host"),
        message("assistant", "Otra cosa 2"),
      ],
      "man-10",
    );
    expect(chat.map((line) => line.body)).toEqual([
      "MAN-10 espera que Alejandro inicie sesión en Hotmart.",
      "Otra cosa 1",
      "Otra cosa 2",
    ]);
    expect(waitingAsksPrompt({ key: "MAN-10", title: "Landing", comments: [], chat })).toContain(
      "inicie sesión en Hotmart",
    );
  });
});
