/**
 * The portfolio tools of this fork: the test suites of each agent (simulated customers scored by a
 * judge, run again when the agent's settings change), the sampled live score of finished work, space
 * templates ("business in a box") with a validation stage, the value that each agent and space earns
 * next to its cost, the weekly reality check of each space, and the interactive cards that an agent
 * posts in a chat. The host keeps all of it in small files of its own.
 */
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { type LoopDefinition, parseLoopDefinition } from "./ipc-workspace-loops";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

export const PORTFOLIO_LIMITS = {
  scenarios: 20,
  name: 120,
  persona: 1_200,
  input: 2_000,
  rubric: 1_500,
  mustNot: 600,
  /** The customer turns of one scenario. */
  turns: 4,
  /** The runs of each scenario in one suite run, for pass^k. */
  trials: 3,
  /** The suite runs kept per agent, newest first. */
  runs: 20,
  transcript: 1_500,
  note: 600,
  title: 200,
  detail: 1_200,
  options: 12,
  fields: 8,
  columns: 6,
  rows: 20,
  cell: 200,
  label: 80,
  value: 1_000,
  /** A template file as `JSON.stringify` writes it. */
  templateJson: 400_000,
  templateAgents: 20,
  instructions: 12_000,
  skills: 10,
  skillText: 12_000,
  routines: 10,
  playbooks: 10,
  playbookText: 20_000,
  loops: 6,
  channels: 10,
  ratings: 2_000,
  claims: 40,
} as const;

// ---------------------------------------------------------------------------------------------------
// Test suites and simulated customers

/** What a failed suite does to a learning change of the agent: nothing, a warning on the item, or a refusal. */
export const SUITE_GATES = ["off", "warn", "block"] as const;
export type SuiteGate = (typeof SUITE_GATES)[number];

export interface SuiteScenario {
  /** Stable within the suite: `a-z 0-9 - _`, at most 40. */
  id: string;
  name: string;
  /** Who the simulated customer is and how they act, such as "an angry buyer whose cake came late". */
  persona: string;
  /** The customer's first message. */
  input: string;
  /** What a good answer does, which the judge scores against. */
  rubric: string;
  /** What the agent must never do here, such as "promise a refund" or "share a discount code". */
  mustNot?: string;
  /** The customer messages of the conversation, 1 to 4. */
  turns: number;
}

export interface AgentSuite {
  agentId: string;
  scenarios: SuiteScenario[];
  /** Run the suite again after a change of the agent's instructions, model, skills or playbook. */
  autoRun: boolean;
  gate: SuiteGate;
  /** The runs of each scenario; a scenario passes only when every run passes (pass^k). */
  trials: number;
  /** The share of scenarios that must pass, 0 to 1. */
  passMark: number;
  updatedAt: string;
}

export const SUITE_TRIGGERS = ["manual", "settings", "learning"] as const;
export type SuiteTrigger = (typeof SUITE_TRIGGERS)[number];

export interface SuiteTranscriptLine {
  from: "customer" | "agent";
  text: string;
}

export interface ScenarioResult {
  scenarioId: string;
  name: string;
  pass: boolean;
  /** The lowest score of the runs, 0 to 10. */
  score: number;
  /** The runs that passed, of `trials`. */
  passes: number;
  trials: number;
  /** The judge's reasons for the worst run. */
  note: string;
  /** The worst run's conversation. */
  transcript: SuiteTranscriptLine[];
  /** The tools that the agent said it would call, by name. The sandbox runs none. */
  tools: string[];
}

export interface SuiteDiffLine {
  scenarioId: string;
  name: string;
  /** Null: the scenario is new since the run before. */
  before: boolean | null;
  after: boolean;
}

export interface SuiteRun {
  id: string;
  agentId: string;
  at: string;
  trigger: SuiteTrigger;
  /** What changed before the run, such as "instructions, model" or the learning item's title. */
  label: string;
  /** The settings checkpoint that started the run. */
  checkpointId: string | null;
  status: "running" | "done" | "failed";
  /** The share of scenarios that passed, 0 to 1. */
  passRate: number;
  passed: boolean;
  results: ScenarioResult[];
  /** Each scenario whose result is new or changed since the agent's run before. */
  diff: SuiteDiffLine[];
  /** A scenario that passed in the run before fails now. */
  regression: boolean;
  error?: string;
}

