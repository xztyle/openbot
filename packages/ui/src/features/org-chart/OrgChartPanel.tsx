/**
 * The right panel of the org chart, on the settings design system: who the agent is and Open chat,
 * then groups of rows: what it does now, its manager (with Change manager), its direct reports, and
 * its actions (Sleep the team, Permissions). Change manager opens a picker dialog that lists the
 * agents that would not make a loop, and "No manager" first; a pick saves at once.
 */

import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Button } from "../../button";
import { SettingsLinkRow, SettingsPanelContent } from "../../components/SettingsPanel";
import { Input } from "../../form";
import { FormDialog } from "../../form-dialog";
import { Check, MessageSquare, Search, ShieldCheck, UserRoundCog } from "../../icons";
import { SettingsGroup, SettingsRow } from "../../settings";
import { Switch } from "../../switch";
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
  /** Opens what the agent may do: its trust rules and budgets. Absent, there is no row. */
  onOpenPermissions?: (() => void) | undefined;
  onClose: () => void;
}

export function OrgChartPanel(props: OrgChartPanelProps): JSX.Element {
  const { t, errorMessage } = useText();
  const [picking, setPicking] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** The switch's new position while the host stores it, for the agent it was set on. */
  const [sleepDraft, setSleepDraft] = createSignal<{ agentId: string; sleeping: boolean } | null>(null);
  const sleeping = () => {
    const draft = sleepDraft();
    return draft && draft.agentId === props.agent.member.id ? draft.sleeping : props.agent.sleeping === true;
  };
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
  const closePicker = () => {
    setPicking(false);
    setQuery("");
    setError(null);
  };
  const pick = async (managerId: string | null) => {
    if (managerId === props.agent.managerId) {
      closePicker();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await props.onChangeManager(managerId);
      closePicker();
    } catch (failure) {
      setError(errorMessage(failure, t("workspace.org.moveFailed")));
    } finally {
      setSaving(false);
    }
  };
  const sleepTeam = (next: boolean) => {
    const set = props.onSleepTeam;
    if (!set) return;
    const agentId = props.agent.member.id;
    setSleepDraft({ agentId, sleeping: next });
    // The caller says how many agents changed, or why it failed; then the agent's own state shows.
    void set(next).finally(() => setSleepDraft(null));
  };
  const stateText = () => t(`workspace.org.state.${props.agent.state}`);
  const switchId = () => `org-panel-sleep-${props.agent.member.id}`;
  return (
    <section class="ws-org-panel-body settings-panel ws-org-settings" aria-label={props.agent.member.name}>
      <WorkspacePaneHeader title={props.agent.member.name} subtitle={props.agent.title} onClose={props.onClose} />
      <SettingsPanelContent>
        <div class="settings-panel-page ws-org-panel-page">
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
            <div class="ws-org-panel-actions">
              <Button size="sm" onClick={() => props.onOpenChat()}>
                <MessageSquare aria-hidden="true" />
                {t("workspace.org.openChat")}
              </Button>
            </div>
          </div>

          <SettingsGroup title={t("workspace.org.panel.now")}>
            <SettingsRow
              label={
                <Show when={props.agent.state !== "idle" ? props.agent.status : undefined} fallback={stateText()}>
                  {(status) => <AgentStatusLine status={status()} class="ws-org-panel-status" />}
                </Show>
              }
              description={
                props.agent.activity ?? (props.agent.state === "idle" ? t("workspace.org.panel.idle") : undefined)
              }
              help={
                props.agent.state === "failed" ? (
                  <span class="ws-org-panel-failed">{t("workspace.org.state.failed")}</span>
                ) : undefined
              }
              layout="inline"
            >
              <Show when={props.agent.queued}>
                {(queued) => <span class="ws-org-chip">{t("workspace.org.queued", { count: queued() })}</span>}
              </Show>
            </SettingsRow>
            <Show when={props.agent.preview}>
              {(preview) => (
                <SettingsRow
                  label={t("workspace.org.panel.lastMessage")}
                  description={<span class="ws-org-panel-preview">{preview()}</span>}
                />
              )}
            </Show>
          </SettingsGroup>

          <SettingsGroup
            title={t("workspace.org.panel.manager")}
            actions={
              <Show when={props.canChangeManager}>
                <Button
                  size="sm"
                  variant="outline"
                  aria-haspopup="dialog"
                  onClick={() => {
                    setError(null);
                    setPicking(true);
                  }}
                >
                  <UserRoundCog aria-hidden="true" />
                  {t("workspace.org.changeManager")}
                </Button>
              </Show>
            }
          >
            <Show when={manager()} fallback={<SettingsRow label={t("workspace.org.topLevel")} />}>
              {(current) => <AgentLinkRow agent={current()} onClick={() => props.onJump(current().member.id)} />}
            </Show>
          </SettingsGroup>

          <SettingsGroup
            title={
              <>
                {t("workspace.org.panel.reports")}
                <Show when={reports().length > 0}>
                  <span class="ws-org-panel-count">{reports().length}</span>
                </Show>
              </>
            }
          >
            <Show when={reports().length > 0} fallback={<SettingsRow label={t("workspace.org.panel.noReports")} />}>
              <For each={reports()} keyed={(agent) => agent.member.id}>
                {(agent) => <AgentLinkRow agent={agent()} onClick={() => props.onJump(agent().member.id)} />}
              </For>
            </Show>
          </SettingsGroup>

          <Show when={props.onSleepTeam || props.onOpenPermissions}>
            <SettingsGroup title={t("workspace.org.panel.actions")}>
              <Show when={props.onSleepTeam}>
                <SettingsRow
                  label={t("efficiency.sleep.team")}
                  description={t("workspace.org.panel.sleepTeamHint")}
                  controlId={switchId()}
                  layout="inline"
                >
                  <Switch
                    id={switchId()}
                    aria-label={t("efficiency.sleep.team")}
                    checked={sleeping()}
                    disabled={sleepDraft() !== null}
                    onChange={sleepTeam}
                  />
                </SettingsRow>
              </Show>
              <Show when={props.onOpenPermissions}>
                {(open) => (
                  <SettingsLinkRow icon={<ShieldCheck />} label={t("trust.org.permissions")} onClick={() => open()()} />
                )}
              </Show>
            </SettingsGroup>
          </Show>
        </div>
      </SettingsPanelContent>

      <FormDialog
        open={picking()}
        onOpenChange={(open) => {
          if (!open) closePicker();
        }}
        size="sm"
        title={t("workspace.org.changeManager")}
        description={t("workspace.org.managerPickerHint", { name: props.agent.member.name })}
        error={error()}
        busy={saving()}
      >
        <div class="ws-org-picker">
          <div class="ws-view-search ws-org-picker-search">
            <Search aria-hidden="true" />
            <Input
              size="sm"
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
                <PickerRow
                  agent={agent()}
                  disabled={saving()}
                  pressed={agent().member.id === props.agent.managerId}
                  onClick={() => void pick(agent().member.id)}
                />
              )}
            </For>
          </ul>
        </div>
      </FormDialog>
    </section>
  );
}

/** A manager or a report in its group: face, name, title, and a dot for its state. It jumps to the card. */
function AgentLinkRow(props: { agent: OrgChartAgent; onClick: () => void }): JSX.Element {
  return (
    <SettingsLinkRow
      label={
        <>
          <MemberAvatar member={{ ...props.agent.member, working: props.agent.state === "working" }} size="sm" />
          <span class="ws-org-panel-link-name">{props.agent.member.name}</span>
          <span class="ws-org-panel-row-state" data-state={props.agent.state} aria-hidden="true" />
        </>
      }
      value={props.agent.title}
      onClick={() => props.onClick()}
    />
  );
}

/** An agent in the manager picker; the current manager is pressed. */
function PickerRow(props: {
  agent: OrgChartAgent;
  onClick: () => void;
  pressed: boolean;
  disabled: boolean;
}): JSX.Element {
  return (
    <li>
      <Button
        variant="ghost"
        class="ws-picker-row ws-org-panel-row"
        aria-pressed={props.pressed ? "true" : "false"}
        disabled={props.disabled}
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
