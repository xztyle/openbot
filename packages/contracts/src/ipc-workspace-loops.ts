// Loops: the owner's own pipelines. A loop is a list of stages in order, with branches (an item may go
// from a stage to any stage in its `next` list), and items move through it: a product, a lead, a video,
// a feature, a customer question. Each stage can name an owner agent, a checklist and metric thresholds
// that must hold before an item leaves it, a gate (the owner approves before an item enters it: money,
// publish or another decision), a deadline in days, and what happens when an item enters it (a Motion
// ticket, a note that wakes the owner agent, a routine run). An item can have experiments: a hypothesis,
// variants, a metric, a budget and a result. A gate and an experiment with a budget wait for the owner
// as a decision, which "Needs you" lists.

import { isBoundedString, isFiniteNumber, isIdentifier } from "./ipc-bounded-values";
import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

export const LOOP_LIMITS = {
  loopsPerSpace: 50,
  stages: 20,
  fields: 24,
  checklist: 12,
  metrics: 8,
  next: 20,
  variants: 8,
  values: 40,
  items: 2000,
  events: 400,
  experiments: 500,
  decisions: 200,
  templates: 20,
  name: 80,
  stageId: 40,
  fieldKey: 40,
  label: 80,
  text: 2000,
  description: 4000,
  value: 2000,
  note: 2000,
} as const;

export const LOOP_GATE_KINDS = ["money", "publish", "decision"] as const;
export type LoopGateKind = (typeof LOOP_GATE_KINDS)[number];

export const LOOP_OUTCOMES = ["done", "won", "lost", "killed"] as const;
export type LoopOutcome = (typeof LOOP_OUTCOMES)[number];

export const LOOP_FIELD_TYPES = ["text", "number", "money", "percent", "url", "date"] as const;
export type LoopFieldType = (typeof LOOP_FIELD_TYPES)[number];

export const LOOP_METRIC_OPS = [">=", "<=", ">", "<"] as const;
export type LoopMetricOp = (typeof LOOP_METRIC_OPS)[number];

export const LOOP_EXPERIMENT_STATUSES = ["proposed", "approved", "running", "done", "rejected", "cancelled"] as const;
export type LoopExperimentStatus = (typeof LOOP_EXPERIMENT_STATUSES)[number];

export const LOOP_DECISION_STATUSES = ["pending", "approved", "rejected"] as const;
export type LoopDecisionStatus = (typeof LOOP_DECISION_STATUSES)[number];

export const LOOP_DECISION_SUBJECTS = ["move", "experiment", "question"] as const;
export type LoopDecisionSubject = (typeof LOOP_DECISION_SUBJECTS)[number];

export const LOOP_EVENT_KINDS = ["created", "moved", "updated", "decision", "experiment", "note", "action"] as const;
export type LoopEventKind = (typeof LOOP_EVENT_KINDS)[number];

/** A threshold on a numeric field that must hold before an item leaves a stage. */
export interface LoopMetricRule {
  field: string;
  op: LoopMetricOp;
  value: number;
}

/** The owner approves before an item enters the stage. `amountField` names the field that holds the money. */
export interface LoopGate {
  kind: LoopGateKind;
  note?: string;
  amountField?: string;
}

/** What happens when an item enters a stage. `{item}`, `{stage}` and `{loop}` in a ticket's text are replaced. */
export interface LoopStageActions {
  /** A Motion ticket in the loop's Motion project, assigned to the stage's owner agent. */
  ticket?: { title: string; body?: string };
  /** A note that wakes the stage's owner agent with the item and the exit criteria. */
  notifyOwner?: boolean;
  /** A routine that runs once. */
  routine?: { agentId: string; routineId: string };
}

