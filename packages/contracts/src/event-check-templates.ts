import {
  cleanEventCheckOptionText,
  decodeEventCheckOptionLabels,
  decodeEventCheckTarget,
  EVENT_CHECK_OPTION_ID,
  type EventCheck,
  type EventCheckSelection,
  environmentName,
  eventCheckPointer,
  eventCheckText,
} from "./event-checks";
import { isDynamicRecord } from "./runtime-values";

export const EVENT_CHECK_TEMPLATE_LIMIT = 100;
/** The most conversations (or other options) one picker field can hold. */
export const EVENT_CHECK_PICKER_MAX_ENTRIES = 50;
/** The most options one discovery can list. A longer answer is refused, not cut. */
export const EVENT_CHECK_PICKER_MAX_OPTIONS = 1000;
export interface EventCheckTemplateVariable {
  name: string;
  label: string;
  hint: string;
  docsUrl: string | null;
}
/** One thing a person can ask for in an option of a picker, such as every message or only mentions. */
export interface EventCheckTemplatePickerMode {
  value: string;
  label: string;
}
/**
 * A text setting that a client can fill from a list. The value stays one text, `ID:mode,ID:mode`, so
 * the program reads it the way it reads any other setting. A client that does not know `picker` shows
 * the setting as the plain text field that it is.
 */
export interface EventCheckTemplatePicker {
  /** The options come from the program itself: it runs with `discover: true` and lists them. */
  optionsFrom: "program";
  /** The modes an option can have, the first one being the default. */
  modes: readonly EventCheckTemplatePickerMode[];
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
  /**
   * Only on a `text` field. It stays `text` on the wire on purpose: a client from before pickers
   * decodes the field and shows a text box, and a client that knows `picker` shows a list instead.
   */
  picker?: EventCheckTemplatePicker;
}
/** One entry of a picker value: the ID of an option and the mode that was chosen for it. */
export interface EventCheckPickerEntry {
  id: string;
  mode: string;
}
/** One conversation (or other choice) that a program found for a picker. Text from another party: never markup. */
export interface EventCheckPickerOption {
  id: string;
  label: string;
  /** A short machine word the picker groups by, such as `channel` or `dm`. */
  group: string;
  description?: string;
}
/** Whose account a program read the options from, so a person can see which account the list is for. */
export interface EventCheckPickerAccount {
  id: string;
  label: string;
}
export interface EventCheckPickerOptions {
  options: EventCheckPickerOption[];
  /** True when the program had more than it listed. */
  truncated?: boolean;
  /**
   * The account that the token belongs to, when the program says. Optional and additive: a host or
   * client from before it drops the field when it decodes the answer.
   */
  account?: EventCheckPickerAccount;
  /**
   * When the host read this list from the app, as an ISO time. A list from the host's memory is older
   * than the call that asked for it. Optional and additive: older hosts leave it out and older clients
   * drop it.
   */
  readAt?: string;
  /**
   * True when the app could not be read just now and `readAt` is an older list that the host kept.
   * Optional and additive, like `readAt`.
   */
  stale?: boolean;
}
/**
 * A discovery for an install that does not exist yet. `variables` holds the private values the user
 * typed in the dialog. The host uses them for this one call, in memory: it never stores, logs or
 * audits them, and it never returns them.
 */
