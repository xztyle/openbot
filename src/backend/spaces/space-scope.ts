import type { SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import type { SpaceChannel, SpaceStore } from "./space-store";

// The rule that agents see and reach only their own space, as each agent tool applies it. A tool names
// the agents it acts on in these arguments; an agent id in any of them that is in another space refuses
// the whole call, before the tool reads anything.

const AGENT_ARGUMENTS = ["agentId", "recipientAgentId", "fromAgentId", "toAgentId", "targetAgentId"] as const;
const AGENT_LIST_ARGUMENTS = ["agentIds", "recipientAgentIds"] as const;

/** Every agent id that the tool arguments name. */
export function namedAgentIds(args: unknown): string[] {
  if (!isDynamicRecord(args)) return [];
  const ids: string[] = [];
  for (const key of AGENT_ARGUMENTS) {
    const value = args[key];
    if (isString(value)) ids.push(value);
  }
  for (const key of AGENT_LIST_ARGUMENTS) {
    const value = args[key];
    if (Array.isArray(value)) ids.push(...value.filter(isString));
  }
  return ids;
}

/**
 * The refusal for a tool call that names an existing agent of another space, or null. An id that names
 * no agent is left to the tool, which reports it as it did before.
 */
export function crossSpaceRefusal(
  spaces: Pick<SpaceStore, "sameSpace">,
  callerAgentId: string,
  args: unknown,
  agentExists: (agentId: string) => boolean,
): string | null {
  const foreign = namedAgentIds(args).find(
    (id) => id !== callerAgentId && agentExists(id) && !spaces.sameSpace(callerAgentId, id),
  );
  return foreign === undefined ? null : sourceText("error.backend.spaceOtherAgent", { agent: foreign });
}

/** Whether the agent may use the channel: it is in the agent's space. */
export function agentSeesChannel(
  spaces: Pick<SpaceStore, "agentSpaceId" | "channelSpaceId">,
  agentId: string,
  channel: SpaceChannel,
): boolean {
  return spaces.agentSpaceId(agentId) === spaces.channelSpaceId(channel);
}

/**
 * The sidebar layout that an agent reads: the agents and channels of its space, and the sections that
 * hold one of them or nothing at all. A section of another space, and its name, stays out.
 */
export function layoutForSpace(layout: SidebarLayoutSnapshot, visible: (id: string) => boolean): SidebarLayoutSnapshot {
  const assignments = Object.entries(layout.agentAssignments);
  const used = new Set(assignments.map(([, sectionId]) => sectionId));
  const shown = new Set(assignments.filter(([id]) => visible(id)).map(([, sectionId]) => sectionId));
  const sections = layout.sections.filter((section) => shown.has(section.id) || !used.has(section.id));
  const hidden = new Set(layout.sections.map((section) => section.id));
  for (const section of sections) hidden.delete(section.id);
  return {
    ...layout,
    sections,
    order: layout.order.filter((id) => !hidden.has(id)),
    agentAssignments: Object.fromEntries(assignments.filter(([id]) => visible(id))),
    agentOrder: layout.agentOrder.filter(visible),
  };
}

/** Whether every item in the section is visible, so an agent may rename or delete it. */
export function sectionInSpace(layout: SidebarLayoutSnapshot, sectionId: string, visible: (id: string) => boolean) {
  return Object.entries(layout.agentAssignments).every(([id, section]) => section !== sectionId || visible(id));
}