export interface LoopStage {
  /** Stable within the loop: `a-z 0-9 - _`, at most 40. */
  id: string;
  name: string;
  description?: string;
  ownerAgentId?: string;
  /** A role in words, when no one agent owns the stage, such as "Media buyer". */
  ownerRole?: string;
  /** An end of the loop. An item there is finished, with this outcome. */
  outcome?: LoopOutcome;
  /** The stages an item may go to from here. Absent: the next stage in order, and every end stage. */
  next?: string[];
  checklist?: string[];
  exitMetrics?: LoopMetricRule[];
  gate?: LoopGate;
  /** Days an item may stay before it is late. */
  slaDays?: number;
  onEnter?: LoopStageActions;
}

export interface LoopField {
  /** `a-z 0-9 _`, at most 40. */
  key: string;
  label: string;
  type: LoopFieldType;
  /** Shown on the board card. */
  card?: boolean;
}

export interface LoopDefinition {
  name: string;
  description?: string;
  stages: LoopStage[];
  fields: LoopField[];
  /** The key of the Motion project for the stage tickets, such as `PUO`. Absent: no tickets. */
  motionProject?: string;
}

export interface Loop extends LoopDefinition {
  id: string;
  spaceId: string;
  templateId?: string;
  createdAt: number;
  updatedAt: number;
}

export type LoopValue = string | number;

export interface LoopItem {
  id: string;
  loopId: string;
  title: string;
  stageId: string;
  ownerAgentId?: string;
  values: Record<string, LoopValue>;
  /** The checklist entries that are done, each `<stageId>:<index>`. */
  checks: string[];
  /** A key from outside, such as a Hotmart product id or a mail thread id, so a second save updates. */
  externalId?: string;
  pendingDecisionId?: string;
  enteredAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface LoopEvent {
  id: string;
  loopId: string;
  itemId: string;
  at: number;
  kind: LoopEventKind;
  actorKind: "agent" | "person" | "host";
  actorId?: string;
  from?: string;
  to?: string;
  text?: string;
}

export interface LoopVariant {
  name: string;
  detail?: string;
}

export interface LoopExperiment {
  id: string;
  loopId: string;
  itemId: string;
  title: string;
  hypothesis: string;
  variants: LoopVariant[];
  metric: string;
  budgetUsd: number;
  durationDays: number;
  status: LoopExperimentStatus;
  winner?: string;
  result?: string;
  proposedBy?: string;
  decisionId?: string;
  startedAt?: number;
  endedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A decision that waits for the owner: a gate of a stage, the budget of an experiment, or a question
 * that an agent escalated. This is the standard "decision" attention item of a loop: any inbox can list
 * it by `id`, show `title`, `detail` and `amountUsd`, and answer it with the `decide` action.
 */
export interface LoopDecision {
  id: string;
  spaceId: string;
  loopId: string;
  itemId: string;
  kind: LoopGateKind;
  subject: LoopDecisionSubject;
  title: string;
  detail?: string;
  amountUsd?: number;
  requestedBy?: string;
  toStageId?: string;
  experimentId?: string;
  status: LoopDecisionStatus;
  note?: string;
  createdAt: number;
  decidedAt?: number;
}

export interface LoopTemplateSummary {
  id: string;
  name: string;
  description: string;
  stageNames: string[];
}

/** Every loop of a space with its items, open experiments, decisions and recent history. */
export interface WorkspaceLoops {
  spaceId: string;
  loops: Loop[];
  items: LoopItem[];
  experiments: LoopExperiment[];
  decisions: LoopDecision[];
  events: LoopEvent[];
  templates: LoopTemplateSummary[];
}

export interface WorkspaceLoopsInput {
  spaceId: string;
}

export type WorkspaceLoopAction =
  | { kind: "create-loop"; spaceId: string; templateId?: string; definition?: LoopDefinition }
  | { kind: "update-loop"; loopId: string; definition: LoopDefinition }
  | { kind: "delete-loop"; loopId: string }
  | {
      kind: "save-item";
      loopId: string;
      itemId?: string;
      title?: string;
      stageId?: string;
      ownerAgentId?: string | null;
      values?: Record<string, LoopValue | null>;
    }
  | { kind: "remove-item"; itemId: string }
  | { kind: "check"; itemId: string; check: string; done: boolean }
  | { kind: "move-item"; itemId: string; toStageId: string; note?: string; force?: boolean }
  | { kind: "decide"; decisionId: string; approve: boolean; note?: string }
  | {
      kind: "update-experiment";
      experimentId: string;
      status?: LoopExperimentStatus;
      winner?: string;
      result?: string;
    };

export interface WorkspaceLoopActionResult extends WorkspaceLoops {
  /** The loop or item that a create added, or the decision that a move opened. */
  createdId?: string;
  /** Why a move did not happen: the unmet exit criteria, in words. */
  blocked?: string[];
}

const STAGE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/u;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/u;
const MOTION_PROJECT = /^[A-Za-z0-9_-]{1,40}$/u;

function fail(what: string): never {
  throw new Error(`Invalid loop ${what}.`);
}

function text(value: unknown, maximum: number, what: string): string {
  if (!isBoundedString(value, maximum)) fail(what);
  return value;
}

function nonEmpty(value: unknown, maximum: number, what: string): string {
  const result = text(value, maximum, what).trim();
  if (!result) fail(what);
  return result;
}

function optionalText(value: unknown, maximum: number, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = text(value, maximum, what).trim();
  return result || undefined;
}

function textList(value: unknown, maximum: number, length: number, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum) fail(what);
  return value.map((entry) => nonEmpty(entry, length, what));
}

function count(value: unknown, what: string): number {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) fail(what);
  return value;
}