export interface AgentSuitePage {
  suite: AgentSuite | null;
  runs: SuiteRun[];
}

export interface SaveSuiteInput {
  agentId: string;
  scenarios: SuiteScenario[];
  autoRun: boolean;
  gate: SuiteGate;
  trials: number;
  passMark: number;
}

// Sampled live scores.

export interface QualitySample {
  turnId: string;
  at: string;
  /** 1 to 10. */
  score: number;
  note: string;
}

export interface QualityPoint {
  date: string;
  average: number;
  count: number;
}

export interface AgentQuality {
  agentId: string;
  /** The average of the last 7 days and of the 7 before, or null without samples. */
  average7: number | null;
  previous7: number | null;
  /** The average fell by 1.5 or more against the week before. */
  dropped: boolean;
  trend: QualityPoint[];
  recent: QualitySample[];
}

export interface QualitySettings {
  enabled: boolean;
  /** The share of finished turns for a person that are scored, 0 to 0.5. */
  sampleRate: number;
}

export interface QualityPage {
  settings: QualitySettings;
  agents: AgentQuality[];
}

// ---------------------------------------------------------------------------------------------------
// Space templates ("business in a box")

export const SPACE_TEMPLATE_FORMAT = "atelier-space-template";
export const SPACE_TEMPLATE_VERSION = 1;

export type TemplateRoutineSchedule =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: number; time: string }
  | { kind: "hourly"; minute: number };

export interface TemplateRoutine {
  name: string;
  instruction: string;
  schedule: TemplateRoutineSchedule;
}

export interface TemplateSkill {
  name: string;
  description: string;
  instructions: string;
}

export interface TemplateAgent {
  /** Stable within the template, such as `lead` or `ads`: `a-z 0-9 - _`, at most 40. */
  key: string;
  name: string;
  title: string;
  instructions: string;
  /** The role playbook that it follows, such as `media-buyer`. */
  role: string | null;
  /** The key of its manager in the template, or null for the lead. */
  reportsTo: string | null;
  /** The first message it gets when the building starts. */
  kickoff: string;
  skills: TemplateSkill[];
  routines: TemplateRoutine[];
}

export interface TemplatePlaybook {
  slug: string;
  roles: string[];
  content: string;
}

/** A loop of the space: one of the host's loop templates by id, or a stage list of its own. */
export interface TemplateLoop {
  templateId?: string;
  definition?: LoopDefinition;
}

export interface TemplateChannel {
  name: string;
  description: string;
  members: string[];
}

export interface SpaceTemplate {
  format: typeof SPACE_TEMPLATE_FORMAT;
  version: typeof SPACE_TEMPLATE_VERSION;
  name: string;
  description: string;
  icon: string | null;
  /** What the business is, in a few sentences: the validation stage scores it. */
  idea: string;
  agents: TemplateAgent[];
  playbooks: TemplatePlaybook[];
  loops: TemplateLoop[];
  channels: TemplateChannel[];
  /** The key of the agent that runs the validation stage; null: the host scores the idea itself. */
  researcher: string | null;
}

export interface SpaceTemplateSummary {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  agents: number;
}

export const VALIDATION_VERDICTS = ["go", "test", "stop"] as const;
export type ValidationVerdict = (typeof VALIDATION_VERDICTS)[number];

export interface TemplateValidation {
  /** 0 to 100. */
  score: number;
  verdict: ValidationVerdict;
  demand: string;
  competition: string;
  risks: string;
  summary: string;
  at: string;
  /** The agent that researched it, or null when the host's small model scored the idea alone. */
  agentId: string | null;
}

export const TEMPLATE_IMPORT_STATES = ["validating", "ready", "building", "stopped"] as const;
export type TemplateImportState = (typeof TEMPLATE_IMPORT_STATES)[number];

export interface TemplateImport {
  id: string;
  templateName: string;
  spaceId: string;
  state: TemplateImportState;
  validation: TemplateValidation | null;
  /** The agents of the template by key. */
  agents: Record<string, string>;
  researcherId: string | null;
  /** What could not be made, such as a skill on a host without a skill library. */
  notes: string[];
  createdAt: string;
}