export interface EventCheckTemplateDiscoverInput {
  slug: string;
  /** The name of the picker field that the options are for. */
  field: string;
  /** The values of the other settings that the program reads, by name. */
  configuration: Record<string, string>;
  variables: Record<string, string>;
  /**
   * Names only these options. A program that knows `ids` answers with just those; an older program
   * ignores it and lists everything, which holds the names as well. Optional and additive.
   */
  ids?: string[];
}
/** A discovery for an installed check: it uses the private values that the check already holds. */
export interface EventCheckDiscoverCheckInput {
  agentId: string;
  id: string;
  field: string;
  /** Names only these options, as in a draft discovery. Optional and additive. */
  ids?: string[];
  /**
   * Asks the host to read the app again and not to answer from the list it kept. Optional and
   * additive: a host from before it never keeps a list, so it always reads the app.
   */
  refresh?: boolean;
}
/** An earlier version of a template's program. The host keeps it so a check that runs it can still be linked. */
export interface EventCheckTemplateEarlierProgram {
  version: string;
  file: string;
  digest: string;
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
  /** Earlier versions of the program, newest first. Optional: a client that does not know it ignores it. */
  earlierPrograms?: EventCheckTemplateEarlierProgram[];
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
  /**
   * The readable names of the choices in a picker setting, by setting name and then by option ID.
   * Optional and additive: a host from before it ignores it, and the install is the same without it.
   */
  configurationLabels?: Record<string, Record<string, string>>;
}
export interface EventCheckTemplateApi {
  list(): Promise<EventCheckTemplate[]>;
  /** Creates a paused check. The private variables are set afterwards, in masked fields. */
  install(input: EventCheckTemplateInstallInput): Promise<EventCheck>;
  /** Moves an installed check to the template's current version and keeps the user's values. */
  update(input: { agentId: string; id: string }): Promise<EventCheck>;
  /** Links an existing check to its template, when its program is exactly the template's program. */
  adopt(input: { agentId: string; id: string; slug: string }): Promise<EventCheck>;
  /**
   * Lists the options of a picker field before the check exists. Absent when the host or client has no
   * pickers. The answer goes only to the person who asked.
   */
  discover?(input: EventCheckTemplateDiscoverInput): Promise<EventCheckPickerOptions>;
  /** The same for an installed check, with the private values it holds. Absent when there are no pickers. */
  discoverCheck?(input: EventCheckDiscoverCheckInput): Promise<EventCheckPickerOptions>;
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
const PICKER_MODE = /^[a-z][a-z0-9_-]{0,31}$/;
const PICKER_ID = EVENT_CHECK_OPTION_ID;
const PICKER_GROUP = /^[a-z][a-z0-9_]{0,31}$/;
function decodePicker(value: unknown): EventCheckTemplatePicker {
  if (!isDynamicRecord(value) || value.optionsFrom !== "program") throw new Error("Invalid template picker.");
  const modes = list(value.modes, 4, (entry): EventCheckTemplatePickerMode => {
    if (!isDynamicRecord(entry)) throw new Error("Invalid template picker.");
    const mode = text(entry.value, 32, true);
    if (!PICKER_MODE.test(mode)) throw new Error("Invalid template picker.");
    return { value: mode, label: text(entry.label, 64, true) };
  });
  if (modes.length === 0 || new Set(modes.map((mode) => mode.value)).size !== modes.length)
    throw new Error("Invalid template picker.");
  return { optionsFrom: "program", modes };
}
/**
 * The entries of a picker value, `ID:mode,ID:mode`. An empty value has none. It throws on anything
 * else: a mode that the picker does not declare, an ID twice, an ID that is not plain, or too many.
 * The program reads the same text, so a value that passes here is one it can use.
 */
export function parseEventCheckPickerValue(value: string, picker: EventCheckTemplatePicker): EventCheckPickerEntry[] {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  const modes = new Set(picker.modes.map((mode) => mode.value));
  const seen = new Set<string>();
  const entries = trimmed.split(",").map((part): EventCheckPickerEntry => {
    const pieces = part.split(":").map((piece) => piece.trim());
    const [id, mode] = pieces;
    if (pieces.length !== 2 || id === undefined || mode === undefined || !PICKER_ID.test(id) || !modes.has(mode))
      throw new Error("Invalid picker value.");
    if (seen.has(id)) throw new Error("Invalid picker value.");
    seen.add(id);
    return { id, mode };
  });
  if (entries.length > EVENT_CHECK_PICKER_MAX_ENTRIES) throw new Error("Invalid picker value.");
  return entries;
}
export function formatEventCheckPickerValue(entries: readonly EventCheckPickerEntry[]): string {
  return entries.map((entry) => `${entry.id}:${entry.mode}`).join(",");
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
  const picker = value.picker === undefined ? undefined : decodePicker(value.picker);
  // A picker fills a text value. A boolean has nothing to pick, and a default must be a valid value.
  if (picker && type !== "text") throw new Error("Invalid template field.");
  if (picker) parseEventCheckPickerValue(fieldValue, picker);
  return {
    name,
    label: text(value.label, 256, true),
    description: text(value.description, 2048),
    value: fieldValue,
    required: value.required,
    type,
    ...(picker ? { picker } : {}),
  };
}
const PROGRAM_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(mjs|js|py|sh)$/;
function decodeEarlierProgram(value: unknown): EventCheckTemplateEarlierProgram {
  if (!isDynamicRecord(value)) throw new Error("Invalid template program.");
  const digest = text(value.digest, 64, true);
  const file = text(value.file, 256, true);
  if (!/^[a-f0-9]{64}$/.test(digest) || !PROGRAM_FILE.test(file)) throw new Error("Invalid template program.");
  return { version: text(value.version, 64, true), file, digest };
}
export function decodeEventCheckTemplate(value: unknown): EventCheckTemplate {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.program) || !isDynamicRecord(value.selection))
    throw new Error("Invalid event check template.");
  const digest = text(value.program.digest, 64, true);
  const file = text(value.program.file, 256, true);
  if (!/^[a-f0-9]{64}$/.test(digest) || !PROGRAM_FILE.test(file)) throw new Error("Invalid template program.");
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
    ...(value.earlierPrograms === undefined
      ? {}
      : { earlierPrograms: list(value.earlierPrograms, 10, decodeEarlierProgram) }),
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
  const configurationLabels = decodeConfigurationLabels(value.configurationLabels);
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
    ...(configurationLabels ? { configurationLabels } : {}),
  };
}
/** Names of choices by setting. Lenient like the labels of a saved check: a bad entry is dropped. */
function decodeConfigurationLabels(value: unknown): Record<string, Record<string, string>> | undefined {
  if (!isDynamicRecord(value)) return undefined;
  const result: Record<string, Record<string, string>> = {};
  let count = 0;
  for (const [name, entry] of Object.entries(value)) {
    if (count >= 30) break;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) continue;
    const labels = decodeEventCheckOptionLabels(entry);
    if (!labels) continue;
    result[name] = labels;
    count++;
  }
  return count === 0 ? undefined : result;
}
export function decodeEventCheckTemplateAdoptInput(value: unknown): { agentId: string; id: string; slug: string } {
  if (!isDynamicRecord(value)) throw new Error("Invalid template link.");
  return { ...decodeEventCheckTarget(value), slug: slug(value.slug) };
}