function optionalCount(value: unknown, what: string): number | undefined {
  return value === undefined ? undefined : count(value, what);
}

function amount(value: unknown, what: string): number {
  if (!isFiniteNumber(value) || value < 0 || value > 1_000_000_000) fail(what);
  return value;
}

function stageId(value: unknown): string {
  if (!isString(value) || !STAGE_ID.test(value)) fail("stage id");
  return value;
}

function id(value: unknown, what: string): string {
  if (!isIdentifier(value)) fail(what);
  return value;
}

function optionalId(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : id(value, what);
}

function record(value: unknown, what: string): DynamicRecord {
  if (!isDynamicRecord(value)) fail(what);
  return value;
}

function oneOf<T extends string>(values: readonly T[], value: unknown, what: string): T {
  if (!isOneOf(values, value)) fail(what);
  return value;
}

/** Drops the keys whose value is undefined, so a decoded value has the shape its sender built. */
function compact<T extends object>(value: T): T {
  for (const [key, entry] of Object.entries(value)) if (entry === undefined) Reflect.deleteProperty(value, key);
  return value;
}

function parseMetric(value: unknown): LoopMetricRule {
  const rule = record(value, "metric");
  if (!isString(rule.field) || !FIELD_KEY.test(rule.field)) fail("metric field");
  if (!isFiniteNumber(rule.value)) fail("metric value");
  return { field: rule.field, op: oneOf(LOOP_METRIC_OPS, rule.op, "metric"), value: rule.value };
}

function parseActions(value: unknown): LoopStageActions | undefined {
  if (value === undefined) return undefined;
  const actions = record(value, "stage actions");
  const ticketRecord = actions.ticket === undefined ? undefined : record(actions.ticket, "ticket");
  const routineRecord = actions.routine === undefined ? undefined : record(actions.routine, "routine");
  if (actions.notifyOwner !== undefined && !isBoolean(actions.notifyOwner)) fail("stage actions");
  return compact({
    ticket: ticketRecord
      ? compact({
          title: nonEmpty(ticketRecord.title, 200, "ticket"),
          body: optionalText(ticketRecord.body, LOOP_LIMITS.text, "ticket"),
        })
      : undefined,
    notifyOwner: actions.notifyOwner === true ? true : undefined,
    routine: routineRecord
      ? { agentId: id(routineRecord.agentId, "routine"), routineId: id(routineRecord.routineId, "routine") }
      : undefined,
  });
}

