// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_MOTION_EVENTS } from "@openbot/contracts/ipc";
import { decodeAttentionItems } from "@openbot/contracts/team-protocol/attention-items-v1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeMotionEvent, type MotionEvent } from "./motion-event";
import { MotionEventsService, type WaitingTicket } from "./motion-events-service";
import { missingLine } from "./motion-grader";
import { fallbackReason, parseWaitingAsks, waitingAsksPrompt, waitingComments } from "./motion-waiting-asks";

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
});
