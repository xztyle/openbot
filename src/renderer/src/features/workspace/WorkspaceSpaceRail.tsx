import { GENERAL_SPACE_ID } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { SpaceRail, type SpaceRailItem } from "@openbot/ui/features/spaces/SpaceRail";
import { useText } from "@openbot/ui/text";
import { createMemo } from "solid-js";
import { useWorkspace } from "./workspace-context";

/** The rail of the host's spaces beside the workspace sidebar. */
export function WorkspaceSpaceRail() {
  const ws = useWorkspace();
  const { t } = useText();
  /** The spaces whose agents all sleep. */
  const sleepingSpaces = createMemo(() => {
    const awake = new Set<string>();
    const asleep = new Set<string>();
    for (const agent of ws.env.agents()) {
      const space = ws.spaces.agentSpace(agent.id);
      if (agent.sleepingSince === undefined) awake.add(space);
      else asleep.add(space);
    }
    return new Set([...asleep].filter((space) => !awake.has(space)));
  });
  async function sleep(spaceId: string, sleeping: boolean) {
    const calls = ws.env.efficiency?.();
    if (!calls) return;
    try {
      const result = await calls.sleep({ kind: "space", id: spaceId }, sleeping);
      const count = result.changedAgentIds.length;
      toast(sleeping ? t("efficiency.sleep.done", { count }) : t("efficiency.sleep.woke", { count }));
    } catch (error) {
      toast.error(t("efficiency.sleep.failed"), { error, fallback: t("efficiency.sleep.failed") });
    }
  }
  const items = createMemo((): SpaceRailItem[] =>
    ws.spaces.list().map((space) => {
      const unread = ws.spaceUnread().get(space.id);
      return {
        id: space.id,
        name: space.name,
        icon: space.icon,
        hue: space.hue,
        unread: unread?.unread ?? false,
        mentionCount: unread?.mentions ?? 0,
        general: space.id === GENERAL_SPACE_ID,
        sleeping: sleepingSpaces().has(space.id),
      };
    }),
  );
  function move(spaceId: string, direction: -1 | 1) {
    const ids = items().map((space) => space.id);
    const from = ids.indexOf(spaceId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, spaceId);
    void ws.spaces.act({ kind: "reorder", spaceIds: ids }).catch(ws.spaceFailure);
  }
  return (
    <SpaceRail
      spaces={items()}
      activeId={ws.spaces.current()}
      onSelect={(spaceId) => ws.selectSpace(spaceId)}
      onOpenAgents={(spaceId) => {
        ws.selectSpace(spaceId);
        ws.openView("space-agents");
      }}
      onSleep={ws.env.efficiency?.() ? (spaceId, sleeping) => void sleep(spaceId, sleeping) : undefined}
      manage={
        ws.isAdmin()
          ? {
              onCreate: () => ws.openDialog({ kind: "space-edit", spaceId: null }),
              onEdit: (spaceId) => ws.openDialog({ kind: "space-edit", spaceId }),
              onDelete: (spaceId) => ws.openDialog({ kind: "space-delete", spaceId }),
              onMove: move,
            }
          : undefined
      }
    />
  );
}