function parseStage(value: unknown): LoopStage {
  const stage = record(value, "stage");
  const gate = stage.gate === undefined || stage.gate === null ? undefined : record(stage.gate, "gate");
  const amountField = gate?.amountField;
  if (amountField !== undefined && (!isString(amountField) || !FIELD_KEY.test(amountField))) fail("gate");
  const slaDays = stage.slaDays === undefined ? undefined : count(stage.slaDays, "deadline");
  if (slaDays !== undefined && slaDays > 3650) fail("deadline");
  const metrics = stage.exitMetrics;
  if (metrics !== undefined && (!Array.isArray(metrics) || metrics.length > LOOP_LIMITS.metrics)) fail("metrics");
  const next = stage.next;
  if (next !== undefined && (!Array.isArray(next) || next.length > LOOP_LIMITS.next)) fail("next stages");
  return compact({
    id: stageId(stage.id),
    name: nonEmpty(stage.name, LOOP_LIMITS.label, "stage name"),
    description: optionalText(stage.description, LOOP_LIMITS.text, "stage description"),
    ownerAgentId: optionalId(stage.ownerAgentId ?? undefined, "stage owner"),
    ownerRole: optionalText(stage.ownerRole, LOOP_LIMITS.label, "stage role"),
    outcome:
      stage.outcome === undefined || stage.outcome === null
        ? undefined
        : oneOf(LOOP_OUTCOMES, stage.outcome, "outcome"),
    next: next === undefined ? undefined : [...new Set(next.map(stageId))],
    checklist: textList(stage.checklist, LOOP_LIMITS.checklist, 300, "checklist"),
    exitMetrics: metrics === undefined ? undefined : metrics.map(parseMetric),
    gate: gate
      ? compact({
          kind: oneOf(LOOP_GATE_KINDS, gate.kind, "gate"),
          note: optionalText(gate.note, LOOP_LIMITS.text, "gate"),
          amountField: isString(amountField) ? amountField : undefined,
        })
      : undefined,
    slaDays: slaDays === 0 ? undefined : slaDays,
    onEnter: parseActions(stage.onEnter),
  });
}

function parseField(value: unknown): LoopField {
  const field = record(value, "field");
  if (!isString(field.key) || !FIELD_KEY.test(field.key)) fail("field key");
  if (field.card !== undefined && !isBoolean(field.card)) fail("field");
  return compact({
    key: field.key,
    label: nonEmpty(field.label, LOOP_LIMITS.label, "field label"),
    type: oneOf(LOOP_FIELD_TYPES, field.type ?? "text", "field type"),
    card: field.card === true ? true : undefined,
  });
}

/**
 * A loop definition from an untrusted sender. It throws on a value outside the limits, on a stage id or
 * field key used twice, on a `next` that names no stage, and on a loop with no stage that is not an end.
 */
export function parseLoopDefinition(value: unknown): LoopDefinition {
  const definition = record(value, "definition");
  const stages = definition.stages;
  const fields = definition.fields ?? [];
  if (!Array.isArray(stages) || stages.length === 0 || stages.length > LOOP_LIMITS.stages) fail("stages");
  if (!Array.isArray(fields) || fields.length > LOOP_LIMITS.fields) fail("fields");
  const parsedStages = stages.map(parseStage);
  const parsedFields = fields.map(parseField);
  const ids = new Set(parsedStages.map((stage) => stage.id));
  if (ids.size !== parsedStages.length) fail("stage ids");
  if (new Set(parsedFields.map((field) => field.key)).size !== parsedFields.length) fail("field keys");
  for (const stage of parsedStages) if (stage.next?.some((next) => !ids.has(next))) fail("next stages");
  if (parsedStages.every((stage) => stage.outcome)) fail("stages");
  const motionProject = definition.motionProject;
  if (
    motionProject !== undefined &&
    motionProject !== "" &&
    (!isString(motionProject) || !MOTION_PROJECT.test(motionProject))
  )
    fail("Motion project");
  return compact({
    name: nonEmpty(definition.name, LOOP_LIMITS.name, "name"),
    description: optionalText(definition.description, LOOP_LIMITS.description, "description"),
    stages: parsedStages,
    fields: parsedFields,
    motionProject: isString(motionProject) && motionProject ? motionProject : undefined,
  });
}

