/**
 * The right panel of the org chart: what the agent does now, its manager and its reports, and the
 * actions Open chat and Change manager. The manager picker lists the agents that would not make a
 * loop, and "No manager" first.
 */

import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Button } from "../../button";
import { Input } from "../../form";
import { Check, MessageSquare, Search, ShieldCheck, UserRoundCog } from "../../icons";
import { useText } from "../../text";
import { AgentStatusLine } from "../workspace/MemberProfileCard";
import { AiBadge, MemberAvatar } from "../workspace/WorkspaceAvatar";
import { WorkspacePaneHeader } from "../workspace/WorkspacePaneHeader";
import type { OrgChartAgent } from "./OrgChartView";
import { type OrgChartNodeInput, orgChartSubtree } from "./org-chart-layout";

export interface OrgChartPanelProps {
  agent: OrgChartAgent;
  agents: readonly OrgChartAgent[];
  /** The resolved managers, for the reports and the agents that the picker leaves out. */
  layoutInput: readonly OrgChartNodeInput[];
  canChangeManager: boolean;
  onOpenChat: () => void;
  /** Centres another agent's card and shows its panel. */
  onJump: (agentId: string) => void;
  onChangeManager: (managerId: string | null) => Promise<void>;
  /** Puts this agent and its reports to sleep, or wakes them. */
  onSleepTeam?: ((sleeping: boolean) => Promise<void>) | undefined;
  /** Opens what the agent may do: its trust rules and budgets. Absent, there is no button. */
  onOpenPermissions?: (() => void) | undefined;
  onClose: () => void;
}

