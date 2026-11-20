import { channelAgentNoteLine } from "@openbot/contracts/channel-agent-note";
import type { ChannelMessage, ChannelTask } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { agentNotes, messageRows } from "./workspace-model";

const AGENTS = [
  { id: "lead", name: "Líder de Producto" },
  { id: "ads", name: "Creativo de Anuncios" },
];

let serial = 0;
function entry(
  author: ChannelMessage["author"],
  text: string,
  extra: Partial<ChannelMessage> & { system?: boolean } = {},
): ChannelMessage {
  serial += 1;
  const { system, ...rest } = extra;
  return {
    id: `m${serial}`,
    channelId: "c",
    sequence: serial,
    author,
    taskId: null,
    superseded: false,
    message: {
      id: `m${serial}`,
      text,
      author: system ? "system" : author.kind === "member" ? "user" : "assistant",
      createdAt: new Date(Date.UTC(2026, 10, 20, 9, serial)).toISOString(),
      status: "completed",
    },
    ...rest,
  };
}

function task(id: string, ownerAgentId: string, parentTaskId: string | null): ChannelTask {
  return {
    id,
    channelId: "c",
    parentTaskId,
    rootTaskId: parentTaskId ?? id,
    ownerAgentId,
    requestMessageId: "m0",
    instruction: "",
    attachmentDraftIds: [],
    expectedResult: "",
    sourceMessageIds: [],
    dependencies: [],
    resources: [],
    state: "completed",
    revision: 1,
    assignmentCount: 1,
    error: null,
  };
}

const lead = { kind: "agent" as const, id: "lead", name: "Líder de Producto" };
const ads = { kind: "agent" as const, id: "ads", name: "Creativo de Anuncios" };
const person = { kind: "member" as const, id: "alejandro", name: "Alejandro" };
const LONG =
  "Alejandro pregunta si el anuncio será imagen o link directo a la página. Necesito de ti un inventario corto y concreto: qué piezas existen hoy y en qué estado.";

describe("channelAgentNoteLine", () => {
  it("keeps the first sentence and drops the recipient's name", () => {
    expect(channelAgentNoteLine(`Creativo de Anuncios: ${LONG}`, ["Creativo de Anuncios"])).toBe(
      "Alejandro pregunta si el anuncio será imagen o link directo a la página.",
    );
    expect(channelAgentNoteLine(`@[Creativo de Anuncios](agent:ads) ${LONG}`, ["Creativo de Anuncios"])).toBe(
      "Alejandro pregunta si el anuncio será imagen o link directo a la página.",
    );
  });

  it("ellipsizes a long sentence at a word, within 120 characters", () => {
    const line = channelAgentNoteLine(`${"palabra ".repeat(40)}fin.`);
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("agent notes in the rows", () => {
  const tasks = [task("root", "lead", null), task("sub", "ads", "root")];
  const note = agentNotes(AGENTS, tasks);

  it("folds handoffs, briefs and subtask answers, and keeps what is for the people", () => {
    const question = entry(person, "¿Imagen o link?");
    const legacy = entry(lead, `Creativo de Anuncios: ${LONG}`, { system: true, taskId: "root" });
    const marked = entry(lead, `@[Creativo de Anuncios](agent:ads) ${LONG}`, {
      agentNote: { to: ["ads"], summary: "¿Me haces el inventario de piezas?" },
    });
    const answer = entry(ads, "Existen 11 copys con OK. Falta una imagen 1080×1350.", { taskId: "sub" });
    const final = entry(lead, "Será imagen única con link a la landing.", { taskId: "root" });
    const rows = messageRows([question, legacy, marked, answer, final], { thread: true, note });
    expect(rows.map((row) => row.note?.summary ?? null)).toEqual([
      null,
      "Alejandro pregunta si el anuncio será imagen o link directo a la página.",
      "¿Me haces el inventario de piezas?",
      "Existen 11 copys con OK.",
      null,
    ]);
    expect(rows.map((row) => row.note?.to ?? null)).toEqual([null, ["ads"], ["ads"], ["lead"], null]);
    // A folded line stands alone, and the lead's answer after it shows its name again.
    expect(rows[4]?.grouped).toBe(false);
  });

  it("does not offer to open a note whose text is its line", () => {
    const relay = entry(lead, "@[Creativo de Anuncios](agent:ads) ¿Puedes revisar el copy?", {
      agentNote: { to: ["ads"], summary: "¿Puedes revisar el copy?" },
    });
    expect(note(relay)?.expandable).toBe(false);
  });

  it("never folds a question for the people or a deleted message", () => {
    const asked = entry(lead, "Creativo de Anuncios: ¿apruebas?", { system: true, taskId: "root" });
    asked.message.questionPrompt = { requestId: "q", questions: [], resolution: { status: "answered", responses: {} } };
    expect(note(asked)).toBeNull();
    expect(
      note(entry(lead, `Creativo de Anuncios: ${LONG}`, { system: true, taskId: "root", deletedAt: "x" })),
    ).toBeNull();
  });
});