function parseValue(value: unknown): LoopValue | null {
  if (value === null) return null;
  if (isFiniteNumber(value)) return value;
  return text(value, LOOP_LIMITS.value, "value");
}

/** Field values; a null removes the value. Keys follow the field key pattern. */
export function parseLoopValues(value: unknown): Record<string, LoopValue | null> {
  const values = record(value, "values");
  const entries = Object.entries(values);
  if (entries.length > LOOP_LIMITS.values) fail("values");
  return Object.fromEntries(
    entries.map(([key, entry]) => {
      if (!FIELD_KEY.test(key)) fail("value key");
      return [key, parseValue(entry)];
    }),
  );
}

export function parseWorkspaceLoopsInput(value: unknown): WorkspaceLoopsInput {
  const input = record(value, "request");
  return { spaceId: id(input.spaceId, "space") };
}

/** A loop action from an untrusted sender. It throws on any value outside the limits. */
export function parseWorkspaceLoopAction(value: unknown): WorkspaceLoopAction {
  const action = record(value, "action");
  switch (action.kind) {
    case "create-loop":
      if (action.templateId === undefined && action.definition === undefined) fail("action");
      return compact({
        kind: "create-loop",
        spaceId: id(action.spaceId, "space"),
        templateId: optionalId(action.templateId, "template"),
        definition: action.definition === undefined ? undefined : parseLoopDefinition(action.definition),
      });
    case "update-loop":
      return {
        kind: "update-loop",
        loopId: id(action.loopId, "loop"),
        definition: parseLoopDefinition(action.definition),
      };
    case "delete-loop":
      return { kind: "delete-loop", loopId: id(action.loopId, "loop") };
    case "save-item": {
      const owner = action.ownerAgentId;
      const ownerAgentId = owner === undefined || owner === null ? owner : id(owner, "owner");
      return compact({
        kind: "save-item",
        loopId: id(action.loopId, "loop"),
        itemId: optionalId(action.itemId, "item"),
        title: action.title === undefined ? undefined : nonEmpty(action.title, 200, "title"),
        stageId: action.stageId === undefined ? undefined : stageId(action.stageId),
        ownerAgentId,
        values: action.values === undefined ? undefined : parseLoopValues(action.values),
      });
    }
    case "remove-item":
      return { kind: "remove-item", itemId: id(action.itemId, "item") };
    case "check":
      if (!isBoolean(action.done)) fail("action");
      return {
        kind: "check",
        itemId: id(action.itemId, "item"),
        check: text(action.check, 64, "check"),
        done: action.done,
      };
    case "move-item":
      if (action.force !== undefined && !isBoolean(action.force)) fail("action");
      return compact({
        kind: "move-item",
        itemId: id(action.itemId, "item"),
        toStageId: stageId(action.toStageId),
        note: optionalText(action.note, LOOP_LIMITS.note, "note"),
        force: action.force === true ? true : undefined,
      });
    case "decide":
      if (!isBoolean(action.approve)) fail("action");
      return compact({
        kind: "decide",
        decisionId: id(action.decisionId, "decision"),
        approve: action.approve,
        note: optionalText(action.note, LOOP_LIMITS.note, "note"),
      });
    case "update-experiment":
      return compact({
        kind: "update-experiment",
        experimentId: id(action.experimentId, "experiment"),
        status: action.status === undefined ? undefined : oneOf(LOOP_EXPERIMENT_STATUSES, action.status, "status"),
        winner: optionalText(action.winner, LOOP_LIMITS.label, "winner"),
        result: optionalText(action.result, LOOP_LIMITS.text, "result"),
      });
    default:
      fail("action");
  }
}

