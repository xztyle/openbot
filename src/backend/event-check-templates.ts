import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import {
  decodeEventCheckTemplateList,
  type EventCheckTemplate,
  type EventCheckTemplateDiscoverInput,
  type EventCheckTemplateField,
  type EventCheckTemplateInstallInput,
  parseEventCheckPickerValue,
} from "@openbot/contracts/event-check-templates";
import type { EventCheck, EventCheckApiSource, EventCheckInput } from "@openbot/contracts/event-checks";
import { sourceText } from "@openbot/i18n/source";
import { EventCheckRefusal } from "./event-check-refusal";
import { isPathInside } from "./path-containment";

const digestOf = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Owns the reviewed event check templates the host ships, and places their programs in the shared
 * watcher folder. A client names a template by slug and never supplies program text. It never
 * imports the scheduler or the store.
 */
export class EventCheckTemplates {
  #templates: readonly EventCheckTemplate[] | null = null;
  constructor(
    readonly catalogRoot: string,
    readonly programsRoot: string,
  ) {}
  list(): readonly EventCheckTemplate[] {
    if (this.#templates) return this.#templates;
    const templates = decodeEventCheckTemplateList(
      JSON.parse(readFileSync(join(this.catalogRoot, "catalog.json"), "utf8")),
    );
    for (const template of templates)
      for (const program of [template.program, ...(template.earlierPrograms ?? [])])
        if (digestOf(this.#source(program.file)) !== program.digest)
          throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateProgram"));
    this.#templates = templates;
    return templates;
  }
  get(slug: string): EventCheckTemplate {
    const template = this.list().find((entry) => entry.slug === slug);
    if (!template) throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateUnknown"));
    return template;
  }
  #source(file: string): string {
    const root = realpathSync(join(this.catalogRoot, "programs"));
    const path = realpathSync(join(root, file));
    if (!isPathInside(root, path) || !statSync(path).isFile())
      throw new EventCheckRefusal(sourceText("error.backend.eventCheckProgram"));
    return path;
  }
  /** The name the program takes in the shared folder. A version in the name keeps an old instance on its own file. */
  programName(template: EventCheckTemplate): string {
    const extension = extname(template.program.file);
    return `${template.program.file.slice(0, -extension.length)}@${template.version}${extension}`;
  }
  /** Copies the program once. A file that is already there must be the reviewed one; it is never replaced. */
  place(template: EventCheckTemplate): string {
    const name = this.programName(template);
    const target = join(this.programsRoot, name);
    if (existsSync(target)) {
      if (digestOf(target) !== template.program.digest)
        throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateProgram"));
      return name;
    }
    const staged = `${target}.${process.pid}.tmp`;
    try {
      copyFileSync(this.#source(template.program.file), staged);
      if (digestOf(staged) !== template.program.digest)
        throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateProgram"));
      renameSync(staged, target);
    } catch (error) {
      if (error instanceof EventCheckRefusal) throw error;
      // A file system failure holds a path and a code, never a value. The user can act on this sentence.
      throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateWrite"));
    } finally {
      rmSync(staged, { force: true });
    }
    return name;
  }
  /**
   * The version of the template whose program an existing check runs, byte for byte. That is the
   * current version or an earlier one that the host still ships. Null when the program is none of them.
   */
  matchedVersion(template: EventCheckTemplate, check: EventCheck): string | null {
    if (check.source.kind !== "api") return null;
    try {
      const root = realpathSync(this.programsRoot);
      const path = realpathSync(join(root, check.source.toolName));
      if (!isPathInside(root, path) || !statSync(path).isFile()) return null;
      const digest = digestOf(path);
      if (digest === template.program.digest) return template.version;
      return template.earlierPrograms?.find((program) => program.digest === digest)?.version ?? null;
    } catch {
      return null;
    }
  }
  /**
   * Whether the check runs a reviewed program of the template that it links to: the current one, or an
   * earlier version that the catalog still lists. The digest in the check is the one OpenBot read from
   * the file, so it is the file that this answers for.
   */
  reviewed(check: EventCheck): boolean {
    if (check.source.kind !== "api" || !check.source.template || !check.source.programDigest) return false;
    try {
      const { programDigest: digest, template: link } = check.source;
      const template = this.list().find((entry) => entry.slug === link.slug);
      if (!template) return false;
      return (
        template.program.digest === digest ||
        (template.earlierPrograms ?? []).some((earlier) => earlier.digest === digest)
      );
    } catch {
      return false;
    }
  }
  /** Whether the program an existing check runs is byte for byte a program of the template. */
  matches(template: EventCheckTemplate, check: EventCheck): boolean {
    return this.matchedVersion(template, check) !== null;
  }
  install(template: EventCheckTemplate, request: EventCheckTemplateInstallInput, now: Date): EventCheckInput {
    const known = new Set(template.configuration.map((field) => field.name));
    if (Object.keys(request.configuration).some((name) => !known.has(name)))
      throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateUnknown"));
    const configuration = template.configuration.map((field) => {
      const value = (request.configuration[field.name] ?? field.value).trim();
      if (field.required && !value)
        throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateField", { name: field.label }));
      if (field.type === "boolean" && value !== "true" && value !== "false")
        throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateBoolean", { name: field.label }));
      if (field.picker) {
        // A picker value has one strict shape. The program reads the same text, so a bad one stops here.
        try {
          parseEventCheckPickerValue(value, field.picker);
        } catch {
          throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplatePicker", { name: field.label }));
        }
      }
      const labels = field.picker ? request.configurationLabels?.[field.name] : undefined;
      return {
        name: field.name,
        label: field.label,
        description: field.description,
        value,
        // The store drops a name whose ID the value does not hold.
        ...(labels && Object.keys(labels).length > 0 ? { optionLabels: labels } : {}),
      };
    });
    return {
      agentId: request.agentId,
      name: request.name,
      instruction: request.instruction,
      active: false,
      timezone: request.timezone,
      schedule: { kind: "interval", amount: request.intervalSeconds, unit: "seconds", anchorAt: now.toISOString() },
      selfEvents: {
        mode: "exclude",
        connectionId: request.accountLabel,
        actorPointer: template.actorPointer,
        accountActorIds: request.accountActorIds,
      },
      source: {
        kind: "api",
        connectionId: request.accountLabel,
        variables: template.variables.map((variable) => variable.name),
        configuration,
        toolName: this.place(template),
        argumentsJson: template.argumentsJson,
        cursorArgument: template.cursorArgument,
        nextCursorPointer: template.nextCursorPointer,
        template: { slug: template.slug, version: template.version },
      },
      selection: template.selection,
    };
  }
  /** The picker field of a template by name, or a refusal when there is none. */
  #pickerField(template: EventCheckTemplate, name: string): EventCheckTemplateField {
    const field = template.configuration.find((entry) => entry.name === name && entry.picker !== undefined);
    if (!field) throw new EventCheckRefusal(sourceText("error.backend.eventCheckDiscoverUnsupported"));
    return field;
  }
  /**
   * What a draft discovery runs: the reviewed program of the template, the settings the person has
   * typed (any other setting keeps its default), and the typed private values. Nothing here is saved.
   * A name that the template does not declare is refused, as an install refuses it.
   */
  draftDiscovery(template: EventCheckTemplate, input: EventCheckTemplateDiscoverInput) {
    const picker = this.#pickerField(template, input.field);
    const variableNames = new Set(template.variables.map((variable) => variable.name));
    const fieldNames = new Set(template.configuration.map((field) => field.name));
    if (
      Object.keys(input.variables).some((name) => !variableNames.has(name)) ||
      Object.keys(input.configuration).some((name) => !fieldNames.has(name))
    )
      throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateUnknown"));
    const variables: Record<string, string> = {};
    for (const name of variableNames) {
      const value = input.variables[name] ?? "";
      if (value.trim() === "") throw new EventCheckRefusal(sourceText("error.backend.eventCheckMissingVariable"));
      variables[name] = value;
    }
    const configuration: Record<string, string> = {};
    for (const field of template.configuration)
      if (field.name !== picker.name)
        configuration[field.name] = (input.configuration[field.name] ?? field.value).trim();
    return { name: this.place(template), digest: template.program.digest, variables, configuration };
  }
  /**
   * The template whose picker an installed check can list. The check must be linked, and must run the
   * current reviewed program byte for byte: an earlier program has no discovery, and a program that
   * someone edited is not one that this host reviewed.
   */
  discoverable(check: EventCheck, field: string): EventCheckTemplate {
    const link = check.source.kind === "api" ? check.source.template : undefined;
    if (!link) throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateNotLinked"));
    const template = this.get(link.slug);
    this.#pickerField(template, field);
    if (this.matchedVersion(template, check) !== template.version)
      throw new EventCheckRefusal(sourceText("error.backend.eventCheckDiscoverUnsupported"));
    return template;
  }
  /** The same check on the template's current version. The user's values and choices stay. */
  upgrade(template: EventCheckTemplate, check: EventCheck): EventCheckInput {
    const source = check.source;
    if (source.kind !== "api" || source.template?.slug !== template.slug)
      throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateNotLinked"));
    if (source.template.version === template.version)
      throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateCurrent"));
    const held = new Map(source.configuration.map((field) => [field.name, field]));
    const next: EventCheckApiSource = {
      ...source,
      variables: template.variables.map((variable) => variable.name),
      configuration: template.configuration.map((field) => {
        const previous = held.get(field.name);
        return {
          name: field.name,
          label: field.label,
          description: field.description,
          value: previous?.value ?? field.value,
          ...(previous?.optionLabels ? { optionLabels: previous.optionLabels } : {}),
        };
      }),
      toolName: this.place(template),
      argumentsJson: template.argumentsJson,
      cursorArgument: template.cursorArgument,
      nextCursorPointer: template.nextCursorPointer,
      template: { slug: template.slug, version: template.version },
    };
    const { programDigest: _stale, ...rest } = next;
    return { ...check, source: rest, selection: template.selection };
  }
  /**
   * The same check with a template link and nothing else changed, so its baseline stays. The link
   * names the version whose program the check runs, so Update can then move it to the current one.
   */
  link(template: EventCheckTemplate, check: EventCheck): EventCheckInput {
    const version = this.matchedVersion(template, check);
    if (check.source.kind !== "api" || version === null)
      throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateProgram"));
    return { ...check, source: { ...check.source, template: { slug: template.slug, version } } };
  }
}
