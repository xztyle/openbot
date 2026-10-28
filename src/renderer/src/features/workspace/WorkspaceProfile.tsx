import { MemberProfileCard } from "@openbot/ui/features/workspace/MemberProfileCard";
import type {
  AgentComputerPart,
  AgentWorkStatus,
  WorkspaceMember,
} from "@openbot/ui/features/workspace/workspace-types";
import { createMemo, Show } from "solid-js";
import { useWorkspace } from "./workspace-context";

/** Every agent has its own computer: a browser, a shell, the performance bench and app hosting. */
const AGENT_COMPUTER: readonly AgentComputerPart[] = ["browser", "shell", "bench", "hosting"];

/** The profile card of a member: a person's role and presence, or an agent's work, model and computer. */
export function MemberProfile(props: { member: WorkspaceMember }) {
  const ws = useWorkspace();
  const agent = createMemo(() =>
    props.member.kind === "agent" ? ws.env.agents().find((candidate) => candidate.id === props.member.id) : undefined,
  );
  const person = createMemo(() =>
    props.member.kind === "human" ? ws.env.people().find((candidate) => candidate.id === props.member.id) : undefined,
  );
  const status = createMemo((): AgentWorkStatus | undefined => {
    if (!agent()) return undefined;
    const fleet = ws.fleet.agents().find((entry) => entry.member.id === props.member.id);
    return fleet?.status;
  });
  const external = () => props.member.external === true;
  const self = () => props.member.kind === "human" && ws.env.isReader(props.member.id);
  return (
    <Show
      when={agent()}
      fallback={
        <MemberProfileCard
          member={props.member}
          workspaceRole={person()?.role}
          onMessage={external() || self() ? undefined : () => ws.messageMember(props.member.id)}
        />
      }
    >
      {(profile) => (
        <MemberProfileCard
          member={props.member}
          title={profile().title || undefined}
          description={profile().description || undefined}
          model={`${profile().provider} · ${profile().model}`}
          status={status()}
          computer={AGENT_COMPUTER}
          onMessage={() => ws.openAgent(profile().id)}
          onSettings={() => ws.env.openAgentSettings(profile().id)}
        />
      )}
    </Show>
  );
}
