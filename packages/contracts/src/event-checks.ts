import { type EventFilter, isEventFilter } from "./ipc-events";
import { isRoutineSchedule, type RoutineSchedule } from "./ipc-routines";
import { isDynamicRecord } from "./runtime-values";

export const EVENT_CHECK_HISTORY_LIMIT = 10;
export const EVENT_CHECK_ITEM_TYPE_PREFIX = "event-check-event:triggered:";
export const EVENT_CHECK_DEFAULT_INTERVAL_SECONDS = 30;
export type EventCheckSchedule =
  | RoutineSchedule
  | { kind: "interval"; amount: number; unit: "seconds"; anchorAt: string };
export interface EventCheckSelfEvents {
  connectionId: string;
  mode: "exclude" | "include";
  actorPointer: string;
  accountActorIds: string[];
}
export function defaultEventCheckSchedule(now = new Date()): EventCheckSchedule {
  return {
    kind: "interval",
    amount: EVENT_CHECK_DEFAULT_INTERVAL_SECONDS,
    unit: "seconds",
    anchorAt: now.toISOString(),
  };
}
export function isEventCheckSchedule(value: unknown): value is EventCheckSchedule {
  if (isRoutineSchedule(value)) return true;
  return (
    isDynamicRecord(value) &&
    value.kind === "interval" &&
    value.unit === "seconds" &&
    typeof value.amount === "number" &&
    Number.isSafeInteger(value.amount) &&
    value.amount >= 30 &&
    value.amount <= 8_640_000_000 &&
    typeof value.anchorAt === "string" &&
    Number.isFinite(Date.parse(value.anchorAt))
  );
}
export interface EventCheckSelection {
  itemsPointer: string;
  idPointer: string;
  revisionPointer: string;
}
export interface EventCheckMcpSource {
  kind: "mcp";
  connectionId: string;
  toolName: string;
  argumentsJson: string;
  cursorArgument: string;
  nextCursorPointer: string;
}
/** The most names one setting keeps, as many as a picker value can hold. */
export const EVENT_CHECK_OPTION_LABEL_MAX_ENTRIES = 50;
/** The longest name kept for a choice. A longer name is cut with an ellipsis. */
export const EVENT_CHECK_OPTION_LABEL_LIMIT = 120;
/** The ID of one option of a picker: plain, one word. The same shape that a picker value holds. */
export const EVENT_CHECK_OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export interface EventCheckConfiguration {
  name: string;
  label: string;
  description: string;
  value: string;
  /**
   * The readable names of the choices that `value` holds, by ID, so a person sees a channel name and
   * not its ID without a lookup. Display text only: no program reads it, and a change of it is never
   * a change of what the check reads. Optional and additive: a client or host from before it drops it
   * when it decodes the check, and the host keeps the saved names when a save carries none.
   */
  optionLabels?: Record<string, string>;
}
/** The marketplace template an installed check came from, and the version it was installed at. */
export interface EventCheckTemplateLink {
  slug: string;
  version: string;
}
export interface EventCheckApiSource extends Omit<EventCheckMcpSource, "kind"> {
  kind: "api";
  variables: string[];
  configuration: EventCheckConfiguration[];
  programDigest?: string;
  template?: EventCheckTemplateLink;
}
export type EventCheckSource = EventCheckMcpSource | EventCheckApiSource;
export interface EventCheckEnvironmentStatus {
  name: string;
  configured: boolean;
  /**
   * Set when a value is held but not usable, because the program or its destination settings changed
   * after the user approved them. The user approves the check again to use the values.
   */
  reapprove?: boolean;
}
export interface EventCheckEnvironmentInput {
  agentId: string;
  id: string;
  name: string;
  value: string | null;
}
/**
 * Who last saved a check, set by the host and never trusted from a client. It is additive: data and
 * clients from before it have no author, and a kind that this build does not know reads as none.
 */
export type EventCheckAuthor =
  | { kind: "user" }
  | { kind: "member"; name: string }
  | { kind: "agent"; agentId: string; name: string };
/**
 * How a check hands events to its agent. Both fields are optional on the wire. A check without them
 * delivers every changed item at once, as before. A client that does not know the object leaves it
 * out when it saves, and the host then keeps the saved value.
 */