export interface ImportTemplateInput {
  /** One of the starter templates, or `template`. */
  starterId?: string;
  template?: SpaceTemplate;
  /** The new space's name; the template's name when absent. */
  name?: string;
  /** Skip the validation stage and start building at once. */
  skipValidation?: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Value attribution

export interface ValueRating {
  id: string;
  spaceId: string;
  agentId: string | null;
  title: string;
  /** A Motion key, a loop item or a link. */
  ref: string | null;
  /** 1 to 5. */
  rating: number;
  /** What the owner says it was worth, in US dollars, or null. */
  valueUsd: number | null;
  at: string;
}

export interface RateOutcomeInput {
  spaceId: string;
  agentId?: string;
  title: string;
  ref?: string;
  rating: number;
  valueUsd?: number;
}

export interface ValueAgentRow {
  agentId: string;
  spaceId: string;
  /** The space's revenue shared by the agent's weighted done cards (its cost share when no card is done). */
  revenueUsd: number;
  cardsDone: number;
  /** Done cards weighted by priority: urgent 4, high 3, medium 2, low or none 1. */
  cardPoints: number;
  ratedUsd: number;
  /** The average owner rating, or null. */
  rating: number | null;
  valueUsd: number;
  costUsd: number;
  /** Null when the agent cost nothing. */
  valuePerDollar: number | null;
}

export interface ValueSpaceRow {
  spaceId: string;
  revenueUsd: number;
  adSpendUsd: number;
  cardsDone: number;
  ratedUsd: number;
  valueUsd: number;
  costUsd: number;
  valuePerDollar: number | null;
}

export interface ValueReport {
  days: number;
  spaces: ValueSpaceRow[];
  agents: ValueAgentRow[];
  ratings: ValueRating[];
  /** Currencies that were converted at fixed rates, such as "BRL". */
  converted: string[];
}

// ---------------------------------------------------------------------------------------------------
// Weekly reality check

export const REALITY_CLAIM_KINDS = ["card", "url", "file", "sale"] as const;
export type RealityClaimKind = (typeof REALITY_CLAIM_KINDS)[number];

export interface RealityClaim {
  kind: RealityClaimKind;
  /** What an agent or a card says, cut short. */
  text: string;
  agentId: string | null;
  /** `found`: the evidence is there. `missing`: it is not. `unknown`: it could not be checked. */
  evidence: "found" | "missing" | "unknown";
  detail: string;
}

export interface RealityReport {
  id: string;
  spaceId: string;
  at: string;
  summary: string;
  claims: RealityClaim[];
  flagged: number;
  /** The channel that got the report, or null. */
  channelId: string | null;
}

export interface RealitySettings {
  enabled: boolean;
  /** 0 is Sunday. */
  weekday: number;
  /** The local hour, 0 to 23. */
  hour: number;
}

export interface RealityPage {
  settings: RealitySettings;
  reports: RealityReport[];
}

// ---------------------------------------------------------------------------------------------------
// Interactive cards in a chat

export const CHAT_CARD_TYPES = ["choice", "approve", "form", "table"] as const;
export type ChatCardType = (typeof CHAT_CARD_TYPES)[number];

export interface ChatCardOption {
  id: string;
  label: string;
  detail?: string;
}

export interface ChatCardField {
  id: string;
  label: string;
  kind: "text" | "number" | "select";
  options?: string[];
  required?: boolean;
}

export interface ChatCardRow {
  id: string;
  cells: string[];
}

export const CHAT_TABLE_MODES = ["approve-each", "pick-one", "pick-many"] as const;
export type ChatTableMode = (typeof CHAT_TABLE_MODES)[number];

export type ChatCardSpec =
  | { type: "choice"; title: string; detail?: string; options: ChatCardOption[]; multiple?: boolean }
  | { type: "approve"; title: string; detail?: string; approveLabel?: string; rejectLabel?: string }
  | { type: "form"; title: string; detail?: string; fields: ChatCardField[]; submitLabel?: string }
  | {
      type: "table";
      title: string;
      detail?: string;
      columns: string[];
      rows: ChatCardRow[];
      mode: ChatTableMode;
    };

export interface ChatCardAnswer {
  /** `choice`, `pick-one` and `pick-many`: the chosen option or row ids. */
  selected?: string[];
  /** `approve`. */
  approved?: boolean;
  /** `form`: the value of each field. */
  values?: Record<string, string>;
  /** `approve-each`: the decision on each row. */
  rows?: Record<string, "approve" | "reject">;
  /** A few words beside the taps. */
  note?: string;
}

export interface ChatCard {
  id: string;
  agentId: string;
  channelId: string | null;
  spec: ChatCardSpec;
  status: "open" | "answered" | "closed";
  answer?: ChatCardAnswer;
  answeredBy?: { id: string; name: string };
  answeredAt?: string;
  createdAt: string;
}

/** The line that a chat message carries for its card; a client that knows it draws the card instead. */
export const CHAT_CARD_MARKER = /\[card:([0-9a-f-]{36})\]/u;

export function chatCardMarker(cardId: string): string {
  return `[card:${cardId}]`;
}

// ---------------------------------------------------------------------------------------------------
// Parsers of requests. Each throws on a value that does not fit.

function fail(what: string): never {
  throw new Error(`Invalid ${what}.`);
}

function text(value: unknown, max: number, what: string, allowEmpty = false): string {
  if (!isString(value) || value.length > max || (!allowEmpty && value.trim() === "")) fail(what);
  return value.trim();
}

function optionalText(value: unknown, max: number, what: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, max, what);
}

