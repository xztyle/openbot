import {
  decodeEventCheckTarget,
  type EventCheck,
  type EventCheckSelection,
  environmentName,
  eventCheckPointer,
  eventCheckText,
} from "./event-checks";
import { isDynamicRecord } from "./runtime-values";

export const EVENT_CHECK_TEMPLATE_LIMIT = 100;
export interface EventCheckTemplateVariable {
  name: string;
  label: string;
  hint: string;
  docsUrl: string | null;
}
export interface EventCheckTemplateField {
  name: string;
  label: string;
  description: string;
  /** The default the install dialog starts from. */
  value: string;
  required: boolean;
  /** `boolean` fields hold the text `true` or `false`, and the install dialog shows a switch. */
  type: "text" | "boolean";
}
/** A reviewed program that ships with the host. A client names it by slug and never sends code. */
export interface EventCheckTemplate {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  version: string;
  creatorName: string;
  iconUrl: string | null;
  websiteUrl: string | null;
  /** The slug of the Apps listing this template reads from, so the page can say which app pairs with it. */
  app: string | null;
  program: { file: string; digest: string };
  accountLabelHint: string;
  variables: EventCheckTemplateVariable[];
  configuration: EventCheckTemplateField[];
  argumentsJson: string;
  cursorArgument: string;
  nextCursorPointer: string;
  selection: EventCheckSelection;
  /** The path of the actual change author in each item, for the "skip my account" filter. */
  actorPointer: string;
  intervalSeconds: number;
  instruction: string;
}
export interface EventCheckTemplateInstallInput {
  slug: string;
  agentId: string;
  name: string;
  accountLabel: string;
  instruction: string;
  timezone: string;
  intervalSeconds: number;
  accountActorIds: string[];
  configuration: Record<string, string>;
}
export interface EventCheckTemplateApi {
  list(): Promise<EventCheckTemplate[]>;
  /** Creates a paused check. The private variables are set afterwards, in masked fields. */
  install(input: EventCheckTemplateInstallInput): Promise<EventCheck>;
  /** Moves an installed check to the template's current version and keeps the user's values. */
  update(input: { agentId: string; id: string }): Promise<EventCheck>;
  /** Links an existing check to its template, when its program is exactly the template's program. */
  adopt(input: { agentId: string; id: string; slug: string }): Promise<EventCheck>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const text = eventCheckText;
function link(value: unknown): string | null {
  if (value === null) return null;
  const parsed = text(value, 2048, true);
  if (!parsed.startsWith("https://")) throw new Error("Invalid event check template link.");
  return parsed;
}
function slug(value: unknown): string {
  const parsed = text(value, 64, true);
  if (!SLUG.test(parsed)) throw new Error("Invalid event check template slug.");
  return parsed;
}
function list<A>(value: unknown, maximum: number, decode: (entry: unknown) => A): A[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Invalid event check template list.");
  return value.map(decode);
}
function decodeVariable(value: unknown): EventCheckTemplateVariable {
  if (!isDynamicRecord(value)) throw new Error("Invalid template variable.");
  return {
    name: environmentName(value.name),
    label: text(value.label, 256, true),
    hint: text(value.hint, 2048),
    docsUrl: link(value.docsUrl),
  };
}
function decodeField(value: unknown): EventCheckTemplateField {
  if (!isDynamicRecord(value) || typeof value.required !== "boolean") throw new Error("Invalid template field.");
  const name = text(value.name, 128, true);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name))
    throw new Error("Invalid template field.");
  const type = value.type === undefined ? "text" : value.type;
  if (type !== "text" && type !== "boolean") throw new Error("Invalid template field.");
  const fieldValue = text(value.value, 8192);
  if (type === "boolean" && fieldValue !== "true" && fieldValue !== "false") throw new Error("Invalid template field.");
  return {
    name,
    label: text(value.label, 256, true),
    description: text(value.description, 2048),
    value: fieldValue,
    required: value.required,
    type,
  };
}
export function decodeEventCheckTemplate(value: unknown): EventCheckTemplate {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.program) || !isDynamicRecord(value.selection))
    throw new Error("Invalid event check template.");
  const digest = text(value.program.digest, 64, true);
  const file = text(value.program.file, 256, true);
  if (!/^[a-f0-9]{64}$/.test(digest) || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(mjs|js|py|sh)$/.test(file))
    throw new Error("Invalid template program.");
  const interval = value.intervalSeconds;
  if (typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 30 || interval > 86_400)
    throw new Error("Invalid template interval.");
  const argumentsJson = text(value.argumentsJson, 16000, true);
  if (!isDynamicRecord(JSON.parse(argumentsJson))) throw new Error("Invalid template arguments.");
  const variables = list(value.variables, 20, decodeVariable);
  const configuration = list(value.configuration, 30, decodeField);
  if (
    new Set(variables.map((entry) => entry.name)).size !== variables.length ||
    new Set(configuration.map((entry) => entry.name)).size !== configuration.length
  )
    throw new Error("Duplicate template name.");
  return {
    slug: slug(value.slug),
    name: text(value.name, 256, true),
    tagline: text(value.tagline, 512, true),
    description: text(value.description, 8192, true),
    version: text(value.version, 64, true),
    creatorName: text(value.creatorName, 256, true),
    iconUrl: link(value.iconUrl),
    websiteUrl: link(value.websiteUrl),
    app: value.app === null ? null : slug(value.app),
    program: { file, digest },
    accountLabelHint: text(value.accountLabelHint, 512),
    variables,
    configuration,
    argumentsJson,
    cursorArgument: text(value.cursorArgument, 128),
    nextCursorPointer: eventCheckPointer(value.nextCursorPointer),
    selection: {
      itemsPointer: eventCheckPointer(value.selection.itemsPointer),
      idPointer: eventCheckPointer(value.selection.idPointer),
      revisionPointer: eventCheckPointer(value.selection.revisionPointer),
    },
    actorPointer: eventCheckPointer(value.actorPointer),
    intervalSeconds: interval,
    instruction: text(value.instruction, 16000, true),
  };
}
export function decodeEventCheckTemplateList(value: unknown): EventCheckTemplate[] {
  return list(value, EVENT_CHECK_TEMPLATE_LIMIT, decodeEventCheckTemplate);
}
export function decodeEventCheckTemplateInstallInput(value: unknown): EventCheckTemplateInstallInput {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.configuration)) throw new Error("Invalid template install.");
  const interval = value.intervalSeconds;
  if (typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 30 || interval > 86_400)
    throw new Error("Invalid template interval.");
  const configuration: Record<string, string> = {};
  const entries = Object.entries(value.configuration);
  if (entries.length > 30) throw new Error("Invalid template install.");
  for (const [name, entry] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name))
      throw new Error("Invalid template install.");
    configuration[name] = text(entry, 8192);
  }
  return {
    slug: slug(value.slug),
    agentId: text(value.agentId, 128, true),
    name: text(value.name, 256, true),
    accountLabel: text(value.accountLabel, 128, true),
    instruction: text(value.instruction, 16000, true),
    timezone: text(value.timezone, 128, true),
    intervalSeconds: interval,
    accountActorIds: list(value.accountActorIds, 20, (id) => text(id, 512, true)),
    configuration,
  };
}
export function decodeEventCheckTemplateAdoptInput(value: unknown): { agentId: string; id: string; slug: string } {
  if (!isDynamicRecord(value)) throw new Error("Invalid template link.");
  return { ...decodeEventCheckTarget(value), slug: slug(value.slug) };
}
