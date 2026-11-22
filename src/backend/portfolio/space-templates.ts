import { randomUUID } from "node:crypto";
import { type LoopDefinition, parseLoopDefinition } from "@openbot/contracts/ipc";
import {
  type ImportTemplateInput,
  parseSpaceTemplate,
  SPACE_TEMPLATE_FORMAT,
  SPACE_TEMPLATE_VERSION,
  type SpaceTemplate,
  type SpaceTemplateSummary,
  TEMPLATE_IMPORT_STATES,
  type TemplateAgent,
  type TemplateImport,
  type TemplateLoop,
  type TemplateRoutineSchedule,
  type TemplateValidation,
  type ValidationVerdict,
} from "@openbot/contracts/portfolio";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema } from "effect";
import { JsonStore } from "../agent-efficiency/json-store";
import { extractJsonObject } from "../structured-output";
import { ValidationAnswer, validationBrief, validationPrompt } from "./portfolio-prompts";
import { STARTER_TEMPLATES } from "./starter-templates";

const logger = createOpenBotLogger("portfolio-templates");

export const SPACE_TEMPLATES_FILE = "portfolio-templates-v1.json";
const IMPORTS_KEPT = 50;
/** A validation that the research agent has not reported after this ends with the host's own score. */
const VALIDATION_WAIT_MS = 6 * 60 * 60_000;

/** A refusal that the route answers as 409 with its text. */
export class TemplateRefused extends Error {}

/** What a template keeps of an agent, read from the host. */
export interface ExportAgent {
  id: string;
  name: string;
  title: string;
  instructions: string;
  role: string | null;
  managerId: string | null;
}

export interface SpaceTemplatesHooks {
  path: string;
  space(spaceId: string): { id: string; name: string; icon: string | null } | null;
  agentsOf(spaceId: string): readonly ExportAgent[];
  /** The local skills of an agent with their text. A skill of the marketplace is left out. */
  skillsOf(agentId: string): Effect.Effect<readonly { name: string; description: string; instructions: string }[]>;
  routinesOf(agentId: string): readonly { name: string; instruction: string; schedule: unknown }[];
  playbooks(): Effect.Effect<readonly { slug: string; roles: readonly string[]; content: string }[]>;
  loopsOf(spaceId: string): readonly { templateId?: string | undefined; definition: unknown }[];
  channelsOf(spaceId: string): readonly { name: string; description: string; agentIds: readonly string[] }[];
  redact(text: string): string;
  // The import.
  createSpace(name: string, icon: string | null): Effect.Effect<string, unknown>;
  /** Makes an agent in the space without a first message: it starts no turn. */
  createAgent(spaceId: string, agent: TemplateAgent): Effect.Effect<string, unknown>;
  setManager(agentId: string, managerId: string): Effect.Effect<void, unknown>;
  /** False when this host has no skill library. */
  addSkill(
    agentId: string,
    skill: { name: string; description: string; instructions: string },
  ): Effect.Effect<boolean, unknown>;
  /** Makes the routine paused; the building turns it on. */
  createRoutine(
    agentId: string,
    routine: { name: string; instruction: string; schedule: TemplateRoutineSchedule },
  ): string;
  activateRoutine(agentId: string, routineId: string): void;
  /** Saves a playbook whose slug the host does not have yet. False when it has one. */
  savePlaybook(playbook: { slug: string; roles: readonly string[]; content: string }): Effect.Effect<boolean, unknown>;
  createLoop(spaceId: string, loop: TemplateLoop): Effect.Effect<void, unknown>;
  createChannel(
    spaceId: string,
    channel: { name: string; description: string; agentIds: readonly string[] },
  ): Effect.Effect<void, unknown>;
  /** A message to an agent that starts its turn. */
  send(agentId: string, text: string): Effect.Effect<void, unknown>;
  generate(prompt: string): Effect.Effect<string | null>;
  /** Tells the owner, such as that a validation ended. */
  notify(spaceId: string, text: string): void;
}

interface StoredTemplates {
  version: 1;
  imports: TemplateImport[];
  /** The routines that the building turns on, per import. */
  routines: Record<string, { agentId: string; routineId: string }[]>;
  /** The template of each import that waits, for the kickoffs and the host's own score. */
  templates: Record<string, SpaceTemplate>;
}

const EMPTY: StoredTemplates = { version: 1, imports: [], routines: {}, templates: {} };

