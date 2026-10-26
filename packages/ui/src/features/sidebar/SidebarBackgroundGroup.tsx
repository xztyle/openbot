/**
 * "Background teammates": the agents marked as background, after the sections. They work for other
 * agents, so the group starts collapsed and the user opens it only to talk to one. It is not a
 * section of the layout: it has no id, no drag target and no menu, and its rows do not drag.
 *
 * Until the user opens or closes it, the group is open only while one of its agents is the open
 * chat, so the row of that chat shows.
 */

import { Button, ChevronDown } from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { SidebarAgentRow } from "./SidebarAgentRow";
import { useSidebarScope } from "./sidebar-scope";

const BODY_ID = "sidebar-background-group-body";

export function SidebarBackgroundGroup() {
  const { backgroundAgents, props } = useSidebarScope();
  const { t } = useText();
  /** The user's own choice wins once made; until then the open chat decides. */
  const [choice, setChoice] = createSignal<boolean | null>(null);
  const activeInGroup = () => backgroundAgents().some((agent) => agent.id === props.activeAgentId);
  const expanded = () => choice() ?? activeInGroup();
  const waiting = () => backgroundAgents().filter((agent) => props.agentStates[agent.id]?.kind === "waiting").length;
  return (
    <Show when={backgroundAgents().length > 0}>
      <section
        class="sidebar-chat-group sidebar-section"
        aria-label={t("sidebar.background.title", { count: backgroundAgents().length })}
      >
        <header>
          <Button
            variant="ghost"
            type="button"
            class="sidebar-section-toggle"
            aria-expanded={expanded() ? "true" : "false"}
            aria-controls={BODY_ID}
            data-cuelume-open={expanded() ? undefined : ""}
            data-cuelume-close={expanded() ? "" : undefined}
            onClick={() => setChoice(!expanded())}
          >
            <span class="sidebar-section-name">
              {t("sidebar.background.title", { count: backgroundAgents().length })}
            </span>
            <Show when={waiting() > 0}>
              <span class="sidebar-waiting-group-count" title={t("sidebar.background.waiting", { count: waiting() })}>
                {waiting()}
              </span>
            </Show>
            <ChevronDown
              class={`sidebar-section-chevron size-4${expanded() ? "" : " sidebar-section-chevron-collapsed"}`}
              aria-hidden="true"
            />
          </Button>
        </header>
        <div
          class="sidebar-section-collapse"
          data-collapsed={expanded() ? undefined : ""}
          aria-hidden={expanded() ? undefined : "true"}
          inert={expanded() ? undefined : true}
        >
          <div id={BODY_ID} class="sidebar-section-body">
            <For each={backgroundAgents()}>{(agent) => <SidebarAgentRow agent={agent} fixed />}</For>
          </div>
        </div>
      </section>
    </Show>
  );
}