const OPTION_LABEL_LIMIT = 120;
const OPTION_DESCRIPTION_LIMIT = 200;
function decodePickerOption(value: unknown): EventCheckPickerOption {
  if (!isDynamicRecord(value) || typeof value.id !== "string" || !PICKER_ID.test(value.id))
    throw new Error("Invalid picker option.");
  if (typeof value.group !== "string" || !PICKER_GROUP.test(value.group)) throw new Error("Invalid picker option.");
  const label = cleanEventCheckOptionText(value.label, OPTION_LABEL_LIMIT) || value.id;
  const description =
    value.description === undefined ? "" : cleanEventCheckOptionText(value.description, OPTION_DESCRIPTION_LIMIT);
  return { id: value.id, label, group: value.group, ...(description ? { description } : {}) };
}
/**
 * What a program printed for a picker, read as untrusted text. A shape that is wrong is refused. A
 * list that is too long is refused too, because a client would show a part and call it all. An ID
 * that comes twice is kept once.
 */
export function decodeEventCheckPickerOptions(value: unknown): EventCheckPickerOptions {
  if (!isDynamicRecord(value) || !Array.isArray(value.options) || value.options.length > EVENT_CHECK_PICKER_MAX_OPTIONS)
    throw new Error("Invalid picker options.");
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") throw new Error("Invalid picker options.");
  const account = decodePickerAccount(value.account);
  const readAt =
    typeof value.readAt === "string" && value.readAt.length <= 64 && Number.isFinite(Date.parse(value.readAt))
      ? value.readAt
      : undefined;
  const seen = new Set<string>();
  const options: EventCheckPickerOption[] = [];
  for (const entry of value.options) {
    const option = decodePickerOption(entry);
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    options.push(option);
  }
  return {
    options,
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(account ? { account } : {}),
    ...(readAt ? { readAt } : {}),
    ...(value.stale === true && readAt ? { stale: true } : {}),
  };
}
/** The account of an answer, read leniently: a wrong shape is no account, and never fails the list. */
function decodePickerAccount(value: unknown): EventCheckPickerAccount | undefined {
  if (!isDynamicRecord(value) || typeof value.id !== "string" || !PICKER_ID.test(value.id)) return undefined;
  try {
    const label = cleanEventCheckOptionText(value.label, OPTION_LABEL_LIMIT) || value.id;
    return { id: value.id, label };
  } catch {
    return undefined;
  }
}
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
function valueMap(value: unknown, maximum: number, nameOk: (name: string) => boolean): Record<string, string> {
  if (!isDynamicRecord(value)) throw new Error("Invalid template discovery.");
  const entries = Object.entries(value);
  if (entries.length > maximum) throw new Error("Invalid template discovery.");
  const result: Record<string, string> = {};
  for (const [name, entry] of entries) {
    if (!nameOk(name) || ["__proto__", "constructor", "prototype"].includes(name) || typeof entry !== "string")
      throw new Error("Invalid template discovery.");
    // Never put the value in the message: it can be a private value.
    if (entry.length > 8192) throw new Error("Invalid template discovery.");
    result[name] = entry;
  }
  return result;
}
/** The IDs that a discovery names, or none. Strict: a wrong ID is refused, so a call never lists more than asked. */
function discoveryIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > EVENT_CHECK_PICKER_MAX_ENTRIES)
    throw new Error("Invalid template discovery.");
  const ids = [
    ...new Set(
      value.map((id) => {
        if (typeof id !== "string" || !PICKER_ID.test(id)) throw new Error("Invalid template discovery.");
        return id;
      }),
    ),
  ];
  return ids.length > 0 ? ids : undefined;
}
export function decodeEventCheckTemplateDiscoverInput(value: unknown): EventCheckTemplateDiscoverInput {
  if (!isDynamicRecord(value)) throw new Error("Invalid template discovery.");
  const field = text(value.field, 128, true);
  if (!NAME.test(field)) throw new Error("Invalid template discovery.");
  const ids = discoveryIds(value.ids);
  return {
    slug: slug(value.slug),
    field,
    configuration: valueMap(value.configuration, 30, (name) => NAME.test(name)),
    variables: valueMap(value.variables, 20, (name) => {
      try {
        environmentName(name);
        return true;
      } catch {
        return false;
      }
    }),
    ...(ids ? { ids } : {}),
  };
}
export function decodeEventCheckDiscoverCheckInput(value: unknown): EventCheckDiscoverCheckInput {
  if (!isDynamicRecord(value)) throw new Error("Invalid template discovery.");
  const field = text(value.field, 128, true);
  if (!NAME.test(field)) throw new Error("Invalid template discovery.");
  const ids = discoveryIds(value.ids);
  return {
    ...decodeEventCheckTarget(value),
    field,
    ...(ids ? { ids } : {}),
    ...(value.refresh === true ? { refresh: true } : {}),
  };
}