function isImport(value: unknown): value is TemplateImport {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.spaceId) &&
    isString(value.templateName) &&
    isOneOf(TEMPLATE_IMPORT_STATES, value.state) &&
    isDynamicRecord(value.agents) &&
    Array.isArray(value.notes) &&
    isString(value.createdAt)
  );
}

function decodeStored(value: unknown): StoredTemplates | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  const routines: StoredTemplates["routines"] = {};
  if (isDynamicRecord(value.routines))
    for (const [importId, list] of Object.entries(value.routines))
      if (Array.isArray(list))
        routines[importId] = list.filter(
          (entry): entry is { agentId: string; routineId: string } =>
            isDynamicRecord(entry) && isString(entry.agentId) && isString(entry.routineId),
        );
  const templates: StoredTemplates["templates"] = {};
  if (isDynamicRecord(value.templates))
    for (const [importId, template] of Object.entries(value.templates))
      try {
        templates[importId] = parseSpaceTemplate(template);
      } catch {
        // A template that this build cannot read starts its agents with the general kickoff.
      }
  return {
    version: 1,
    imports: Array.isArray(value.imports) ? value.imports.filter(isImport) : [],
    routines,
    templates,
  };
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const PHONE = /(?<![\w/])\+?\d[\d ().-]{7,}\d(?![\w/])/gu;
const LONG_NUMBER = /\b\d{12,19}\b/gu;
const KEY_LIKE = /\b(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b/gu;
const QUERY = /(https?:\/\/[^\s?#]+)\?[^\s#]+/giu;

/** A text of the template with keys, emails, phone numbers, card-like numbers and link queries taken out. */
export function scrub(text: string, redact: (text: string) => string): string {
  return redact(text)
    .replace(KEY_LIKE, "[key]")
    .replace(EMAIL, "[email]")
    .replace(LONG_NUMBER, "[number]")
    .replace(PHONE, "[phone]")
    .replace(QUERY, "$1");
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function slugKey(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 30) || "agent";
  let key = /^[a-z0-9]/u.test(base) ? base : `a${base}`;
  for (let index = 2; taken.has(key); index += 1) key = `${base.slice(0, 30)}-${index}`;
  taken.add(key);
  return key;
}

function templateSchedule(value: unknown): TemplateRoutineSchedule | null {
  if (!isDynamicRecord(value)) return null;
  const time = isString(value.time) && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.time) ? value.time : null;
  if ((value.kind === "daily" || value.kind === "weekdays") && time) return { kind: value.kind, time };
  if (value.kind === "weekly" && time && typeof value.weekday === "number")
    return { kind: "weekly", weekday: value.weekday, time };
  if (value.kind === "hourly" && typeof value.minute === "number") return { kind: "hourly", minute: value.minute };
  return null;
}

/**
 * Space templates ("business in a box"). An export keeps what makes a business run: its agents with
 * their roles, instructions, local skills and schedules, the playbooks of their roles, its loops and
 * its channels. It never keeps memories, chats, files, keys, customer facts or money rows, and every
 * text goes through the host's secret redaction and a scrub of emails, phone numbers and link queries.
 *
 * An import makes a new space with every agent asleep in the sense that matters: no agent has a first
 * message and every routine is paused. The validation stage runs first: the template's research agent
 * gets a brief and reports a score with `report_validation` (or the small model scores the idea when
 * the template names none). The owner then starts the building, which sends each agent its kickoff and
 * turns the routines on, or stops it.
 */
export class SpaceTemplates {
  readonly #hooks: SpaceTemplatesHooks;
  readonly #store: JsonStore<StoredTemplates>;
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(hooks: SpaceTemplatesHooks) {
    this.#hooks = hooks;
    this.#store = new JsonStore(hooks.path, EMPTY, decodeStored);
  }

  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  starters(): SpaceTemplateSummary[] {
    return STARTER_TEMPLATES.map(({ id, template }) => ({
      id,
      name: template.name,
      description: template.description,
      icon: template.icon,
      agents: template.agents.length,
    }));
  }

  readonly imports = Effect.fn("SpaceTemplates.imports")(function* (this: SpaceTemplates) {
    const stored = yield* this.#store.load();
    // A wait that a restart cut short ends at the next read.
    for (const entry of stored.imports)
      if (entry.state === "validating" && Date.now() - Date.parse(entry.createdAt) > VALIDATION_WAIT_MS)
        yield* this.#late(entry.id);
    return this.#store.current.imports;
  });

  readonly export = Effect.fn("SpaceTemplates.export")(function* (this: SpaceTemplates, spaceId: string) {
    const hooks = this.#hooks;
    const space = hooks.space(spaceId);
    if (!space) return yield* Effect.fail(new TemplateRefused("The space does not exist."));
    const clean = (text: string, max: number) => cut(scrub(text, hooks.redact), max);
    const members = hooks.agentsOf(spaceId).slice(0, 20);
    if (members.length === 0) return yield* Effect.fail(new TemplateRefused("The space has no agents to export."));
    const taken = new Set<string>();
    const keys = new Map(members.map((agent) => [agent.id, slugKey(agent.name, taken)]));
    const agents: TemplateAgent[] = [];
    for (const agent of members) {
      const skills = yield* hooks.skillsOf(agent.id);
      agents.push({
        key: keys.get(agent.id) ?? "agent",
        name: cut(agent.name, 60),
        title: clean(agent.title, 120),
        instructions: clean(agent.instructions, 12_000),
        role: agent.role && /^[a-z0-9][a-z0-9_-]{0,39}$/u.test(agent.role) ? agent.role : null,
        reportsTo: agent.managerId ? (keys.get(agent.managerId) ?? null) : null,
        kickoff: "",
        skills: skills.slice(0, 10).map((skill) => ({
          name: cut(skill.name, 64),
          description: clean(skill.description, 400),
          instructions: clean(skill.instructions, 12_000),
        })),
        routines: hooks
          .routinesOf(agent.id)
          .flatMap((routine) => {
            const schedule = templateSchedule(routine.schedule);
            return schedule
              ? [{ name: cut(routine.name, 80), instruction: clean(routine.instruction, 2_000), schedule }]
              : [];
          })
          .slice(0, 10),
      });
    }
    const roles = new Set(agents.flatMap((agent) => (agent.role ? [agent.role] : [])));
    const playbooks = (yield* hooks.playbooks())
      .filter((playbook) => playbook.roles.some((role) => roles.has(role)))
      .slice(0, 10)
      .map((playbook) => ({
        slug: playbook.slug,
        roles: playbook.roles.filter((role) => /^[a-z0-9][a-z0-9_-]{0,39}$/u.test(role)).slice(0, 10),
        content: clean(playbook.content, 20_000),
      }));
    const loops: TemplateLoop[] = hooks
      .loopsOf(spaceId)
      .slice(0, 6)
      .flatMap((loop) => {
        const definition = withoutOwners(loop.definition, hooks.redact);
        return definition ? [{ definition }] : [];
      });
    const channels = hooks
      .channelsOf(spaceId)
      .slice(0, 10)
      .map((channel) => ({
        name: cut(channel.name, 60),
        description: clean(channel.description, 400),
        members: channel.agentIds.flatMap((agentId) => {
          const key = keys.get(agentId);
          return key ? [key] : [];
        }),
      }));
    const lead = agents.find((agent) => agent.reportsTo === null);
    const template: SpaceTemplate = {
      format: SPACE_TEMPLATE_FORMAT,
      version: SPACE_TEMPLATE_VERSION,
      name: cut(space.name, 60),
      description: "",
      icon: space.icon,
      idea: lead ? clean(lead.instructions.split("\n\n")[0] ?? "", 2_000) : "",
      agents,
      playbooks,
      loops,
      channels,
      researcher: agents.find((agent) => /research|scout/iu.test(`${agent.role ?? ""} ${agent.title}`))?.key ?? null,
    };
    // The export must read back as an import would read it.
    return yield* Effect.try({
      try: () => parseSpaceTemplate(template),
      catch: () => new TemplateRefused("The space has a part that no template can hold."),
    });
  });

  /** Makes the space of a template. Its agents wait for the validation stage and the owner. */
  readonly import = Effect.fn("SpaceTemplates.import")(function* (this: SpaceTemplates, input: ImportTemplateInput) {
    const hooks = this.#hooks;
    const template = input.template ?? STARTER_TEMPLATES.find((entry) => entry.id === input.starterId)?.template;
    if (!template) return yield* Effect.fail(new TemplateRefused("The template does not exist."));
    const notes: string[] = [];
    const spaceId = yield* hooks.createSpace(input.name ?? template.name, template.icon);
    const agents: Record<string, string> = {};
    for (const agent of template.agents) agents[agent.key] = yield* hooks.createAgent(spaceId, agent);
    const routines: { agentId: string; routineId: string }[] = [];
    for (const agent of template.agents) {
      const agentId = agents[agent.key];
      if (!agentId) continue;
      if (agent.reportsTo && agents[agent.reportsTo])
        yield* hooks
          .setManager(agentId, agents[agent.reportsTo] ?? "")
          .pipe(Effect.catch(() => Effect.sync(() => notes.push(`${agent.name}: the manager could not be set.`))));
      for (const skill of agent.skills) {
        const added = yield* hooks.addSkill(agentId, skill).pipe(Effect.orElseSucceed(() => false));
        if (!added) notes.push(`${agent.name}: the skill ${skill.name} could not be added.`);
      }
      for (const routine of agent.routines) {
        try {
          routines.push({ agentId, routineId: hooks.createRoutine(agentId, routine) });
        } catch {
          notes.push(`${agent.name}: the routine ${routine.name} could not be made.`);
        }
      }
    }
    for (const playbook of template.playbooks) {
      const saved = yield* hooks.savePlaybook(playbook).pipe(Effect.orElseSucceed(() => false));
      if (!saved) notes.push(`The playbook ${playbook.slug} exists already; the host kept its own.`);
    }
    for (const loop of template.loops)
      yield* hooks
        .createLoop(spaceId, loop)
        .pipe(
          Effect.catch((cause) =>
            Effect.sync(() =>
              notes.push(`A loop could not be made: ${cause instanceof Error ? cause.message : "refused"}.`),
            ),
          ),
        );
    for (const channel of template.channels)
      yield* hooks
        .createChannel(spaceId, {
          name: channel.name,
          description: channel.description,
          agentIds: channel.members.flatMap((key) => {
            const agentId = agents[key];
            return agentId ? [agentId] : [];
          }),
        })
        .pipe(Effect.catch(() => Effect.sync(() => notes.push(`The channel #${channel.name} could not be made.`))));
    const researcherId = template.researcher ? (agents[template.researcher] ?? null) : null;
    const record: TemplateImport = {
      id: randomUUID(),
      templateName: template.name,
      spaceId,
      state: input.skipValidation ? "ready" : "validating",
      validation: null,
      agents,
      researcherId,
      notes: notes.slice(0, 40),
      createdAt: new Date().toISOString(),
    };
    yield* this.#store.update((stored) => ({
      ...stored,
      imports: [record, ...stored.imports].slice(0, IMPORTS_KEPT),
      routines: { ...stored.routines, [record.id]: routines },
      templates: { ...stored.templates, [record.id]: template },
    }));
    if (input.skipValidation) return yield* this.decide(record.id, "build");
    if (researcherId) {
      yield* hooks
        .send(researcherId, validationBrief(template))
        .pipe(Effect.catch(() => this.#scoreItself(record.id, template)));
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        void Effect.runPromise(this.#late(record.id));
      }, VALIDATION_WAIT_MS);
      timer.unref?.();
      this.#timers.add(timer);
    } else yield* this.#scoreItself(record.id, template);
    return (yield* this.#find(record.id)) ?? record;
  });

  readonly #late = Effect.fn("SpaceTemplates.late")(function* (this: SpaceTemplates, importId: string) {
    const record = yield* this.#find(importId);
    const template = this.#store.current.templates[importId];
    if (record?.state !== "validating" || !template) return;
    yield* this.#scoreItself(importId, template);
  });

  readonly #scoreItself = Effect.fn("SpaceTemplates.scoreItself")(function* (
    this: SpaceTemplates,
    importId: string,
    template: SpaceTemplate,
  ) {
    const text = yield* this.#hooks.generate(validationPrompt(template));
    const answer = text
      ? yield* Effect.try(() => extractJsonObject(text)).pipe(
          Effect.flatMap((json) => Schema.decodeUnknownEffect(ValidationAnswer)(json)),
          Effect.orElseSucceed(() => null),
        )
      : null;
    yield* this.#validated(importId, {
      score: answer ? Math.round(answer.score) : 0,
      verdict: answer?.verdict ?? "test",
      demand: answer?.demand ?? "",
      competition: answer?.competition ?? "",
      risks: answer?.risks ?? "",
      summary: answer?.summary ?? "No model could score the idea. Decide yourself whether to build.",
      at: new Date().toISOString(),
      agentId: null,
    });
  });

  /**
   * `report_validation` of the research agent: the import of the space it works in, if it waits for a
   * validation. Null when it waits for none.
   */
  readonly report = Effect.fn("SpaceTemplates.report")(function* (
    this: SpaceTemplates,
    agentId: string,
    input: {
      score: number;
      verdict: ValidationVerdict;
      demand: string;
      competition: string;
      risks: string;
      summary: string;
    },
  ) {
    const stored = yield* this.#store.load();
    const record = stored.imports.find((entry) => entry.state === "validating" && entry.researcherId === agentId);
    if (!record) return null;
    return yield* this.#validated(record.id, {
      score: Math.min(Math.max(Math.round(input.score), 0), 100),
      verdict: input.verdict,
      demand: cut(input.demand, 800),
      competition: cut(input.competition, 800),
      risks: cut(input.risks, 800),
      summary: cut(input.summary, 1_200),
      at: new Date().toISOString(),
      agentId,
    });
  });

  readonly #validated = Effect.fn("SpaceTemplates.validated")(function* (
    this: SpaceTemplates,
    importId: string,
    validation: TemplateValidation,
  ) {
    const record = yield* this.#find(importId);
    if (record?.state !== "validating") return null;
    const done: TemplateImport = { ...record, state: "ready", validation };
    yield* this.#store.update((stored) => ({
      ...stored,
      imports: stored.imports.map((entry) => (entry.id === importId && entry.state === "validating" ? done : entry)),
    }));
    if (done)
      this.#hooks.notify(
        done.spaceId,
        `Validation of ${done.templateName}: ${validation.score}/100, ${validation.verdict}. ${validation.summary} Open Portfolio > Templates to start the building or stop it.`,
      );
    return done;
  });

  /** Starts the building (each agent gets its kickoff, the routines run) or stops the import. */
  readonly decide = Effect.fn("SpaceTemplates.decide")(function* (
    this: SpaceTemplates,
    importId: string,
    decision: "build" | "stop",
  ) {
    const record = yield* this.#find(importId);
    if (!record) return yield* Effect.fail(new TemplateRefused("The import does not exist."));
    if (record.state === "building" || record.state === "stopped")
      return yield* Effect.fail(new TemplateRefused("The import was already decided."));
    const next: TemplateImport = { ...record, state: decision === "build" ? "building" : "stopped" };
    const template = this.#store.current.templates[importId];
    yield* this.#store.update((stored) => {
      const { [importId]: _done, ...templates } = stored.templates;
      return {
        ...stored,
        imports: stored.imports.map((entry) => (entry.id === importId ? next : entry)),
        templates,
      };
    });
    if (decision === "stop") return next;
    for (const { agentId, routineId } of this.#store.current.routines[importId] ?? []) {
      try {
        this.#hooks.activateRoutine(agentId, routineId);
      } catch (cause) {
        logger.warn("A routine of a template did not turn on.", { cause });
      }
    }
    for (const [key, agentId] of Object.entries(record.agents)) {
      const agent = template?.agents.find((entry) => entry.key === key);
      const kickoff =
        agent?.kickoff ||
        "The owner started the building of this new business. Read your instructions, check the board and start your first task.";
      const validation = record.validation
        ? `\n\nValidation: ${record.validation.score}/100 (${record.validation.verdict}). ${record.validation.summary}`
        : "";
      yield* this.#hooks
        .send(agentId, `${kickoff}${validation}`)
        .pipe(Effect.catch((cause) => Effect.sync(() => logger.warn("A kickoff did not reach its agent.", { cause }))));
    }
    return next;
  });

  readonly #find = Effect.fn("SpaceTemplates.find")(function* (this: SpaceTemplates, importId: string) {
    return (yield* this.#store.load()).imports.find((entry) => entry.id === importId) ?? null;
  });
}

/** A loop's stages without the owner agents of this host, which mean nothing on another. */
function withoutOwners(definition: unknown, redact: (text: string) => string): LoopDefinition | null {
  if (!isDynamicRecord(definition)) return null;
  const stages = Array.isArray(definition.stages)
    ? definition.stages.map((stage) => {
        if (!isDynamicRecord(stage)) return stage;
        const { ownerAgentId: _owner, onEnter, ...rest } = stage;
        const enter = isDynamicRecord(onEnter) ? { ...onEnter } : undefined;
        if (enter) delete enter.routine;
        return { ...rest, ...(enter && Object.keys(enter).length ? { onEnter: enter } : {}) };
      })
    : definition.stages;
  try {
    return parseLoopDefinition(JSON.parse(scrub(JSON.stringify({ ...definition, stages }), redact)));
  } catch {
    return null;
  }
}
