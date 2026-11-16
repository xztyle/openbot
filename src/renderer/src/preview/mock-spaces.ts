// The spaces of the preview, as a host keeps them: General first, the agents and channels that no one
// moved in it, and the same checks for a delete and an order. The preview has no agents of its own
// that tools could reach, so it keeps only the assignments.
import {
  type AgentEvent,
  GENERAL_SPACE_ID,
  type WorkspaceSpace,
  type WorkspaceSpaceAction,
  type WorkspaceSpaceActionResult,
  type WorkspaceSpaces,
} from "@openbot/contracts/ipc";

/** A space the preview starts with, and the agents and channels in it. */
export interface MockSpaceSeed {
  space: Omit<WorkspaceSpace, "position" | "slug"> & { slug?: string };
  agentIds?: string[];
  channelIds?: string[];
}

export function createMockSpaces(
  emit: (event: AgentEvent) => void,
  agentIds: () => readonly string[],
  channelIds: () => readonly string[],
  seeds: readonly MockSpaceSeed[] = [],
) {
  let spaces: WorkspaceSpace[] = [
    { id: GENERAL_SPACE_ID, name: "General", slug: GENERAL_SPACE_ID, icon: null, hue: null, position: 0 },
    ...seeds.map((seed, index) => ({
      ...seed.space,
      slug: seed.space.slug ?? seed.space.id,
      position: index + 1,
    })),
  ];
  const agents = new Map<string, string>(
    seeds.flatMap((seed) => (seed.agentIds ?? []).map((id) => [id, seed.space.id])),
  );
  const channels = new Map<string, string>(
    seeds.flatMap((seed) => (seed.channelIds ?? []).map((id) => [id, seed.space.id])),
  );
  const snapshot = (): WorkspaceSpaces => ({
    spaces: structuredClone(spaces),
    agents: agentIds().map((id) => ({ id, spaceId: agents.get(id) ?? GENERAL_SPACE_ID })),
    channels: channelIds().map((id) => ({ id, spaceId: channels.get(id) ?? GENERAL_SPACE_ID })),
  });
  const requireSpace = (spaceId: string) => {
    if (!spaces.some((space) => space.id === spaceId)) throw new Error("This space no longer exists.");
  };
  const apply = (action: WorkspaceSpaceAction): string | undefined => {
    switch (action.kind) {
      case "create": {
        const id = crypto.randomUUID().replaceAll("-", "");
        spaces = [
          ...spaces,
          {
            id,
            name: action.name,
            slug: id,
            icon: action.icon ?? null,
            hue: action.hue ?? null,
            position: spaces.length,
          },
        ];
        return id;
      }
      case "update":
        requireSpace(action.spaceId);
        spaces = spaces.map((space) =>
          space.id === action.spaceId
            ? {
                ...space,
                ...(action.name === undefined ? {} : { name: action.name }),
                ...(action.icon === undefined ? {} : { icon: action.icon }),
                ...(action.hue === undefined ? {} : { hue: action.hue }),
              }
            : space,
        );
        return undefined;
      case "reorder":
        spaces = action.spaceIds.flatMap((id, position) => {
          const space = spaces.find((entry) => entry.id === id);
          return space ? [{ ...space, position }] : [];
        });
        return undefined;
      case "move":
        requireSpace(action.spaceId);
        for (const id of action.agentIds ?? []) agents.set(id, action.spaceId);
        for (const id of action.channelIds ?? []) channels.set(id, action.spaceId);
        return undefined;
      case "place-channel":
        requireSpace(action.spaceId);
        channels.set(action.channelId, action.spaceId);
        return undefined;
      case "delete": {
        if (action.spaceId === GENERAL_SPACE_ID) throw new Error("The General space cannot be deleted.");
        const target = action.moveTo;
        for (const map of [agents, channels])
          for (const [id, spaceId] of map)
            if (spaceId === action.spaceId) {
              if (target === undefined) throw new Error("Move the agents and channels of this space first.");
              map.set(id, target);
            }
        spaces = spaces.filter((space) => space.id !== action.spaceId);
        return undefined;
      }
    }
  };
  return {
    workspaceSpaces: async (): Promise<WorkspaceSpaces> => snapshot(),
    workspaceSpaceAction: async (action: WorkspaceSpaceAction): Promise<WorkspaceSpaceActionResult> => {
      const created = apply(action);
      emit({ type: "workspace-spaces-changed" });
      return { ...snapshot(), ...(created ? { createdSpaceId: created } : {}) };
    },
    /** Puts an agent that the preview just made in a space. */
    place: (agentId: string, spaceId: string | undefined) => {
      if (spaceId && spaceId !== GENERAL_SPACE_ID) agents.set(agentId, spaceId);
    },
  };
}