function list<T>(value: unknown, maximum: number, decode: (entry: unknown) => T, what: string): T[] {
  if (!Array.isArray(value) || value.length > maximum) fail(what);
  return value.map(decode);
}

function decodeLoop(value: unknown): Loop {
  const loop = record(value, "loop");
  return compact({
    ...parseLoopDefinition(loop),
    id: id(loop.id, "loop"),
    spaceId: id(loop.spaceId, "space"),
    templateId: optionalId(loop.templateId, "template"),
    createdAt: count(loop.createdAt, "time"),
    updatedAt: count(loop.updatedAt, "time"),
  });
}

function decodeItem(value: unknown): LoopItem {
  const item = record(value, "item");
  const values = parseLoopValues(item.values ?? {});
  return compact({
    id: id(item.id, "item"),
    loopId: id(item.loopId, "loop"),
    title: text(item.title, 200, "title"),
    stageId: stageId(item.stageId),
    ownerAgentId: optionalId(item.ownerAgentId, "owner"),
    values: Object.fromEntries(
      Object.entries(values).filter((entry): entry is [string, LoopValue] => entry[1] !== null),
    ),
    checks: list(item.checks ?? [], 400, (entry) => text(entry, 64, "check"), "checks"),
    externalId: optionalText(item.externalId, 200, "external id"),
    pendingDecisionId: optionalId(item.pendingDecisionId, "decision"),
    enteredAt: count(item.enteredAt, "time"),
    createdAt: count(item.createdAt, "time"),
    updatedAt: count(item.updatedAt, "time"),
  });
}

function decodeEvent(value: unknown): LoopEvent {
  const event = record(value, "event");
  return compact({
    id: id(event.id, "event"),
    loopId: id(event.loopId, "loop"),
    itemId: id(event.itemId, "item"),
    at: count(event.at, "time"),
    kind: oneOf(LOOP_EVENT_KINDS, event.kind, "event"),
    actorKind: oneOf(["agent", "person", "host"] as const, event.actorKind, "event"),
    actorId: optionalId(event.actorId, "actor"),
    from: event.from === undefined ? undefined : stageId(event.from),
    to: event.to === undefined ? undefined : stageId(event.to),
    text: optionalText(event.text, LOOP_LIMITS.text, "event"),
  });
}

/** One stored or sent experiment. Throws on a malformed one. */
export function decodeLoopExperiment(value: unknown): LoopExperiment {
  const experiment = record(value, "experiment");
  return compact({
    id: id(experiment.id, "experiment"),
    loopId: id(experiment.loopId, "loop"),
    itemId: id(experiment.itemId, "item"),
    title: text(experiment.title, 200, "experiment"),
    hypothesis: text(experiment.hypothesis, LOOP_LIMITS.text, "experiment"),
    variants: list(
      experiment.variants,
      LOOP_LIMITS.variants,
      (entry) => {
        const variant = record(entry, "variant");
        return compact({
          name: text(variant.name, LOOP_LIMITS.label, "variant"),
          detail: optionalText(variant.detail, LOOP_LIMITS.text, "variant"),
        });
      },
      "variants",
    ),
    metric: text(experiment.metric, LOOP_LIMITS.label, "experiment"),
    budgetUsd: amount(experiment.budgetUsd, "budget"),
    durationDays: count(experiment.durationDays, "duration"),
    status: oneOf(LOOP_EXPERIMENT_STATUSES, experiment.status, "status"),
    winner: optionalText(experiment.winner, LOOP_LIMITS.label, "winner"),
    result: optionalText(experiment.result, LOOP_LIMITS.text, "result"),
    proposedBy: optionalId(experiment.proposedBy, "agent"),
    decisionId: optionalId(experiment.decisionId, "decision"),
    startedAt: optionalCount(experiment.startedAt, "time"),
    endedAt: optionalCount(experiment.endedAt, "time"),
    createdAt: count(experiment.createdAt, "time"),
    updatedAt: count(experiment.updatedAt, "time"),
  });
}