function key(value: unknown, what: string): string {
  if (!isString(value) || !/^[a-z0-9][a-z0-9_-]{0,39}$/u.test(value)) fail(what);
  return value;
}

function integer(value: unknown, min: number, max: number, what: string): number {
  if (!isNumber(value) || !Number.isInteger(value) || value < min || value > max) fail(what);
  return value;
}

function decimal(value: unknown, min: number, max: number, what: string): number {
  if (!isNumber(value) || !Number.isFinite(value) || value < min || value > max) fail(what);
  return value;
}

function array(value: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(what);
  return value;
}

function unique(ids: readonly string[], what: string): void {
  if (new Set(ids).size !== ids.length) fail(what);
}

export function parseSuiteScenario(value: unknown): SuiteScenario {
  if (!isDynamicRecord(value)) fail("scenario");
  const mustNot = optionalText(value.mustNot, PORTFOLIO_LIMITS.mustNot, "scenario");
  return {
    id: key(value.id, "scenario id"),
    name: text(value.name, PORTFOLIO_LIMITS.name, "scenario name"),
    persona: text(value.persona, PORTFOLIO_LIMITS.persona, "scenario persona"),
    input: text(value.input, PORTFOLIO_LIMITS.input, "scenario input"),
    rubric: text(value.rubric, PORTFOLIO_LIMITS.rubric, "scenario rubric"),
    ...(mustNot ? { mustNot } : {}),
    turns: integer(value.turns ?? 1, 1, PORTFOLIO_LIMITS.turns, "scenario turns"),
  };
}

export function parseSaveSuiteInput(value: unknown): SaveSuiteInput {
  if (!isDynamicRecord(value) || !isIdentifier(value.agentId)) fail("suite");
  const scenarios = array(value.scenarios, PORTFOLIO_LIMITS.scenarios, "suite").map(parseSuiteScenario);
  unique(
    scenarios.map((scenario) => scenario.id),
    "suite",
  );
  return {
    agentId: value.agentId,
    scenarios,
    autoRun: value.autoRun === undefined ? true : value.autoRun === true,
    gate: value.gate === undefined ? "warn" : isOneOf(SUITE_GATES, value.gate) ? value.gate : fail("suite gate"),
    trials: integer(value.trials ?? 1, 1, PORTFOLIO_LIMITS.trials, "suite trials"),
    passMark: decimal(value.passMark ?? 0.8, 0, 1, "suite pass mark"),
  };
}

export function parsePortfolioAgentInput(value: unknown): { agentId: string } {
  if (!isDynamicRecord(value) || !isIdentifier(value.agentId)) fail("agent");
  return { agentId: value.agentId };
}

export function parsePortfolioSpaceInput(value: unknown): { spaceId?: string } {
  if (!isDynamicRecord(value)) fail("space");
  if (value.spaceId === undefined) return {};
  if (!isIdentifier(value.spaceId)) fail("space");
  return { spaceId: value.spaceId };
}

