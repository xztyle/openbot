import type { ChannelMember, ChannelTask } from "@openbot/contracts/ipc";
import { Button, buttonVariants, DropdownMenu } from "@openbot/ui";
import { For, Show } from "solid-js";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";

/** One stopped run. `error` is null for a task that the reader stopped: it has no reason of its own. */
export type ChannelStoppedTask = Pick<ChannelTask, "id" | "ownerAgentId" | "error"> & {
  /** What the task was asked to do. The row shows the first line. */
  instruction?: string | undefined;
};

/** The first line of a task instruction that has text, so a long brief does not fill the row. */
function firstLine(text: string | undefined): string {
  return (
    text
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/**
 * The runs that wait for the reader: who owned the task, what it was, why it stopped, and what to
 * do about it. A task the reader stopped says so; a task the channel stopped carries its reason.
 */
export function ChannelStoppedTasks(props: {
  tasks: ChannelStoppedTask[];
  members: Pick<ChannelMember, "agentId">[];
  agents?: readonly AgentProfile[] | undefined;
  name: (agentId: string | null) => string;
  onResume: (taskId: string, recipientAgentId: string | null) => Promise<boolean>;
  /** Opens the chat of the owner. Left out, the row has no such button. */
  onOpenChat?: ((agentId: string) => void) | undefined;
}) {
  const { t, sourceText } = useText();
  const agentFor = (agentId: string | null) => props.agents?.find((agent) => agent.id === agentId);
  return (
    <Show when={props.tasks.length}>
      <div class="channel-paused-tasks">
        <For each={props.tasks}>
          {(task) => (
            <section
              class="channel-paused-task"
              aria-label={t("channel.stoppedTask.label", { name: props.name(task.ownerAgentId) })}
            >
              <div class="channel-paused-task-owner">
                <AgentAvatar
                  agent={agentFor(task.ownerAgentId)}
                  seed={agentFor(task.ownerAgentId) ? undefined : (task.ownerAgentId ?? undefined)}
                  class="channel-paused-task-avatar"
                />
                <span class="channel-paused-task-name">{props.name(task.ownerAgentId)}</span>
                <Show when={firstLine(task.instruction)}>
                  {(line) => <span class="channel-paused-task-instruction">{line()}</span>}
                </Show>
              </div>
              <p class="channel-paused-task-reason">
                {task.error ? sourceText(task.error) : t("channel.stoppedTask.byUser")}
              </p>
              <div class="channel-paused-task-actions">
                <Button size="xs" onClick={() => void props.onResume(task.id, null)}>
                  {t("common.continue")}
                </Button>
                <DropdownMenu.Root placement="top-start">
                  <DropdownMenu.Trigger
                    class={buttonVariants({ variant: "ghost", size: "xs" })}
                    aria-label={t("channel.stoppedTask.reassignLabel", { name: props.name(task.ownerAgentId) })}
                  >
                    {t("channel.stoppedTask.reassign")}
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content>
                      <For each={props.members.filter((member) => member.agentId !== task.ownerAgentId)}>
                        {(member) => (
                          <DropdownMenu.Item onSelect={() => void props.onResume(task.id, member.agentId)}>
                            {props.name(member.agentId)}
                          </DropdownMenu.Item>
                        )}
                      </For>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <Show when={task.ownerAgentId && agentFor(task.ownerAgentId) && props.onOpenChat}>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={t("channel.stoppedTask.openChatLabel", { name: props.name(task.ownerAgentId) })}
                    onClick={() => {
                      const ownerId = task.ownerAgentId;
                      if (ownerId) props.onOpenChat?.(ownerId);
                    }}
                  >
                    {t("channel.stoppedTask.openChat")}
                  </Button>
                </Show>
              </div>
            </section>
          )}
        </For>
      </div>
    </Show>
  );
}
