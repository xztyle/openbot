import type { EventCheckTemplate, EventCheckTemplateInstallInput } from "@openbot/contracts/event-check-templates";
import type { EventCheck } from "@openbot/contracts/event-checks";

/** The limits of the install request, as the host reads them. */
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86_400;
export const MAX_ACTOR_IDS = 20;

/** What the install dialog holds. A text that the user did not change is `null`, so it follows the template. */
export interface InstallForm {
  agentIds: string[];
  accountLabel: string;
  /** `null` until the user edits it: the name follows the account label. */
  name: string | null;
  configuration: Record<string, string>;
  /** The names of the chosen options of each picker setting, by setting and then by option ID. */
  labels: Record<string, Record<string, string>>;
  intervalSeconds: string;
  /** Comma or line separated. */
  actorIds: string;
  instruction: string;
}

export function initialInstallForm(template: EventCheckTemplate, agentIds: readonly string[]): InstallForm {
  return {
    agentIds: [...agentIds],
    accountLabel: "",
    name: null,
    configuration: Object.fromEntries(template.configuration.map((field) => [field.name, field.value])),
    labels: {},
    intervalSeconds: String(template.intervalSeconds),
    actorIds: "",
    instruction: template.instruction,
  };
}

/** "Linear — Work account". The name of the template alone while the label is empty. */
export function defaultCheckName(template: EventCheckTemplate, accountLabel: string): string {
  const label = accountLabel.trim();
  return label ? `${template.name} — ${label}` : template.name;
}

export function checkName(template: EventCheckTemplate, form: InstallForm): string {
  return form.name ?? defaultCheckName(template, form.accountLabel);
}

/** Splits on commas and line breaks. An ID that repeats counts once. */
export function parseActorIds(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n\r]/u)
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

/** The seconds in the form, or `null` when they are not a whole number in the allowed range. */
export function parseInterval(text: string): number | null {
  const seconds = Number(text.trim());
  return text.trim() !== "" &&
    Number.isSafeInteger(seconds) &&
    seconds >= MIN_INTERVAL_SECONDS &&
    seconds <= MAX_INTERVAL_SECONDS
    ? seconds
    : null;
}

export interface InstallFormErrors {
  agents: boolean;
  accountLabel: boolean;
  name: boolean;
  interval: boolean;
  actorIds: boolean;
  instruction: boolean;
  /** The required settings that are empty, by field name. */
  fields: string[];
}

export function installFormErrors(template: EventCheckTemplate, form: InstallForm): InstallFormErrors {
  return {
    agents: form.agentIds.length === 0,
    accountLabel: form.accountLabel.trim() === "",
    name: checkName(template, form).trim() === "",
    interval: parseInterval(form.intervalSeconds) === null,
    actorIds: parseActorIds(form.actorIds).length > MAX_ACTOR_IDS,
    instruction: form.instruction.trim() === "",
    fields: template.configuration
      .filter((field) => field.required && (form.configuration[field.name] ?? "").trim() === "")
      .map((field) => field.name),
  };
}

export function hasInstallErrors(errors: InstallFormErrors): boolean {
  return (
    errors.agents ||
    errors.accountLabel ||
    errors.name ||
    errors.interval ||
    errors.actorIds ||
    errors.instruction ||
    errors.fields.length > 0
  );
}

/**
 * One install request for each chosen agent, in the order of `agentIds`. Every request has the same
 * account label and values. A private variable is never part of it: the user sets those afterwards.
 * `null` when the form has an error.
 */
export function installRequests(
  template: EventCheckTemplate,
  form: InstallForm,
  timezone: string,
): EventCheckTemplateInstallInput[] | null {
  const interval = parseInterval(form.intervalSeconds);
  if (interval === null || hasInstallErrors(installFormErrors(template, form))) return null;
  const configuration = Object.fromEntries(
    template.configuration.map((field) => [field.name, form.configuration[field.name] ?? field.value]),
  );
  // Only the settings that hold a name go in the request. The copies are plain objects: the form is a
  // store, and a store proxy cannot cross the bridge or be cloned.
  const configurationLabels: Record<string, Record<string, string>> = {};
  for (const [name, names] of Object.entries(form.labels)) {
    const copy = Object.fromEntries(Object.entries(names));
    if (name in configuration && Object.keys(copy).length > 0) configurationLabels[name] = copy;
  }
  return form.agentIds.map((agentId) => ({
    slug: template.slug,
    agentId,
    name: checkName(template, form).trim(),
    accountLabel: form.accountLabel.trim(),
    instruction: form.instruction,
    timezone,
    intervalSeconds: interval,
    accountActorIds: parseActorIds(form.actorIds),
    configuration,
    ...(Object.keys(configurationLabels).length > 0 ? { configurationLabels } : {}),
  }));
}

export interface InstallOutcome {
  created: EventCheck[];
  failed: { agentId: string; error: unknown }[];
}

/**
 * Sends the requests one after the other. A failure for one agent does not stop the others and does
 * not remove a check that was created: the outcome holds both.
 */
export async function runInstalls(
  requests: readonly EventCheckTemplateInstallInput[],
  install: (input: EventCheckTemplateInstallInput) => Promise<EventCheck>,
): Promise<InstallOutcome> {
  const outcome: InstallOutcome = { created: [], failed: [] };
  for (const request of requests) {
    try {
      outcome.created.push(await install(request));
    } catch (error) {
      outcome.failed.push({ agentId: request.agentId, error });
    }
  }
  return outcome;
}