export function parseQualityInput(value: unknown): { settings?: Partial<QualitySettings> } {
  if (!isDynamicRecord(value)) fail("quality");
  if (value.settings === undefined) return {};
  if (!isDynamicRecord(value.settings)) fail("quality");
  const settings: Partial<QualitySettings> = {};
  if (value.settings.enabled !== undefined) {
    if (!isBoolean(value.settings.enabled)) fail("quality");
    settings.enabled = value.settings.enabled;
  }
  if (value.settings.sampleRate !== undefined)
    settings.sampleRate = decimal(value.settings.sampleRate, 0, 0.5, "sample rate");
  return { settings };
}

export function parseRealityInput(value: unknown): { spaceId?: string; settings?: Partial<RealitySettings> } {
  if (!isDynamicRecord(value)) fail("reality check");
  const result: { spaceId?: string; settings?: Partial<RealitySettings> } = {};
  if (value.spaceId !== undefined) {
    if (!isIdentifier(value.spaceId)) fail("reality check");
    result.spaceId = value.spaceId;
  }
  if (value.settings !== undefined) {
    if (!isDynamicRecord(value.settings)) fail("reality check");
    const settings: Partial<RealitySettings> = {};
    if (value.settings.enabled !== undefined) {
      if (!isBoolean(value.settings.enabled)) fail("reality check");
      settings.enabled = value.settings.enabled;
    }
    if (value.settings.weekday !== undefined) settings.weekday = integer(value.settings.weekday, 0, 6, "weekday");
    if (value.settings.hour !== undefined) settings.hour = integer(value.settings.hour, 0, 23, "hour");
    result.settings = settings;
  }
  return result;
}

export function parseRateOutcomeInput(value: unknown): RateOutcomeInput {
  if (!isDynamicRecord(value) || !isIdentifier(value.spaceId)) fail("rating");
  if (value.agentId !== undefined && !isIdentifier(value.agentId)) fail("rating");
  const ref = optionalText(value.ref, PORTFOLIO_LIMITS.title, "rating");
  return {
    spaceId: value.spaceId,
    ...(isString(value.agentId) ? { agentId: value.agentId } : {}),
    title: text(value.title, PORTFOLIO_LIMITS.title, "rating"),
    ...(ref ? { ref } : {}),
    rating: integer(value.rating, 1, 5, "rating"),
    ...(value.valueUsd === undefined || value.valueUsd === null
      ? {}
      : { valueUsd: decimal(value.valueUsd, 0, 10_000_000, "rating value") }),
  };
}

function parseRoutineSchedule(value: unknown): TemplateRoutineSchedule {
  if (!isDynamicRecord(value)) fail("routine schedule");
  const time = () => {
    if (!isString(value.time) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.time)) fail("routine time");
    return value.time;
  };
  switch (value.kind) {
    case "daily":
      return { kind: "daily", time: time() };
    case "weekdays":
      return { kind: "weekdays", time: time() };
    case "weekly":
      return { kind: "weekly", weekday: integer(value.weekday, 0, 6, "routine weekday"), time: time() };
    case "hourly":
      return { kind: "hourly", minute: integer(value.minute, 0, 59, "routine minute") };
    default:
      return fail("routine schedule");
  }
}

function parseTemplateAgent(value: unknown): TemplateAgent {
  if (!isDynamicRecord(value)) fail("template agent");
  return {
    key: key(value.key, "template agent key"),
    name: text(value.name, 60, "template agent name"),
    title: text(value.title ?? "", 120, "template agent title", true),
    instructions: text(value.instructions ?? "", PORTFOLIO_LIMITS.instructions, "template agent instructions", true),
    role: value.role === null || value.role === undefined ? null : key(value.role, "template agent role"),
    reportsTo:
      value.reportsTo === null || value.reportsTo === undefined ? null : key(value.reportsTo, "template agent manager"),
    kickoff: text(value.kickoff ?? "", PORTFOLIO_LIMITS.input, "template agent kickoff", true),
    skills: array(value.skills ?? [], PORTFOLIO_LIMITS.skills, "template skills").map((skill) => {
      if (!isDynamicRecord(skill)) fail("template skill");
      return {
        name: text(skill.name, 64, "template skill name"),
        description: text(skill.description ?? "", 400, "template skill", true),
        instructions: text(skill.instructions, PORTFOLIO_LIMITS.skillText, "template skill"),
      };
    }),
    routines: array(value.routines ?? [], PORTFOLIO_LIMITS.routines, "template routines").map((routine) => {
      if (!isDynamicRecord(routine)) fail("template routine");
      return {
        name: text(routine.name, 80, "template routine name"),
        instruction: text(routine.instruction, PORTFOLIO_LIMITS.input, "template routine"),
        schedule: parseRoutineSchedule(routine.schedule),
      };
    }),
  };
}

