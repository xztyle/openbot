import type { JSX } from "@solidjs/web";
import { Button } from "../../button";
import { ChevronDown } from "../../icons";
import { useText } from "../../text";
import { AvatarStack } from "./WorkspaceAvatar";
import type { WorkspaceMember } from "./workspace-types";

/**
 * Several agents at work in one place, as one line: their stacked faces and "4 agents working". It
 * opens the line of each agent, with its steps and its Stop, under it.
 */
export function AgentWorkGroup(props: {
  members: readonly WorkspaceMember[];
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { t, format } = useText();
  return (
    <Button
      variant="ghost"
      size="xs"
      class="ws-typing-group"
      aria-expanded={props.open ? "true" : "false"}
      title={format.list(props.members.map((member) => member.name))}
      onClick={() => props.onToggle()}
    >
      <AvatarStack members={props.members} max={4} size="xs" />
      <span class="ws-typing-agent-text">{t("workspace.typing.agentsWorking", { count: props.members.length })}</span>
      <ChevronDown class="ws-typing-group-chevron" aria-hidden="true" />
    </Button>
  );
}
