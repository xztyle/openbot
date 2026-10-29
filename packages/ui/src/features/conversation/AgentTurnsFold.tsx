import { Button, ChevronDown, LoaderCircle, Marker, MarkerContent, MarkerIcon } from "@openbot/ui";
import { Show } from "solid-js";
import type { AgentProfile, AgentTurnsFold } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import { formatChatTimestamp } from "./chat-timestamp";

export interface AgentTurnsFoldMarkerProps {
  fold: AgentTurnsFold;
  agents: AgentProfile[];
  /** Opens or closes the rows of the fold, by its `key`. */
  onToggle: (key: string) => void;
}

/**
 * The turns between this agent and another agent, drawn as one row. The row names the other agent
 * and how many messages there are, and the timeline draws the rows of the turns under it when it opens.
 */
export function AgentTurnsFoldMarker(props: AgentTurnsFoldMarkerProps) {
  const { t, format } = useText();
  const agent = () => props.agents.find((candidate) => candidate.id === props.fold.agentId);
  const agentName = () => agent()?.name ?? t("chat.marker.unavailableAgent");
  const label = () => t("chat.agentTurns.count", { count: props.fold.count, name: agentName() });
  const time = () => {
    const timestamp = props.fold.timestamp;
    const date = timestamp === undefined ? undefined : new Date(timestamp);
    return date && !Number.isNaN(date.getTime()) ? { timestamp, text: formatChatTimestamp(date, format) } : undefined;
  };
  return (
    <Marker
      class="chat-action-marker chat-action-marker-agent-message chat-action-marker-agent-turns"
      role="group"
      aria-label={label()}
    >
      <div class="chat-action-marker-summary">
        <MarkerContent class="chat-action-marker-content">
          <Button
            variant="ghost"
            type="button"
            class="chat-action-target"
            aria-expanded={props.fold.expanded ? "true" : "false"}
            aria-label={t(props.fold.expanded ? "chat.agentTurns.hide" : "chat.agentTurns.show", {
              count: props.fold.count,
              name: agentName(),
            })}
            data-cuelume-tap={props.fold.expanded ? "close" : "open"}
            onClick={() => props.onToggle(props.fold.key)}
          >
            <AgentAvatar agent={agent()} class="chat-action-agent-avatar" />
            <span class="chat-action-target-name">{label()}</span>
            <ChevronDown class="chat-action-agent-turns-chevron" aria-hidden="true" />
          </Button>
          <Show when={props.fold.working}>
            <span class="chat-action-target chat-action-target-unavailable chat-action-target-status-in-progress">
              <MarkerIcon>
                <LoaderCircle aria-hidden="true" />
              </MarkerIcon>
              <span class="chat-action-target-name">{t("chat.agentTurns.working")}</span>
            </span>
          </Show>
          <Show when={time()}>
            {(current) => (
              <time class="chat-action-marker-time" datetime={current().timestamp}>
                {current().text}
              </time>
            )}
          </Show>
        </MarkerContent>
      </div>
    </Marker>
  );
}