/** A template file from outside: every bound is checked, and the keys that agents name must exist. */
export function parseSpaceTemplate(value: unknown): SpaceTemplate {
  if (!isDynamicRecord(value) || value.format !== SPACE_TEMPLATE_FORMAT || value.version !== SPACE_TEMPLATE_VERSION)
    fail("template");
  let size = Number.POSITIVE_INFINITY;
  try {
    size = JSON.stringify(value).length;
  } catch {
    fail("template");
  }
  if (size > PORTFOLIO_LIMITS.templateJson) fail("template");
  const agents = array(value.agents, PORTFOLIO_LIMITS.templateAgents, "template agents").map(parseTemplateAgent);
  if (agents.length === 0) fail("template agents");
  const keys = agents.map((agent) => agent.key);
  unique(keys, "template agents");
  for (const agent of agents)
    if (agent.reportsTo !== null && (!keys.includes(agent.reportsTo) || agent.reportsTo === agent.key))
      fail("template agent manager");
  const researcher =
    value.researcher === null || value.researcher === undefined ? null : key(value.researcher, "template researcher");
  if (researcher !== null && !keys.includes(researcher)) fail("template researcher");
  return {
    format: SPACE_TEMPLATE_FORMAT,
    version: SPACE_TEMPLATE_VERSION,
    name: text(value.name, 60, "template name"),
    description: text(value.description ?? "", 600, "template description", true),
    icon: value.icon === null || value.icon === undefined ? null : text(value.icon, 32, "template icon"),
    idea: text(value.idea ?? "", PORTFOLIO_LIMITS.input, "template idea", true),
    agents,
    playbooks: array(value.playbooks ?? [], PORTFOLIO_LIMITS.playbooks, "template playbooks").map((playbook) => {
      if (!isDynamicRecord(playbook)) fail("template playbook");
      return {
        slug: key(playbook.slug, "template playbook"),
        roles: array(playbook.roles ?? [], 10, "template playbook").map((role) => key(role, "template playbook role")),
        content: text(playbook.content, PORTFOLIO_LIMITS.playbookText, "template playbook"),
      };
    }),
    loops: array(value.loops ?? [], PORTFOLIO_LIMITS.loops, "template loops").map((loop) => {
      if (!isDynamicRecord(loop)) fail("template loop");
      if (isString(loop.templateId)) return { templateId: key(loop.templateId, "template loop") };
      try {
        return { definition: parseLoopDefinition(loop.definition) };
      } catch {
        return fail("template loop");
      }
    }),
    channels: array(value.channels ?? [], PORTFOLIO_LIMITS.channels, "template channels").map((channel) => {
      if (!isDynamicRecord(channel)) fail("template channel");
      const members = array(channel.members ?? [], PORTFOLIO_LIMITS.templateAgents, "template channel").map((member) =>
        key(member, "template channel member"),
      );
      if (members.some((member) => !keys.includes(member))) fail("template channel member");
      return {
        name: text(channel.name, 60, "template channel name"),
        description: text(channel.description ?? "", 400, "template channel", true),
        members,
      };
    }),
    researcher,
  };
}

export function parseImportTemplateInput(value: unknown): ImportTemplateInput {
  if (!isDynamicRecord(value)) fail("import");
  const result: ImportTemplateInput = {};
  if (value.starterId !== undefined) result.starterId = key(value.starterId, "starter template");
  if (value.template !== undefined) result.template = parseSpaceTemplate(value.template);
  if (!result.starterId === !result.template) fail("import");
  const name = optionalText(value.name, 60, "space name");
  if (name) result.name = name;
  if (value.skipValidation !== undefined) {
    if (!isBoolean(value.skipValidation)) fail("import");
    result.skipValidation = value.skipValidation;
  }
  return result;
}

export function parseTemplateImportDecision(value: unknown): { importId: string; decision: "build" | "stop" } {
  if (!isDynamicRecord(value) || !isIdentifier(value.importId) || !isOneOf(["build", "stop"] as const, value.decision))
    fail("import decision");
  return { importId: value.importId, decision: value.decision };
}

