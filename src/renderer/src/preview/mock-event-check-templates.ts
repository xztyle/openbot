import type { EventCheckTemplate, EventCheckTemplateApi } from "@openbot/contracts/event-check-templates";
import type { EventCheck, EventCheckApi, EventCheckInput } from "@openbot/contracts/event-checks";

/**
 * A made-up template for the preview and Storybook. It is never part of the host's catalog, reads no
 * real app and holds no real program: the digest is a placeholder.
 */
export const PREVIEW_EVENT_CHECK_TEMPLATE: EventCheckTemplate = {
  slug: "preview-sample-tracker",
  name: "Sample tracker (preview only)",
  tagline: "A made-up event check that shows how templates look. It reads no real app.",
  description:
    "This sample exists only in the preview. It shows the install steps of an event check template: an account label, settings, a schedule, and private variables that you enter afterwards.",
  version: "2",
  creatorName: "OpenBot preview",
  iconUrl: null,
  websiteUrl: null,
  app: "linear",
  program: { file: "preview-sample-tracker.mjs", digest: "0".repeat(64) },
  accountLabelHint: "Work account",
  variables: [
    {
      name: "SAMPLE_API_TOKEN",
      label: "Sample API token",
      hint: "A fake token. Any text works in the preview.",
      docsUrl: "https://example.com/sample-token",
    },
  ],
  configuration: [
    {
      name: "teamKey",
      label: "Team key",
      description: "The short key of the team to watch, such as ENG.",
      value: "",
      required: true,
    },
    {
      name: "projectFilter",
      label: "Project filter",
      description: "Optional. Leave it empty to watch every project.",
      value: "",
      required: false,
    },
  ],
  argumentsJson: "{}",
  cursorArgument: "cursor",
  nextCursorPointer: "/cursor",
  selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/updatedAt" },
  actorPointer: "/actor/id",
  intervalSeconds: 60,
  instruction: "Read the changed items. Tell me what is new and what needs my answer.",
};

/** Installs, updates and links through the preview's event checks, so both show the same checks. */
export function createMockEventCheckTemplates(checks: EventCheckApi): EventCheckTemplateApi {
  const templates = [PREVIEW_EVENT_CHECK_TEMPLATE];
  const template = (slug: string) => {
    const found = templates.find((entry) => entry.slug === slug);
    if (!found) throw new Error("Unknown template.");
    return found;
  };
  const find = async (agentId: string, id: string): Promise<EventCheck> => {
    const found = (await checks.list({ agentId })).find((check) => check.id === id);
    if (!found) throw new Error("Unknown check.");
    return found;
  };
  const link = (entry: EventCheckTemplate) => ({ slug: entry.slug, version: entry.version });
  return {
    list: async () => structuredClone(templates),
    install: async (request) => {
      const entry = template(request.slug);
      const input: EventCheckInput = {
        agentId: request.agentId,
        name: request.name,
        instruction: request.instruction,
        active: false,
        timezone: request.timezone,
        schedule: {
          kind: "interval",
          amount: request.intervalSeconds,
          unit: "seconds",
          anchorAt: new Date().toISOString(),
        },
        selfEvents: {
          mode: "exclude",
          connectionId: request.accountLabel,
          actorPointer: entry.actorPointer,
          accountActorIds: request.accountActorIds,
        },
        source: {
          kind: "api",
          connectionId: request.accountLabel,
          variables: entry.variables.map((variable) => variable.name),
          configuration: entry.configuration.map((field) => ({
            name: field.name,
            label: field.label,
            description: field.description,
            value: request.configuration[field.name] ?? field.value,
          })),
          toolName: entry.program.file,
          argumentsJson: entry.argumentsJson,
          cursorArgument: entry.cursorArgument,
          nextCursorPointer: entry.nextCursorPointer,
          template: link(entry),
        },
        selection: entry.selection,
      };
      return checks.save(input);
    },
    update: async ({ agentId, id }) => {
      const check = await find(agentId, id);
      if (check.source.kind !== "api" || !check.source.template) throw new Error("This check has no template.");
      const entry = template(check.source.template.slug);
      return checks.save({ ...check, source: { ...check.source, template: link(entry) } });
    },
    adopt: async ({ agentId, id, slug }) => {
      const check = await find(agentId, id);
      const entry = template(slug);
      if (check.source.kind !== "api" || check.source.toolName !== entry.program.file)
        throw new Error("This check does not run the program of this template.");
      return checks.save({ ...check, source: { ...check.source, template: link(entry) } });
    },
  };
}
