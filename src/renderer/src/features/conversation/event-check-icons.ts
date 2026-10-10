import type { EventCheckTemplate } from "@openbot/contracts/event-check-templates";
import type { EventCheck } from "@openbot/contracts/event-checks";

/** What a check says about the app it reads: its id and where its events come from. */
export type EventCheckIconCheck = Pick<EventCheck, "id" | "source">;
/** What a template says about its app: the slug that checks name, and its icon. */
export type EventCheckIconTemplate = Pick<EventCheckTemplate, "slug" | "iconUrl">;

/** The two reads that tell which app an event check belongs to. */
export interface EventCheckIconSource {
  listChecks(agentId: string): Promise<readonly EventCheckIconCheck[]>;
  listTemplates(): Promise<readonly EventCheckIconTemplate[]>;
}

/**
 * The address of an icon that the chip may draw. The host decodes a template link as `https://`
 * only; this keeps that rule where the address becomes an image, so a malformed answer from a
 * joined host draws the bell instead.
 */
export function eventCheckIconAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The icon of the app that a check reads, which is the icon of the template that it was made from.
 * A check without a template link, such as one that reads an MCP tool, has none: the chip keeps its
 * bell, because no other field of a check names its app reliably.
 */
export function eventCheckIconUrl(
  check: Pick<EventCheckIconCheck, "source"> | undefined,
  templates: readonly EventCheckIconTemplate[],
): string | null {
  if (check?.source.kind !== "api") return null;
  const slug = check.source.template?.slug;
  if (!slug) return null;
  return eventCheckIconAddress(templates.find((template) => template.slug === slug)?.iconUrl);
}

export interface EventCheckIconLoader {
  /**
   * The icon address for each check id, or null where the check has none or is not known. It reads
   * the checks of the agent when one id is new to it, and the templates once. A failed read throws,
   * and the next call asks again.
   */
  resolve(agentId: string, checkIds: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
}

/**
 * Looks up the icon of the app of event checks, for a host that `source` reads. It keeps what it
 * read, so a chat with many chips costs one list of checks and one list of templates. A check that a
 * fresh list does not hold, such as a deleted one, is not asked for again.
 */
export function createEventCheckIconLoader(source: EventCheckIconSource): EventCheckIconLoader {
  const checksByAgent = new Map<string, Map<string, EventCheckIconCheck>>();
  const absent = new Set<string>();
  let templates: Promise<readonly EventCheckIconTemplate[]> | undefined;
  const absentKey = (agentId: string, checkId: string) => `${agentId}\0${checkId}`;
  const loadTemplates = () => {
    templates ??= source.listTemplates().catch((error: unknown) => {
      templates = undefined;
      throw error;
    });
    return templates;
  };
  return {
    async resolve(agentId, checkIds) {
      let checks = checksByAgent.get(agentId);
      const fresh = checkIds.filter((id) => !checks?.has(id) && !absent.has(absentKey(agentId, id)));
      if (fresh.length > 0) {
        const list = await source.listChecks(agentId);
        checks = new Map(list.map((check) => [check.id, check]));
        checksByAgent.set(agentId, checks);
        for (const id of fresh) if (!checks.has(id)) absent.add(absentKey(agentId, id));
      }
      const linked = checkIds.some((id) => {
        const check = checks?.get(id);
        return check?.source.kind === "api" && check.source.template !== undefined;
      });
      const known = linked ? await loadTemplates() : [];
      return new Map(checkIds.map((id) => [id, eventCheckIconUrl(checks?.get(id), known)]));
    },
  };
}
