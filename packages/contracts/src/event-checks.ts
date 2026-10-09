import { isRoutineSchedule, type RoutineSchedule } from "./ipc-routines";
import { isDynamicRecord } from "./runtime-values";

export const EVENT_CHECK_HISTORY_LIMIT = 10;
export const EVENT_CHECK_ITEM_TYPE_PREFIX = "event-check-event:triggered:";
export interface EventCheckSelection {
  itemsPointer: string;
  idPointer: string;
  revisionPointer: string;
}
export interface EventCheckSource {
  kind: "mcp";
  connectionId: string;
  toolName: string;
  argumentsJson: string;
  cursorArgument: string;
  nextCursorPointer: string;
}
export interface EventCheckInput {
  id?: string;
  agentId: string;
  name: string;
  instruction: string;
  active: boolean;
  timezone: string;
  schedule: RoutineSchedule;
  source: EventCheckSource;
  selection: EventCheckSelection;
}
export interface EventCheck extends Omit<EventCheckInput, "id"> {
  id: string;
  revision: string;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface EventCheckExecution {
  id: string;
  checkId: string;
  startedAt: string;
  finishedAt: string;
  status: "baseline" | "unchanged" | "triggered" | "error" | "cancelled";
  itemCount: number;
  eventCount: number;
  durationMs: number;
  error: string | null;
}
export interface EventCheckAccount {
  id: string;
  name: string;
}
export interface EventCheckTool {
  name: string;
  description: string;
  inputSchemaJson: string;
}
/** Host-only delivery metadata. App data stays in the framed provider input, not this marker. */
export interface EventCheckOrigin {
  checkId: string;
  executionId: string;
  name: string;
}
export interface EventCheckApi {
  list(input: { agentId: string }): Promise<EventCheck[]>;
  save(input: EventCheckInput): Promise<EventCheck>;
  remove(input: { agentId: string; id: string }): Promise<void>;
  checkNow(input: { agentId: string; id: string }): Promise<EventCheckExecution>;
  history(input: { agentId: string; id: string }): Promise<EventCheckExecution[]>;
  accounts(input: { agentId: string }): Promise<EventCheckAccount[]>;
  tools(input: { agentId: string; connectionId: string }): Promise<EventCheckTool[]>;
}

function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim()))
    throw new Error("Invalid event check text.");
  return value;
}
export function decodeEventCheckTarget(value: unknown): { agentId: string; id: string } {
  if (!isDynamicRecord(value)) throw new Error("Invalid event check target.");
  return { agentId: text(value.agentId, 128, true), id: text(value.id, 128, true) };
}
export function decodeEventCheckInput(value: unknown): EventCheckInput {
  if (!isDynamicRecord(value) || typeof value.active !== "boolean" || !isRoutineSchedule(value.schedule))
    throw new Error("Invalid event check.");
  if (JSON.stringify(value.schedule).length > 4096) throw new Error("Invalid event check schedule.");
  return {
    ...(value.id === undefined ? {} : { id: text(value.id, 128, true) }),
    agentId: text(value.agentId, 128, true),
    name: text(value.name, 256, true),
    instruction: text(value.instruction, 16000, true),
    active: value.active,
    timezone: text(value.timezone, 128, true),
    schedule: value.schedule,
    source: decodeSource(value.source),
    selection: decodeSelection(value.selection),
  };
}
function decodeSource(value: unknown): EventCheckSource {
  if (!isDynamicRecord(value) || value.kind !== "mcp") throw new Error("Invalid event check source.");
  const argumentsJson = text(value.argumentsJson, 16000, true);
  if (!isDynamicRecord(JSON.parse(argumentsJson))) throw new Error("Invalid event check arguments.");
  return {
    kind: "mcp",
    connectionId: text(value.connectionId, 128, true),
    toolName: text(value.toolName, 256, true),
    argumentsJson,
    cursorArgument: text(value.cursorArgument, 128),
    nextCursorPointer: pointer(value.nextCursorPointer),
  };
}
function pointer(value: unknown): string {
  const parsed = text(value, 512);
  if (parsed && (!parsed.startsWith("/") || /~(?![01])/.test(parsed))) throw new Error("Invalid JSON pointer.");
  return parsed;
}
function decodeSelection(value: unknown): EventCheckSelection {
  if (!isDynamicRecord(value)) throw new Error("Invalid event check selection.");
  return {
    itemsPointer: pointer(value.itemsPointer),
    idPointer: pointer(value.idPointer),
    revisionPointer: pointer(value.revisionPointer),
  };
}
export function decodeEventCheck(value: unknown): EventCheck {
  const input = decodeEventCheckInput(value);
  if (!isDynamicRecord(value)) throw new Error("Invalid event check.");
  return {
    ...input,
    id: text(value.id, 128, true),
    revision: text(value.revision, 128, true),
    nextCheckAt: text(value.nextCheckAt, 128, true),
    createdAt: text(value.createdAt, 128, true),
    updatedAt: text(value.updatedAt, 128, true),
  };
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid check count.");
  return value;
}
export function decodeEventCheckExecution(value: unknown): EventCheckExecution {
  if (!isDynamicRecord(value)) throw new Error("Invalid check execution.");
  const status = value.status;
  if (
    status !== "baseline" &&
    status !== "unchanged" &&
    status !== "triggered" &&
    status !== "error" &&
    status !== "cancelled"
  )
    throw new Error("Invalid check status.");
  return {
    id: text(value.id, 128, true),
    checkId: text(value.checkId, 128, true),
    startedAt: text(value.startedAt, 128, true),
    finishedAt: text(value.finishedAt, 128, true),
    status,
    itemCount: count(value.itemCount),
    eventCount: count(value.eventCount),
    durationMs: count(value.durationMs),
    error: value.error === null ? null : text(value.error, 2048),
  };
}
export function decodeEventCheckAccount(value: unknown): EventCheckAccount {
  if (!isDynamicRecord(value)) throw new Error("Invalid check account.");
  return { id: text(value.id, 128, true), name: text(value.name, 256) };
}
export function decodeEventCheckTool(value: unknown): EventCheckTool {
  if (!isDynamicRecord(value)) throw new Error("Invalid check tool.");
  return {
    name: text(value.name, 256, true),
    description: text(value.description, 4096),
    inputSchemaJson: text(value.inputSchemaJson, 16000),
  };
}
export function decodeEventCheckList<A>(value: unknown, decode: (entry: unknown) => A, maximum = 100): A[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Invalid check list.");
  return value.map(decode);
}