export interface EventCheckDelivery {
  /** Seconds to collect events into one prompt. Zero delivers each execution's events at once. */
  digestSeconds: number;
  /** A changed item is delivered only when every filter matches it. Skipped items still enter the baseline. */
  itemFilters: EventFilter[];
}
const EVENT_CHECK_DIGEST_MAX_SECONDS = 86_400;
export const EVENT_CHECK_ITEM_FILTER_LIMIT = 16;
export interface EventCheckInput {
  id?: string;
  agentId: string;
  name: string;
  instruction: string;
  active: boolean;
  timezone: string;
  schedule: EventCheckSchedule;
  selfEvents: EventCheckSelfEvents;
  source: EventCheckSource;
  selection: EventCheckSelection;
  lastSavedBy?: EventCheckAuthor;
  /**
   * Asks the host to approve the program and destination settings as they are now, so the private
   * values work with them. Only a person can approve: the host ignores this from an agent tool, and
   * it is never stored. A host from before it ignores it, and the values stay unusable.
   */
  approveProgram?: boolean;
  delivery?: EventCheckDelivery;
}
/**
 * What the last executions say about a check. The host adds it to list answers and never saves it.
 * A client that does not know it ignores it.
 */
export interface EventCheckHealth {
  /** Executions that ended in an error since the last success, among the last ten. */
  consecutiveErrors: number;
  /** The safe text of the newest error, or null when the newest execution did not fail. */
  lastError: string | null;
  /** The result of the newest execution that was not cancelled, or null before the first one. */
  lastStatus?: EventCheckExecution["status"] | null;
  /** When that execution finished. */
  lastCheckedAt?: string | null;
}
export interface EventCheck extends Omit<EventCheckInput, "id" | "approveProgram"> {
  id: string;
  revision: string;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
  health?: EventCheckHealth;
}
export interface EventCheckExecution {
  id: string;
  checkId: string;
  startedAt: string;
  finishedAt: string;
  status: "baseline" | "unchanged" | "triggered" | "error" | "cancelled";
  itemCount: number;
  eventCount: number;
  skippedSelfCount: number;
  /** Changed items that the check's item filters kept out of the delivery. */
  filteredCount: number;
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
  /** True when the host keeps the `delivery` setting of a check (`event-check-delivery-v1`). Absent means unknown. */
  readonly deliverySettings?: boolean;
  environment?(input: { agentId: string; id: string }): Promise<EventCheckEnvironmentStatus[]>;
  setEnvironment?(input: EventCheckEnvironmentInput): Promise<EventCheckEnvironmentStatus[]>;
  test?(input: { agentId: string; id: string }): Promise<EventCheckExecution>;
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
  if (!isDynamicRecord(value) || typeof value.active !== "boolean") throw new Error("Invalid event check.");
  const schedule = value.schedule === undefined ? defaultEventCheckSchedule() : value.schedule;
  if (!isEventCheckSchedule(schedule) || JSON.stringify(schedule).length > 4096)
    throw new Error("Invalid event check schedule.");
  return {
    ...(value.id === undefined ? {} : { id: text(value.id, 128, true) }),
    agentId: text(value.agentId, 128, true),
    name: text(value.name, 256, true),
    instruction: text(value.instruction, 16000, true),
    active: value.active,
    timezone: text(value.timezone, 128, true),
    schedule,
    selfEvents: decodeSelfEvents(value.selfEvents),
    source: decodeSource(value.source),
    selection: decodeSelection(value.selection),
    ...authorField(value.lastSavedBy),
    ...(value.approveProgram === true ? { approveProgram: true } : {}),
    ...(value.delivery === undefined ? {} : { delivery: decodeDelivery(value.delivery) }),
  };
}
function decodeDelivery(value: unknown): EventCheckDelivery {
  if (
    !isDynamicRecord(value) ||
    typeof value.digestSeconds !== "number" ||
    !Number.isSafeInteger(value.digestSeconds) ||
    value.digestSeconds < 0 ||
    value.digestSeconds > EVENT_CHECK_DIGEST_MAX_SECONDS ||
    !Array.isArray(value.itemFilters) ||
    value.itemFilters.length > EVENT_CHECK_ITEM_FILTER_LIMIT ||
    !value.itemFilters.every(isEventFilter) ||
    value.itemFilters.some((filter) => JSON.stringify(filter).length > 1024)
  )
    throw new Error("Invalid event check delivery.");
  return {
    digestSeconds: value.digestSeconds,
    itemFilters: value.itemFilters.map((filter) => ({ pointer: filter.pointer, value: filter.value })),
  };
}
function decodeHealth(value: unknown): EventCheckHealth {
  if (!isDynamicRecord(value)) throw new Error("Invalid event check health.");
  return {
    consecutiveErrors: count(value.consecutiveErrors),
    lastError: value.lastError === null ? null : text(value.lastError, 2048),
    ...(value.lastStatus === undefined
      ? {}
      : { lastStatus: value.lastStatus === null ? null : executionStatus(value.lastStatus) }),
    ...(value.lastCheckedAt === undefined
      ? {}
      : { lastCheckedAt: value.lastCheckedAt === null ? null : text(value.lastCheckedAt, 128, true) }),
  };
}
function authorField(value: unknown): { lastSavedBy?: EventCheckAuthor } {
  if (!isDynamicRecord(value)) return {};
  if (value.kind === "user") return { lastSavedBy: { kind: "user" } };
  if (value.kind === "member" && typeof value.name === "string")
    return { lastSavedBy: { kind: "member", name: value.name.slice(0, 128) } };
  if (value.kind === "agent" && typeof value.agentId === "string" && typeof value.name === "string")
    return { lastSavedBy: { kind: "agent", agentId: value.agentId.slice(0, 128), name: value.name.slice(0, 128) } };
  return {};
}
function decodeSelfEvents(value: unknown): EventCheckSelfEvents {
  if (value === undefined) return { mode: "exclude", connectionId: "", actorPointer: "", accountActorIds: [] };
  if (
    !isDynamicRecord(value) ||
    (value.mode !== "exclude" && value.mode !== "include") ||
    !Array.isArray(value.accountActorIds) ||
    value.accountActorIds.length > 20
  )
    throw new Error("Invalid self-event filter.");
  return {
    mode: value.mode,
    connectionId: value.connectionId === undefined ? "" : text(value.connectionId, 128),
    actorPointer: pointer(value.actorPointer),
    accountActorIds: value.accountActorIds.map((id) => text(id, 512, true)),
  };
}
function decodeSource(value: unknown): EventCheckSource {
  if (!isDynamicRecord(value) || (value.kind !== "mcp" && value.kind !== "api"))
    throw new Error("Invalid event check source.");
  const argumentsJson = text(value.argumentsJson, 16000, true);
  if (!isDynamicRecord(JSON.parse(argumentsJson))) throw new Error("Invalid event check arguments.");
  if (value.kind === "api") {
    if (
      !Array.isArray(value.variables) ||
      value.variables.length > 20 ||
      !Array.isArray(value.configuration) ||
      value.configuration.length > 30
    )
      throw new Error("Invalid program configuration.");
    const variables = value.variables.map(environmentName);
    const configuration = value.configuration.map(decodeConfiguration);
    const argumentsValue = JSON.parse(argumentsJson);
    if (configuration.some((field) => Object.hasOwn(argumentsValue, field.name) || field.name === value.cursorArgument))
      throw new Error("Configuration conflicts with program arguments.");
    if (
      new Set(variables).size !== variables.length ||
      new Set(configuration.map((field) => field.name)).size !== configuration.length
    )
      throw new Error("Duplicate variable.");
    if (
      configuration.some(
        (field) =>
          variables.includes(field.name) || /(?:token|password|secret|api_?key|authorization)/i.test(field.name),
      )
    )
      throw new Error("Private variables cannot be ordinary configuration.");
    const programDigest = value.programDigest === undefined ? undefined : text(value.programDigest, 64, true);
    if (programDigest && !/^[a-f0-9]{64}$/.test(programDigest)) throw new Error("Invalid program digest.");
    return {
      kind: "api",
      connectionId: text(value.connectionId, 128, true),
      variables,
      configuration,
      ...(programDigest ? { programDigest } : {}),
      ...(value.template === undefined ? {} : { template: decodeTemplateLink(value.template) }),
      toolName: text(value.toolName, 256, true),
      argumentsJson,
      cursorArgument: text(value.cursorArgument, 128),
      nextCursorPointer: pointer(value.nextCursorPointer),
    };
  }
  return {
    kind: "mcp",
    connectionId: text(value.connectionId, 128, true),
    toolName: text(value.toolName, 256, true),
    argumentsJson,
    cursorArgument: text(value.cursorArgument, 128),
    nextCursorPointer: pointer(value.nextCursorPointer),
  };
}
function decodeTemplateLink(value: unknown): EventCheckTemplateLink {
  if (!isDynamicRecord(value)) throw new Error("Invalid template link.");
  const slug = text(value.slug, 64, true);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("Invalid template link.");
  return { slug, version: text(value.version, 64, true) };
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
  const { approveProgram: _request, ...input } = decodeEventCheckInput(value);
  if (!isDynamicRecord(value)) throw new Error("Invalid event check.");
  return {
    ...input,
    id: text(value.id, 128, true),
    revision: text(value.revision, 128, true),
    nextCheckAt: text(value.nextCheckAt, 128, true),
    createdAt: text(value.createdAt, 128, true),
    updatedAt: text(value.updatedAt, 128, true),
    ...(value.health === undefined ? {} : { health: decodeHealth(value.health) }),
  };
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid check count.");
  return value;
}
function executionStatus(status: unknown): EventCheckExecution["status"] {
  if (
    status !== "baseline" &&
    status !== "unchanged" &&
    status !== "triggered" &&
    status !== "error" &&
    status !== "cancelled"
  )
    throw new Error("Invalid check status.");
  return status;
}
export function decodeEventCheckExecution(value: unknown): EventCheckExecution {
  if (!isDynamicRecord(value)) throw new Error("Invalid check execution.");
  const status = executionStatus(value.status);
  return {
    id: text(value.id, 128, true),
    checkId: text(value.checkId, 128, true),
    startedAt: text(value.startedAt, 128, true),
    finishedAt: text(value.finishedAt, 128, true),
    status,
    itemCount: count(value.itemCount),
    eventCount: count(value.eventCount),
    skippedSelfCount: value.skippedSelfCount === undefined ? 0 : count(value.skippedSelfCount),
    filteredCount: value.filteredCount === undefined ? 0 : count(value.filteredCount),
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

export function environmentName(value: unknown): string {
  const name = text(value, 128, true);
  if (
    !/^[A-Z][A-Z0-9_]*$/.test(name) ||
    /^(PATH|HOME|SHELL|LANG|NODE_.*|PYTHON.*|BASH_ENV|ENV|LD_.*|DYLD_.*|ELECTRON_.*|OPENBOT_.*|BUN_.*|RUBY.*|PERL.*)$/.test(
      name,
    )
  )
    throw new Error("Invalid variable name.");
  return name;
}
export function decodeEventCheckEnvironmentInput(value: unknown): EventCheckEnvironmentInput {
  const target = decodeEventCheckTarget(value);
  if (!isDynamicRecord(value)) throw new Error("Invalid environment input.");
  const secret = value.value === null ? null : text(value.value, 8192, true);
  if (secret !== null && (secret.length < 4 || /[\r\n\0]/.test(secret))) throw new Error("Invalid variable value.");
  return { ...target, name: environmentName(value.name), value: secret };
}
export function decodeEventCheckEnvironmentStatus(value: unknown): EventCheckEnvironmentStatus {
  if (!isDynamicRecord(value) || typeof value.configured !== "boolean") throw new Error("Invalid variable status.");
  return {
    name: environmentName(value.name),
    configured: value.configured,
    ...(value.reapprove === true ? { reapprove: true } : {}),
  };
}
export function decodeMcpEventCheckInput(value: unknown): EventCheckInput {
  const input = decodeEventCheckInput(value);
  if (input.source.kind !== "mcp") throw new Error("Unsupported v1 source.");
  return input;
}
export function decodeMcpEventCheck(value: unknown): EventCheck {
  const check = decodeEventCheck(value);
  if (check.source.kind !== "mcp") throw new Error("Unsupported v1 source.");
  return check;
}

/** Text from another party: no control or formatting character, one line, a bounded length. */
export function cleanEventCheckOptionText(value: unknown, limit: number): string {
  if (typeof value !== "string") throw new Error("Invalid picker option.");
  const cleaned = value
    .replace(/[\t\n\r\u2028\u2029]/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(cleaned);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : cleaned;
}
/**
 * Saved names of choices, read leniently: an entry that is wrong is dropped, and a value that is not
 * a record is none. A name never fails the check that carries it.
 */
export function decodeEventCheckOptionLabels(value: unknown): Record<string, string> | undefined {
  if (!isDynamicRecord(value)) return undefined;
  const labels: Record<string, string> = {};
  let count = 0;
  for (const [id, entry] of Object.entries(value)) {
    if (count >= EVENT_CHECK_OPTION_LABEL_MAX_ENTRIES) break;
    if (!EVENT_CHECK_OPTION_ID.test(id) || typeof entry !== "string") continue;
    const label = cleanEventCheckOptionText(entry, EVENT_CHECK_OPTION_LABEL_LIMIT);
    if (!label) continue;
    labels[id] = label;
    count++;
  }
  return count === 0 ? undefined : labels;
}
function decodeConfiguration(value: unknown): EventCheckConfiguration {
  if (!isDynamicRecord(value)) throw new Error("Invalid configuration field.");
  const name = text(value.name, 128, true);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name))
    throw new Error("Invalid configuration name.");
  const optionLabels = decodeEventCheckOptionLabels(value.optionLabels);
  return {
    name,
    label: text(value.label, 256, true),
    description: text(value.description, 2048),
    value: text(value.value, 8192),
    ...(optionLabels ? { optionLabels } : {}),
  };
}

export { decodeSelfEvents as decodeEventCheckSelfEvents, pointer as eventCheckPointer, text as eventCheckText };