export function OrgChartPanel(props: OrgChartPanelProps): JSX.Element {
  const { t, errorMessage } = useText();
  const [picking, setPicking] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const byId = createMemo(() => new Map(props.agents.map((agent) => [agent.member.id, agent])));
  const manager = () => (props.agent.managerId ? byId().get(props.agent.managerId) : undefined);
  const reports = createMemo(() => props.agents.filter((agent) => agent.managerId === props.agent.member.id));
  /** Every agent that may become the manager: not this agent and not one that reports to it. */
  const candidates = createMemo(() => {
    const blocked = orgChartSubtree(props.layoutInput, props.agent.member.id);
    const text = query().trim().toLocaleLowerCase();
    return props.agents.filter(
      (agent) =>
        !blocked.has(agent.member.id) &&
        (!text ||
          agent.member.name.toLocaleLowerCase().includes(text) ||
          (agent.title?.toLocaleLowerCase().includes(text) ?? false)),
    );
  });
  const pick = async (managerId: string | null) => {
    if (managerId === props.agent.managerId) {
      setPicking(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await props.onChangeManager(managerId);
      setPicking(false);
      setQuery("");
    } catch (failure) {
      setError(errorMessage(failure, t("workspace.org.moveFailed")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section class="ws-org-panel-body" aria-label={props.agent.member.name}>
      <WorkspacePaneHeader title={props.agent.member.name} subtitle={props.agent.title} onClose={props.onClose} />
      <div class="ws-org-panel-scroll">
        <div class="ws-org-panel-identity" data-state={props.agent.state}>
          <MemberAvatar
            member={{ ...props.agent.member, working: props.agent.state === "working" }}
            size="xl"
            showStatus
            animate
          />
          <div class="ws-org-panel-name">
            <strong>{props.agent.member.name}</strong>
            <AiBadge />
          </div>
          <Show when={props.agent.model}>
            <span class="ws-org-chip">
              {props.agent.effort ? `${props.agent.model} · ${props.agent.effort}` : props.agent.model}
            </span>
          </Show>
        </div>
        <div class="ws-org-panel-actions">
          <Button size="sm" onClick={() => props.onOpenChat()}>
            <MessageSquare aria-hidden="true" />
            {t("workspace.org.openChat")}
          </Button>
          <Show when={props.onSleepTeam}>
            {(sleepTeam) => (
              <Button
                size="sm"
                variant="secondary"
                disabled={saving()}
                onClick={() => {
                  setSaving(true);
                  void sleepTeam()(!props.agent.sleeping).finally(() => setSaving(false));
                }}
              >
                {props.agent.sleeping ? t("efficiency.sleep.teamWake") : t("efficiency.sleep.team")}
              </Button>
            )}
          </Show>
          <Show when={props.onOpenPermissions}>
            {(open) => (
              <Button size="sm" variant="secondary" onClick={() => open()()}>
                <ShieldCheck aria-hidden="true" />
                {t("trust.org.permissions")}
              </Button>
            )}
          </Show>
          <Show when={props.canChangeManager}>
            <Button
              size="sm"
              variant="secondary"
              aria-expanded={picking() ? "true" : "false"}
              onClick={() => {
                setPicking(!picking());
                setError(null);
              }}
            >
              <UserRoundCog aria-hidden="true" />
              {t("workspace.org.changeManager")}
            </Button>
          </Show>
        </div>

        <Show when={picking()}>
          <div class="ws-org-picker">
            <div class="ws-view-search ws-org-picker-search">
              <Search aria-hidden="true" />
              <Input
                size="sm"
                autofocus
                value={query()}
                aria-label={t("workspace.org.managerSearch")}
                placeholder={t("workspace.org.managerSearch")}
                onValueChange={setQuery}
              />
            </div>
            <ul class="ws-org-panel-list">
              <li>
                <Button
                  variant="ghost"
                  class="ws-picker-row ws-org-panel-row"
                  aria-pressed={props.agent.managerId === null ? "true" : "false"}
                  disabled={saving()}
                  onClick={() => void pick(null)}
                >
                  <span class="ws-org-panel-top" aria-hidden="true" />
                  <span class="ws-picker-name">{t("workspace.org.topLevel")}</span>
                  <Show when={props.agent.managerId === null}>
                    <span class="ws-picker-check" aria-hidden="true">
                      <Check />
                    </span>
                  </Show>
                </Button>
              </li>
              <For each={candidates()} keyed={(agent) => agent.member.id}>
                {(agent) => (
                  <PanelRow
                    agent={agent()}
                    disabled={saving()}
                    pressed={agent().member.id === props.agent.managerId}
                    onClick={() => void pick(agent().member.id)}
                  />
                )}
              </For>
            </ul>
            <Show when={error()}>{(message) => <p class="ws-org-panel-error">{message()}</p>}</Show>
          </div>
        </Show>

        <section class="ws-org-panel-section">
          <h3>{t("workspace.org.panel.now")}</h3>
          <Show when={props.agent.state !== "idle" ? props.agent.status : undefined}>
            {(status) => <AgentStatusLine status={status()} />}
          </Show>
          <Show
            when={props.agent.activity}
            fallback={
              <Show when={props.agent.state === "idle"}>
                <p class="ws-org-panel-muted">{t("workspace.org.panel.idle")}</p>
              </Show>
            }
          >
            {(activity) => <p class="ws-org-panel-step">{activity()}</p>}
          </Show>
          <Show when={props.agent.state === "failed"}>
            <p class="ws-org-panel-failed">{t("workspace.org.state.failed")}</p>
          </Show>
          <Show when={props.agent.queued}>
            {(queued) => <span class="ws-org-chip">{t("workspace.org.queued", { count: queued() })}</span>}
          </Show>
        </section>

        <Show when={props.agent.preview}>
          {(preview) => (
            <section class="ws-org-panel-section">
              <h3>{t("workspace.org.panel.lastMessage")}</h3>
              <p class="ws-org-panel-preview">{preview()}</p>
            </section>
          )}
        </Show>

        <section class="ws-org-panel-section">
          <h3>{t("workspace.org.panel.manager")}</h3>
          <Show when={manager()} fallback={<p class="ws-org-panel-muted">{t("workspace.org.topLevel")}</p>}>
            {(current) => (
              <ul class="ws-org-panel-list">
                <PanelRow agent={current()} onClick={() => props.onJump(current().member.id)} />
              </ul>
            )}
          </Show>
        </section>

        <section class="ws-org-panel-section">
          <h3>
            {t("workspace.org.panel.reports")}
            <Show when={reports().length > 0}>
              <span class="ws-org-panel-count">{reports().length}</span>
            </Show>
          </h3>
          <Show
            when={reports().length > 0}
            fallback={<p class="ws-org-panel-muted">{t("workspace.org.panel.noReports")}</p>}
          >
            <ul class="ws-org-panel-list">
              <For each={reports()} keyed={(agent) => agent.member.id}>
                {(agent) => <PanelRow agent={agent()} onClick={() => props.onJump(agent().member.id)} />}
              </For>
            </ul>
          </Show>
        </section>
      </div>
    </section>
  );
}

/** An agent in a list of the panel: its face, name, title and a dot for its state. */
function PanelRow(props: {
  agent: OrgChartAgent;
  onClick: () => void;
  /** Set in the manager picker: the current manager is pressed. */
  pressed?: boolean | undefined;
  disabled?: boolean | undefined;
}): JSX.Element {
  return (
    <li>
      <Button
        variant="ghost"
        class="ws-picker-row ws-org-panel-row"
        aria-pressed={props.pressed === undefined ? undefined : props.pressed ? "true" : "false"}
        disabled={props.disabled ?? false}
        onClick={() => props.onClick()}
      >
        <MemberAvatar member={{ ...props.agent.member, working: props.agent.state === "working" }} size="sm" />
        <span class="ws-picker-name">{props.agent.member.name}</span>
        <Show when={props.agent.title}>
          <span class="ws-org-panel-row-title">{props.agent.title}</span>
        </Show>
        <span class="ws-org-panel-row-state" data-state={props.agent.state} aria-hidden="true" />
        <Show when={props.pressed}>
          <span class="ws-picker-check" aria-hidden="true">
            <Check />
          </span>
        </Show>
      </Button>
    </li>
  );
}
