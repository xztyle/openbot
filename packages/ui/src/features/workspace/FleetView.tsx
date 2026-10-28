import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { Input } from "../../form";
import { Activity, LayoutDashboard, List, MessageSquare, Search, Send, Settings } from "../../icons";
import { SlidingTabs } from "../../sliding-tabs";
import { useText } from "../../text";
import { cx } from "../../utils";
import { AgentStatusLine } from "./MemberProfileCard";
import { AiBadge, MemberAvatar } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useCost, useWorkspaceDuration } from "./workspace-format";
import type { AgentWorkStatus, WorkspaceMember } from "./workspace-types";

export interface FleetAgent {
  member: WorkspaceMember;
  title?: string | undefined;
  status: AgentWorkStatus;
  /** The step that runs now, such as "Searching the web for platformer level ideas". */
  currentStep?: string | undefined;
  todayCostUsd?: number | undefined;
  todayDurationMs?: number | undefined;
}

type FleetFilter = "all" | AgentWorkStatus["state"];

export interface FleetViewProps {
  agents: readonly FleetAgent[];
  onMessage?: ((agentId: string) => void) | undefined;
  onAssign?: ((agentId: string) => void) | undefined;
  onSettings?: ((agentId: string) => void) | undefined;
  /** Adds an agent to the workspace. */
  onAddAgent?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  class?: string;
}

/** The command center: every agent, what it does now, and what it cost today. */
export function FleetView(props: FleetViewProps): JSX.Element {
  const { t } = useText();
  const cost = useCost();
  const duration = useWorkspaceDuration();
  const [filter, setFilter] = createSignal<FleetFilter>("all");
  const [layout, setLayout] = createSignal<"grid" | "list">("grid");
  const [query, setQuery] = createSignal("");
  const count = (state: FleetFilter) =>
    state === "all" ? props.agents.length : props.agents.filter((agent) => agent.status.state === state).length;
  const shown = () => {
    const text = query().trim().toLocaleLowerCase();
    return props.agents.filter(
      (agent) =>
        (filter() === "all" || agent.status.state === filter()) &&
        (!text ||
          agent.member.name.toLocaleLowerCase().includes(text) ||
          (agent.title?.toLocaleLowerCase().includes(text) ?? false)),
    );
  };
  const totals = () => ({
    cost: props.agents.reduce((sum, agent) => sum + (agent.todayCostUsd ?? 0), 0),
    time: props.agents.reduce((sum, agent) => sum + (agent.todayDurationMs ?? 0), 0),
  });
  return (
    <section class={cx("ws-view ws-fleet", props.class)} aria-label={t("workspace.view.fleet")}>
      <WorkspacePaneHeader
        icon={<Activity aria-hidden="true" />}
        title={t("workspace.view.fleet")}
        subtitle={t("workspace.fleet.today", { cost: cost(totals().cost), time: duration(totals().time) })}
        onBack={props.onBack}
        actions={
          <Show when={props.onAddAgent}>
            {(add) => (
              <Button size="xs" onClick={() => add()()}>
                {t("workspace.fleet.addAgent")}
              </Button>
            )}
          </Show>
        }
      />
      <div class="ws-view-toolbar">
        <SlidingTabs.Root
          value={filter()}
          onChange={(value) => {
            if (value === "all" || value === "working" || value === "waiting" || value === "idle") setFilter(value);
          }}
        >
          <SlidingTabs.List aria-label={t("workspace.fleet.filter")}>
            <SlidingTabs.Trigger value="all">{t("workspace.fleet.all", { count: count("all") })}</SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="working">
              {t("workspace.fleet.working", { count: count("working") })}
            </SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="waiting">
              {t("workspace.fleet.waiting", { count: count("waiting") })}
            </SlidingTabs.Trigger>
            <SlidingTabs.Trigger value="idle">
              {t("workspace.fleet.idle", { count: count("idle") })}
            </SlidingTabs.Trigger>
          </SlidingTabs.List>
        </SlidingTabs.Root>
        <div class="ws-view-search">
          <Search aria-hidden="true" />
          <Input
            size="sm"
            value={query()}
            aria-label={t("workspace.fleet.search")}
            placeholder={t("workspace.fleet.search")}
            onValueChange={setQuery}
          />
        </div>
        <div class="ws-view-layout-toggle">
          <IconButton
            variant="ghost"
            size="icon-xs"
            label={t("workspace.layout.grid")}
            aria-pressed={layout() === "grid" ? "true" : "false"}
            onClick={() => setLayout("grid")}
          >
            <LayoutDashboard />
          </IconButton>
          <IconButton
            variant="ghost"
            size="icon-xs"
            label={t("workspace.layout.list")}
            aria-pressed={layout() === "list" ? "true" : "false"}
            onClick={() => setLayout("list")}
          >
            <List />
          </IconButton>
        </div>
      </div>
      <div class="ws-view-scroll">
        <Show when={shown().length > 0} fallback={<p class="ws-view-empty">{t("workspace.fleet.empty")}</p>}>
          <ul class="ws-fleet-list" data-layout={layout()}>
            <For each={shown()} keyed={(agent) => agent.member.id}>
              {(agent) => (
                <li class="ws-fleet-card" data-state={agent().status.state}>
                  <div class="ws-fleet-card-identity">
                    <MemberAvatar
                      member={{ ...agent().member, working: agent().status.state === "working" }}
                      size="lg"
                      animate
                    />
                    <span class="ws-fleet-card-copy">
                      <span class="ws-fleet-card-name">
                        {agent().member.name}
                        <AiBadge />
                      </span>
                      <Show when={agent().title}>
                        <span class="ws-fleet-card-title">{agent().title}</span>
                      </Show>
                    </span>
                  </div>
                  <AgentStatusLine status={agent().status} />
                  <Show when={agent().currentStep}>
                    <p class="ws-fleet-card-step">{agent().currentStep}</p>
                  </Show>
                  <dl class="ws-fleet-card-stats">
                    <div>
                      <dt>{t("workspace.fleet.costToday")}</dt>
                      <dd>{cost(agent().todayCostUsd ?? 0)}</dd>
                    </div>
                    <div>
                      <dt>{t("workspace.fleet.timeToday")}</dt>
                      <dd>{duration(agent().todayDurationMs ?? 0)}</dd>
                    </div>
                  </dl>
                  <div class="ws-fleet-card-actions">
                    <Show when={props.onMessage}>
                      <Button variant="secondary" size="xs" onClick={() => props.onMessage?.(agent().member.id)}>
                        <MessageSquare aria-hidden="true" />
                        {t("workspace.fleet.message")}
                      </Button>
                    </Show>
                    <Show when={props.onAssign}>
                      <Button variant="ghost" size="xs" onClick={() => props.onAssign?.(agent().member.id)}>
                        <Send aria-hidden="true" />
                        {t("workspace.fleet.assign")}
                      </Button>
                    </Show>
                    <Show when={props.onSettings}>
                      <IconButton
                        variant="ghost"
                        size="icon-xs"
                        label={t("workspace.fleet.settings", { name: agent().member.name })}
                        onClick={() => props.onSettings?.(agent().member.id)}
                      >
                        <Settings />
                      </IconButton>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </section>
  );
}