/** One stored or sent decision. Throws on a malformed one. */
export function decodeLoopDecision(value: unknown): LoopDecision {
  const decision = record(value, "decision");
  return compact({
    id: id(decision.id, "decision"),
    spaceId: id(decision.spaceId, "space"),
    loopId: id(decision.loopId, "loop"),
    itemId: id(decision.itemId, "item"),
    kind: oneOf(LOOP_GATE_KINDS, decision.kind, "decision"),
    subject: oneOf(LOOP_DECISION_SUBJECTS, decision.subject, "decision"),
    title: text(decision.title, 300, "decision"),
    detail: optionalText(decision.detail, LOOP_LIMITS.text, "decision"),
    amountUsd: decision.amountUsd === undefined ? undefined : amount(decision.amountUsd, "amount"),
    requestedBy: optionalId(decision.requestedBy, "agent"),
    toStageId: decision.toStageId === undefined ? undefined : stageId(decision.toStageId),
    experimentId: optionalId(decision.experimentId, "experiment"),
    status: oneOf(LOOP_DECISION_STATUSES, decision.status, "decision"),
    note: optionalText(decision.note, LOOP_LIMITS.note, "note"),
    createdAt: count(decision.createdAt, "time"),
    decidedAt: optionalCount(decision.decidedAt, "time"),
  });
}

function decodeTemplate(value: unknown): LoopTemplateSummary {
  const template = record(value, "template");
  return {
    id: id(template.id, "template"),
    name: text(template.name, LOOP_LIMITS.name, "template"),
    description: text(template.description, LOOP_LIMITS.text, "template"),
    stageNames: list(
      template.stageNames,
      LOOP_LIMITS.stages,
      (entry) => text(entry, LOOP_LIMITS.label, "template"),
      "template",
    ),
  };
}

/** The loops of a space from a host. Throws on a malformed answer. */
export function decodeWorkspaceLoops(value: unknown): WorkspaceLoopActionResult {
  const loops = record(value, "answer");
  const blocked = loops.blocked;
  return compact({
    spaceId: id(loops.spaceId, "space"),
    loops: list(loops.loops, LOOP_LIMITS.loopsPerSpace, decodeLoop, "loops"),
    items: list(loops.items, LOOP_LIMITS.items, decodeItem, "items"),
    experiments: list(loops.experiments, LOOP_LIMITS.experiments, decodeLoopExperiment, "experiments"),
    decisions: list(loops.decisions, LOOP_LIMITS.decisions, decodeLoopDecision, "decisions"),
    events: list(loops.events, LOOP_LIMITS.events, decodeEvent, "events"),
    templates: list(loops.templates, LOOP_LIMITS.templates, decodeTemplate, "templates"),
    createdId: optionalId(loops.createdId, "id"),
    blocked: blocked === undefined ? undefined : list(blocked, 40, (entry) => text(entry, 400, "reason"), "reasons"),
  });
}

/** The stages an item may go to from `stage`: its `next` list, or the next stage in order and every end. */
export function loopNextStages(loop: Pick<LoopDefinition, "stages">, stage: LoopStage): LoopStage[] {
  if (stage.next) return loop.stages.filter((candidate) => stage.next?.includes(candidate.id));
  if (stage.outcome) return [];
  const index = loop.stages.findIndex((candidate) => candidate.id === stage.id);
  const following = loop.stages.slice(index + 1).find((candidate) => !candidate.outcome);
  return loop.stages.filter((candidate) => candidate === following || (candidate.outcome && candidate !== stage));
}

/** The check key of one checklist entry of a stage. */
export function loopCheckKey(stageId: string, index: number): string {
  return `${stageId}:${index}`;
}

/** Whether an item stays in its stage longer than the stage's deadline. */
export function loopItemLate(stage: LoopStage | undefined, item: Pick<LoopItem, "enteredAt">, now: number): boolean {
  return stage?.slaDays !== undefined && !stage.outcome && now - item.enteredAt > stage.slaDays * 86_400_000;
}
