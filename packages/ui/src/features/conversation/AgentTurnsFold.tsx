import type { AgentActivitySource } from "@openbot/contracts/owner-conversation";
import type { AppTranslate } from "@openbot/i18n";
import { Activity, Button, ChevronDown, LoaderCircle, Marker, MarkerContent, MarkerIcon } from "@openbot/ui";
import { Show } from "solid-js";
import type { AgentProfile, AgentTurnsFold } from "../../data";
import { useText } from "../../text";
import { formatMarkerTimeRange } from "./marker-time";

export interface AgentTurnsFoldMarkerProps {
  fold: AgentTurnsFold;
  agents: AgentProfile[];
  /** Opens or closes the rows of the fold, by its `key`. */
  onToggle: (key: string) => void;
}

/** The name of what woke the agent: a teammate's name, Motion, Atelier, mail or routines. */
function sourceName(source: AgentActivitySource, agents: AgentProfile[], t: AppTranslate): string {
  switch (source.kind) {
    case "agent":
      return agents.find((candidate) => candidate.id === source.agentId)?.name ?? t("chat.marker.unavailableAgent");
    case "motion":
      return t("chat.agentActivity.motion");
    case "atelier":
      return t("chat.agentActivity.atelier");
    case "mail":
      return t("chat.agentActivity.mail");
    case "routine":
      return t("chat.agentActivity.routine");
  }
}

/**
 * A burst of the agent's own activity, drawn as one "Agent activity" row: how many updates, who woke
 * the agent, and when. The timeline draws the rows of the turns under it when it opens. None of it is
 * the owner's conversation, so none of it counts as unread.
 */
export function AgentTurnsFoldMarker(props: AgentTurnsFoldMarkerProps) {
  const { t, format } = useText();
  const sources = () => {
    const names = [...new Set(props.fold.sources.map((source) => sourceName(source, props.agents, t)))];
    return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  };
  const label = () =>
    [t("chat.agentActivity.count", { count: props.fold.count }), sources()].filter(Boolean).join(" · ");
  const time = () => {
    const timestamp = props.fold.timestamp;
    const date = timestamp === undefined ? undefined : new Date(timestamp);
    return timestamp !== undefined && date && !Number.isNaN(date.getTime())
      ? { timestamp, text: formatMarkerTimeRange(props.fold.startTimestamp, timestamp, t, format) }
      : undefined;
  };
  return (
    <Marker
      class="chat-action-marker chat-action-marker-agent-message chat-action-marker-agent-turns"
      role="group"
      aria-label={t("chat.agentActivity.title")}
    >
      <div class="chat-action-marker-summary">
        <MarkerContent class="chat-action-marker-content">
          <Button
            variant="ghost"
            type="button"
            class="chat-action-target"
            aria-expanded={props.fold.expanded ? "true" : "false"}
            aria-label={`${t(props.fold.expanded ? "chat.agentActivity.hide" : "chat.agentActivity.show")}: ${label()}`}
            data-cuelume-tap={props.fold.expanded ? "close" : "open"}
            onClick={() => props.onToggle(props.fold.key)}
          >
            <MarkerIcon>
              <Activity aria-hidden="true" />
            </MarkerIcon>
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
