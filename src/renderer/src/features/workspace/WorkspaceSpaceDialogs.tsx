import { DeleteSpaceDialog, MoveToSpaceDialog, SpaceDialog } from "@openbot/ui/features/spaces/SpaceDialogs";
import { useText } from "@openbot/ui/text";
import { createMemo, Match, Switch, untrack } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { conversationName } from "./workspace-model";

/**
 * The dialogs that make, change, delete and fill spaces. Each reads its match once: a dialog still
 * reads its props while it closes, after the match is gone.
 */
export function WorkspaceSpaceDialogs() {
  const { t } = useText();
  const ws = useWorkspace();
  const close = () => ws.openDialog(null);
  const dialog = () => ws.state.dialog;
  const options = createMemo(() => ws.spaces.list().map((space) => ({ id: space.id, name: space.name })));
  return (
    <Switch>
      <Match
        when={(() => {
          const current = dialog();
          return current?.kind === "space-edit" ? current : undefined;
        })()}
      >
        {(current) => {
          const spaceId = untrack(() => current().spaceId);
          const space = untrack(() => (spaceId ? ws.spaces.space(spaceId) : undefined));
          return (
            <SpaceDialog
              open
              initial={space ? { name: space.name, icon: space.icon, hue: space.hue } : null}
              onOpenChange={(open) => {
                if (!open) close();
              }}
              onSave={async (draft) => {
                if (spaceId) {
                  await ws.spaces.act({ kind: "update", spaceId, ...draft });
                  return;
                }
                const result = await ws.spaces.act({ kind: "create", ...draft });
                if (result.createdSpaceId) ws.selectSpace(result.createdSpaceId);
              }}
            />
          );
        }}
      </Match>
      <Match
        when={(() => {
          const current = dialog();
          return current?.kind === "space-delete" ? current : undefined;
        })()}
      >
        {(current) => {
          const deleted = untrack(() => current().spaceId);
          const name = untrack(() => ws.spaces.space(deleted)?.name ?? "");
          const agentCount = () => ws.env.agents().filter((agent) => ws.spaces.agentSpace(agent.id) === deleted).length;
          const channelCount = () =>
            ws.channels.state.channels.filter(
              (channel) => !ws.soleAgent(channel) && ws.spaces.channelSpace(channel.id) === deleted,
            ).length;
          return (
            <DeleteSpaceDialog
              open
              name={name}
              agentCount={agentCount()}
              channelCount={channelCount()}
              spaces={options().filter((space) => space.id !== deleted)}
              onOpenChange={(open) => {
                if (!open) close();
              }}
              onDelete={async (moveTo) => {
                await ws.spaces.act({ kind: "delete", spaceId: deleted, ...(moveTo ? { moveTo } : {}) });
                if (ws.spaces.current() === deleted) ws.selectSpace(moveTo ?? options()[0]?.id ?? "");
              }}
            />
          );
        }}
      </Match>
      <Match
        when={(() => {
          const current = dialog();
          return current?.kind === "space-move" ? current : undefined;
        })()}
      >
        {(current) => {
          const agentIds = untrack(() => [...current().agentIds]);
          const channelIds = untrack(() => [...current().channelIds]);
          const subject = untrack(() => {
            if (agentIds.length + channelIds.length !== 1)
              return t("workspace.spaces.agentCount", { count: agentIds.length + channelIds.length });
            const agentId = agentIds[0];
            if (agentId) return ws.env.agents().find((agent) => agent.id === agentId)?.name ?? agentId;
            const channel = ws.summary(channelIds[0] ?? "");
            return channel ? conversationName(ws.directory(), channel) : (channelIds[0] ?? "");
          });
          const from = untrack(() => {
            const agentId = agentIds[0];
            return agentId ? ws.spaces.agentSpace(agentId) : ws.spaces.channelSpace(channelIds[0] ?? "");
          });
          return (
            <MoveToSpaceDialog
              open
              subject={subject}
              currentId={from}
              spaces={options()}
              onOpenChange={(open) => {
                if (!open) close();
              }}
              onMove={(spaceId) =>
                ws.moveToSpace(
                  { ...(agentIds.length ? { agentIds } : {}), ...(channelIds.length ? { channelIds } : {}) },
                  spaceId,
                )
              }
            />
          );
        }}
      </Match>
    </Switch>
  );
}