function optionId(value: unknown, what: string): string {
  if (!isString(value) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(value)) fail(what);
  return value;
}

/** A card that an agent posts. The ids of its options, fields and rows are unique. */
export function parseChatCardSpec(value: unknown): ChatCardSpec {
  if (!isDynamicRecord(value) || !isOneOf(CHAT_CARD_TYPES, value.type)) fail("card");
  const title = text(value.title, PORTFOLIO_LIMITS.title, "card title");
  const detail = optionalText(value.detail, PORTFOLIO_LIMITS.detail, "card detail");
  const base = { title, ...(detail ? { detail } : {}) };
  const label = (entry: unknown) => text(entry, PORTFOLIO_LIMITS.label, "card label");
  switch (value.type) {
    case "choice": {
      const options = array(value.options, PORTFOLIO_LIMITS.options, "card options").map((option) => {
        if (!isDynamicRecord(option)) fail("card option");
        const note = optionalText(option.detail, PORTFOLIO_LIMITS.cell, "card option");
        return {
          id: optionId(option.id, "card option"),
          label: label(option.label),
          ...(note ? { detail: note } : {}),
        };
      });
      if (options.length < 2) fail("card options");
      unique(
        options.map((option) => option.id),
        "card options",
      );
      return { type: "choice", ...base, options, ...(value.multiple === true ? { multiple: true } : {}) };
    }
    case "approve": {
      const approveLabel = optionalText(value.approveLabel, PORTFOLIO_LIMITS.label, "card");
      const rejectLabel = optionalText(value.rejectLabel, PORTFOLIO_LIMITS.label, "card");
      return {
        type: "approve",
        ...base,
        ...(approveLabel ? { approveLabel } : {}),
        ...(rejectLabel ? { rejectLabel } : {}),
      };
    }
    case "form": {
      const fields = array(value.fields, PORTFOLIO_LIMITS.fields, "card fields").map((field): ChatCardField => {
        if (!isDynamicRecord(field) || !isOneOf(["text", "number", "select"] as const, field.kind)) fail("card field");
        const options =
          field.kind === "select"
            ? array(field.options, PORTFOLIO_LIMITS.options, "card field").map((option) => label(option))
            : undefined;
        if (options && options.length === 0) fail("card field");
        return {
          id: optionId(field.id, "card field"),
          label: label(field.label),
          kind: field.kind,
          ...(options ? { options } : {}),
          ...(field.required === true ? { required: true } : {}),
        };
      });
      if (fields.length === 0) fail("card fields");
      unique(
        fields.map((field) => field.id),
        "card fields",
      );
      const submitLabel = optionalText(value.submitLabel, PORTFOLIO_LIMITS.label, "card");
      return { type: "form", ...base, fields, ...(submitLabel ? { submitLabel } : {}) };
    }
    default: {
      const columns = array(value.columns, PORTFOLIO_LIMITS.columns, "card columns").map((column) => label(column));
      if (columns.length === 0) fail("card columns");
      const rows = array(value.rows, PORTFOLIO_LIMITS.rows, "card rows").map((row) => {
        if (!isDynamicRecord(row)) fail("card row");
        const cells = array(row.cells, PORTFOLIO_LIMITS.columns, "card row").map((cell) =>
          text(isNumber(cell) ? String(cell) : cell, PORTFOLIO_LIMITS.cell, "card cell", true),
        );
        if (cells.length !== columns.length) fail("card row");
        return { id: optionId(row.id, "card row"), cells };
      });
      if (rows.length === 0) fail("card rows");
      unique(
        rows.map((row) => row.id),
        "card rows",
      );
      const mode = value.mode === undefined ? "approve-each" : value.mode;
      if (!isOneOf(CHAT_TABLE_MODES, mode)) fail("card mode");
      return { type: "table", ...base, columns, rows, mode };
    }
  }
}

/** Checks an answer against its card: every id is the card's, and a required field has a value. */
export function parseChatCardAnswer(spec: ChatCardSpec, value: unknown): ChatCardAnswer {
  if (!isDynamicRecord(value)) fail("card answer");
  const note = optionalText(value.note, PORTFOLIO_LIMITS.note, "card answer");
  const withNote = (answer: ChatCardAnswer): ChatCardAnswer => (note ? { ...answer, note } : answer);
  const selected = (ids: readonly string[], multiple: boolean) => {
    const chosen = array(value.selected, ids.length, "card answer").map((id) => optionId(id, "card answer"));
    unique(chosen, "card answer");
    if (chosen.some((id) => !ids.includes(id)) || chosen.length === 0 || (!multiple && chosen.length > 1))
      fail("card answer");
    return chosen;
  };
  switch (spec.type) {
    case "choice":
      return withNote({
        selected: selected(
          spec.options.map((option) => option.id),
          spec.multiple === true,
        ),
      });
    case "approve":
      if (!isBoolean(value.approved)) fail("card answer");
      return withNote({ approved: value.approved });
    case "form": {
      if (!isDynamicRecord(value.values)) fail("card answer");
      const values: Record<string, string> = {};
      for (const field of spec.fields) {
        const given = value.values[field.id];
        const entry = given === undefined || given === null ? "" : text(given, PORTFOLIO_LIMITS.value, "card", true);
        if (field.required && !entry) fail("card answer");
        if (entry && field.kind === "number" && !Number.isFinite(Number(entry.replace(",", ".")))) fail("card answer");
        if (entry && field.kind === "select" && !field.options?.includes(entry)) fail("card answer");
        if (entry) values[field.id] = entry;
      }
      if (Object.keys(value.values).some((id) => !spec.fields.some((field) => field.id === id))) fail("card answer");
      return withNote({ values });
    }
    case "table": {
      const ids = spec.rows.map((row) => row.id);
      if (spec.mode !== "approve-each") return withNote({ selected: selected(ids, spec.mode === "pick-many") });
      if (!isDynamicRecord(value.rows)) fail("card answer");
      const rows: Record<string, "approve" | "reject"> = {};
      for (const id of ids) {
        const decision = value.rows[id];
        if (decision !== "approve" && decision !== "reject") fail("card answer");
        rows[id] = decision;
      }
      if (Object.keys(value.rows).length !== ids.length) fail("card answer");
      return withNote({ rows });
    }
  }
}

/** The answer in words, as the agent gets it and the frozen card shows it. */
export function chatCardAnswerText(spec: ChatCardSpec, answer: ChatCardAnswer): string {
  const note = answer.note ? ` Note: ${answer.note}` : "";
  switch (spec.type) {
    case "choice":
      return `${(answer.selected ?? []).map((id) => spec.options.find((option) => option.id === id)?.label ?? id).join(", ")}.${note}`;
    case "approve":
      return `${answer.approved ? "Approved" : "Rejected"}.${note}`;
    case "form":
      return `${spec.fields
        .filter((field) => answer.values?.[field.id])
        .map((field) => `${field.label}: ${answer.values?.[field.id]}`)
        .join("; ")}.${note}`;
    case "table": {
      const name = (id: string) => spec.rows.find((row) => row.id === id)?.cells[0] ?? id;
      if (answer.rows) {
        const approved = Object.entries(answer.rows).filter(([, decision]) => decision === "approve");
        const rejected = Object.entries(answer.rows).filter(([, decision]) => decision === "reject");
        return `Approved: ${approved.map(([id]) => `${name(id)} (${id})`).join(", ") || "none"}. Rejected: ${
          rejected.map(([id]) => `${name(id)} (${id})`).join(", ") || "none"
        }.${note}`;
      }
      return `${(answer.selected ?? []).map((id) => `${name(id)} (${id})`).join(", ")}.${note}`;
    }
  }
}

export function parseChatCardIds(value: unknown): { cardIds: string[] } {
  if (!isDynamicRecord(value)) fail("cards");
  const cardIds = array(value.cardIds, 50, "cards").map((id) =>
    isBoundedString(id, 36) && /^[0-9a-f-]{36}$/u.test(id) ? id : fail("cards"),
  );
  return { cardIds };
}

export function parseAnswerChatCardInput(value: unknown): { cardId: string; answer: unknown } {
  if (!isDynamicRecord(value) || !isString(value.cardId) || !/^[0-9a-f-]{36}$/u.test(value.cardId)) fail("card");
  if (!isDynamicRecord(value.answer)) fail("card answer");
  return { cardId: value.cardId, answer: value.answer };
}
