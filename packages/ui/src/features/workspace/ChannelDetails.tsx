import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { Tabs } from "../../complex";
import { Input } from "../../form";
import {
  Archive,
  Crown,
  Hash,
  Lock,
  LogOut,
  Pencil,
  ShieldCheck,
  Trash2,
  UserRoundPlus,
  Waypoints,
  Zap,
} from "../../icons";
import { Switch } from "../../switch";
import { useText } from "../../text";
import { cx } from "../../utils";
import { roleLabelKey, type WorkspaceRole } from "./MemberProfileCard";
import { AiBadge, MemberAvatar, presenceLabelKey } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { WorkspaceSelect } from "./WorkspaceSelect";
import { useRecentTime } from "./workspace-format";
import type { AgentAnswerMode, ChannelVisibility, WorkspaceMember } from "./workspace-types";

export type ChannelDetailsTab = "about" | "members" | "integrations" | "decisions" | "settings";

const TABS: readonly string[] = [
  "about",
  "members",
  "integrations",
  "decisions",
  "settings",
] satisfies ChannelDetailsTab[];

function isChannelDetailsTab(value: string): value is ChannelDetailsTab {
  return TABS.includes(value);
}

/** A decision that an agent made without a person in a hands-off channel. */
export interface ChannelDecisionItem {
  /** The id of the channel message that holds it. */
  id: string;
  agent: WorkspaceMember;
  /** The decision, without its prefix. */
  text: string;
  /** In milliseconds since the epoch. */
  at: number;
}

const ANSWER_MODES = [
  { value: "mention", label: "workspace.answerMode.mention", description: "workspace.answerMode.mentionHint" },
  { value: "always", label: "workspace.answerMode.always", description: "workspace.answerMode.alwaysHint" },
  {
    value: "always-no-gate",
    label: "workspace.answerMode.alwaysNoGate",
    description: "workspace.answerMode.alwaysNoGateHint",
  },
  { value: "lead", label: "workspace.answerMode.lead", description: "workspace.answerMode.leadHint" },
] as const satisfies readonly { value: AgentAnswerMode; label: string; description: string }[];

export interface ChannelDetailsMember {
  member: WorkspaceMember;
  /** A human's role in the workspace. */
  role?: WorkspaceRole | undefined;
  /** An agent: when it answers in this channel. */
  answerMode?: AgentAnswerMode | undefined;
  /** An agent: the focus note that the gate reads. */
  focus?: string | undefined;
  /** An agent: the gate decides when it answers. */
  gateEnabled?: boolean | undefined;
}

export interface ChannelDetailsInfo {
  name: string;
  visibility: ChannelVisibility;
  topic?: string | undefined;
  description?: string | undefined;
  createdBy?: WorkspaceMember | undefined;
  createdAt?: number | undefined;
  coordinatorRouting?: boolean | undefined;
  /** The agent that routes each message with coordinator routing. */
  leadAgentId?: string | null | undefined;
  archived?: boolean | undefined;
}

export interface ChannelDetailsProps {
  channel: ChannelDetailsInfo;
  members: readonly ChannelDetailsMember[];
  /** The tab that opens first. The panel keeps the tab that the reader picks. */
  defaultTab?: ChannelDetailsTab | undefined;
  /** Called when the reader picks a tab, so the owner can keep it across a re-render. */
  onTabChange?: ((tab: ChannelDetailsTab) => void) | undefined;
  onClose: () => void;
  onBack?: (() => void) | undefined;
  onEditTopic?: (() => void) | undefined;
  onEditDescription?: (() => void) | undefined;
  onAddMembers?: (() => void) | undefined;
  onRemoveMember?: ((memberId: string) => void) | undefined;
  onAnswerModeChange?: ((agentId: string, mode: AgentAnswerMode) => void) | undefined;
  /** Called when the focus field loses focus or the reader presses Enter. */
  onFocusChange?: ((agentId: string, focus: string) => void) | undefined;
  onGateChange?: ((agentId: string, enabled: boolean) => void) | undefined;
  /** The Discord link row and other bridges. */
  integrations?: JSX.Element;
  /** Under the members: why each agent answered or stayed quiet, for owners and admins. */
  answerLog?: JSX.Element;
  onVisibilityChange?: ((visibility: ChannelVisibility) => void) | undefined;
  onCoordinatorRoutingChange?: ((enabled: boolean) => void) | undefined;
  /** Picks the lead agent of coordinator routing. */
  onLeadChange?: ((agentId: string) => void) | undefined;
  onArchive?: (() => void) | undefined;
  onLeave?: (() => void) | undefined;
  /**
   * The decisions that agents made without a person here, newest first; null while they load.
   * Absent, the panel has no Decisions tab.
   */
  decisions?: readonly ChannelDecisionItem[] | null | undefined;
  /** Opens the message of a decision. */
  onOpenDecision?: ((id: string) => void) | undefined;
  /** Whether the channel is in hands-off mode. */
  handsOff?: boolean | undefined;
  /** Turns hands-off mode on or off. Absent, the setting is hidden: only owners and admins change it. */
  onHandsOffChange?: ((enabled: boolean) => void) | undefined;
  class?: string;
}

/** The channel details panel: About, Members (with per-agent answer modes), Integrations, Decisions, Settings. */
export function ChannelDetails(props: ChannelDetailsProps): JSX.Element {
  const { t } = useText();
  const [tab, setTab] = createSignal<ChannelDetailsTab>(props.defaultTab ?? "about");
  const humans = () => props.members.filter((entry) => entry.member.kind === "human");
  const agents = () => props.members.filter((entry) => entry.member.kind === "agent");
  return (
    <section class={cx("ws-details", props.class)} aria-label={t("workspace.details.title")}>
      <WorkspacePaneHeader
        icon={
          <Show when={props.channel.visibility === "private"} fallback={<Hash aria-hidden="true" />}>
            <Lock aria-hidden="true" />
          </Show>
        }
        title={props.channel.name}
        onBack={props.onBack}
        onClose={props.onClose}
      />
      <Tabs.Root
        class="ws-details-tabs"
        value={tab()}
        onChange={(value) => {
          if (isChannelDetailsTab(value)) {
            setTab(value);
            props.onTabChange?.(value);
          }
        }}
      >
        <Tabs.List class="ws-tabs-list" aria-label={t("workspace.details.title")}>
          <Tabs.Trigger class="ws-tab" value="about">
            {t("workspace.details.about")}
          </Tabs.Trigger>
          <Tabs.Trigger class="ws-tab" value="members">
            {t("workspace.details.membersTab", { count: props.members.length })}
          </Tabs.Trigger>
          <Tabs.Trigger class="ws-tab" value="integrations">
            {t("workspace.details.integrations")}
          </Tabs.Trigger>
          <Show when={props.decisions !== undefined}>
            <Tabs.Trigger class="ws-tab" value="decisions">
              {t("workspace.details.decisions")}
            </Tabs.Trigger>
          </Show>
          <Tabs.Trigger class="ws-tab" value="settings">
            {t("workspace.details.settings")}
          </Tabs.Trigger>
          <Tabs.Indicator class="ws-tab-indicator" />
        </Tabs.List>

        <Tabs.Content class="ws-details-content" value="about">
          <div class="ws-details-card">
            <DetailField label={t("workspace.details.topic")} onEdit={props.onEditTopic}>
              {props.channel.topic || <span class="ws-muted">{t("workspace.details.noTopic")}</span>}
            </DetailField>
            <DetailField label={t("workspace.details.description")} onEdit={props.onEditDescription}>
              {props.channel.description || <span class="ws-muted">{t("workspace.details.noDescription")}</span>}
            </DetailField>
            <Show when={props.channel.createdBy}>
              {(creator) => (
                <DetailField label={t("workspace.details.created")}>
                  <CreatedLine creator={creator()} at={props.channel.createdAt} />
                </DetailField>
              )}
            </Show>
          </div>
        </Tabs.Content>

        <Tabs.Content class="ws-details-content" value="members">
          <Show when={props.onAddMembers}>
            {(add) => (
              <Button variant="ghost" class="ws-details-add" onClick={() => add()()}>
                <span class="ws-details-add-icon">
                  <UserRoundPlus aria-hidden="true" />
                </span>
                {t("workspace.details.addPeople")}
              </Button>
            )}
          </Show>
          <Show when={agents().length > 0}>
            <h3 class="ws-details-section-title">{t("workspace.details.agents", { count: agents().length })}</h3>
            <ul class="ws-details-members">
              <For each={agents()} keyed={(entry) => entry.member.id}>
                {(entry) => (
                  <AgentMemberRow
                    entry={entry()}
                    onAnswerModeChange={props.onAnswerModeChange}
                    onFocusChange={props.onFocusChange}
                    onGateChange={props.onGateChange}
                    onRemove={props.onRemoveMember}
                  />
                )}
              </For>
            </ul>
          </Show>
          <Show when={props.answerLog}>
            <div class="ws-details-answer-log">{props.answerLog}</div>
          </Show>
          <h3 class="ws-details-section-title">{t("workspace.details.people", { count: humans().length })}</h3>
          <ul class="ws-details-members">
            <For each={humans()} keyed={(entry) => entry.member.id}>
              {(entry) => (
                <li class="ws-details-member">
                  <MemberAvatar member={entry().member} size="md" showStatus />
                  <span class="ws-details-member-copy">
                    <span class="ws-details-member-name">{entry().member.name}</span>
                    <span class="ws-details-member-meta">
                      {t(presenceLabelKey(entry().member.presence))}
                      <Show when={entry().role}>{(role) => ` · ${t(roleLabelKey(role()))}`}</Show>
                    </span>
                  </span>
                  <Show when={props.onRemoveMember && entry().role !== "owner"}>
                    <IconButton
                      variant="ghost"
                      size="icon-xs"
                      class="ws-details-remove"
                      label={t("workspace.details.remove", { name: entry().member.name })}
                      onClick={() => props.onRemoveMember?.(entry().member.id)}
                    >
                      <Trash2 />
                    </IconButton>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Tabs.Content>

        <Tabs.Content class="ws-details-content" value="integrations">
          <Show
            when={props.integrations}
            fallback={<p class="ws-details-empty">{t("workspace.details.noIntegrations")}</p>}
          >
            <div class="ws-details-card">{props.integrations}</div>
          </Show>
        </Tabs.Content>

        <Show when={props.decisions !== undefined}>
          <Tabs.Content class="ws-details-content" value="decisions">
            <DecisionList decisions={props.decisions ?? null} onOpen={props.onOpenDecision} />
          </Tabs.Content>
        </Show>

        <Tabs.Content class="ws-details-content" value="settings">
          <div class="ws-details-card">
            <SettingRow
              icon={<Lock aria-hidden="true" />}
              label={t("workspace.details.private")}
              description={t("workspace.details.privateHint")}
            >
              <Switch
                aria-label={t("workspace.details.private")}
                checked={props.channel.visibility === "private"}
                disabled={!props.onVisibilityChange}
                onChange={(checked: boolean) => props.onVisibilityChange?.(checked ? "private" : "public")}
              />
            </SettingRow>
            <SettingRow
              icon={<Waypoints aria-hidden="true" />}
              label={t("workspace.details.coordinator")}
              description={t("workspace.details.coordinatorHint")}
            >
              <Switch
                aria-label={t("workspace.details.coordinator")}
                checked={props.channel.coordinatorRouting ?? false}
                disabled={!props.onCoordinatorRoutingChange}
                onChange={(checked: boolean) => props.onCoordinatorRoutingChange?.(checked)}
              />
            </SettingRow>
            <Show when={props.channel.coordinatorRouting && agents().length > 0}>
              <SettingRow
                icon={<Crown aria-hidden="true" />}
                label={t("workspace.details.lead")}
                description={t("workspace.details.leadHint")}
              >
                <WorkspaceSelect
                  label={t("workspace.details.lead")}
                  value={props.channel.leadAgentId ?? ""}
                  options={[
                    ...(props.channel.leadAgentId ? [] : [{ value: "", label: t("workspace.details.leadNone") }]),
                    ...agents().map((entry) => ({ value: entry.member.id, label: entry.member.name })),
                  ]}
                  disabled={!props.onLeadChange}
                  onChange={(agentId) => {
                    if (agentId) props.onLeadChange?.(agentId);
                  }}
                />
              </SettingRow>
            </Show>
            <Show when={props.onHandsOffChange}>
              {(change) => (
                <SettingRow
                  icon={<Zap aria-hidden="true" />}
                  label={t("workspace.details.handsOff")}
                  description={t("workspace.details.handsOffHint")}
                >
                  <Switch
                    aria-label={t("workspace.details.handsOff")}
                    checked={props.handsOff ?? false}
                    onChange={(checked: boolean) => change()(checked)}
                  />
                </SettingRow>
              )}
            </Show>
          </div>
          <div class="ws-details-danger">
            <Show when={props.onLeave}>
              {(leave) => (
                <Button variant="ghost" class="ws-details-danger-action" onClick={() => leave()()}>
                  <LogOut aria-hidden="true" />
                  {t("workspace.details.leave")}
                </Button>
              )}
            </Show>
            <Show when={props.onArchive}>
              {(archive) => (
                <Button variant="destructive-ghost" class="ws-details-danger-action" onClick={() => archive()()}>
                  <Archive aria-hidden="true" />
                  {t("workspace.details.archive")}
                </Button>
              )}
            </Show>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

/** The decisions of a hands-off channel, newest first. Each one opens its message. */
function DecisionList(props: {
  decisions: readonly ChannelDecisionItem[] | null;
  onOpen?: ((id: string) => void) | undefined;
}): JSX.Element {
  const { t, format } = useText();
  const recent = useRecentTime();
  return (
    <Show when={props.decisions} fallback={<p class="ws-details-empty">{t("workspace.details.decisionsLoading")}</p>}>
      {(decisions) => (
        <Show
          when={decisions().length > 0}
          fallback={<p class="ws-details-empty">{t("workspace.details.decisionsEmpty")}</p>}
        >
          <ul class="ws-feed">
            <For each={decisions()} keyed={(item) => item.id}>
              {(item) => (
                <li>
                  <Button
                    variant="ghost"
                    class="ws-feed-row"
                    disabled={!props.onOpen}
                    onClick={() => props.onOpen?.(item().id)}
                  >
                    <span class="ws-feed-avatar">
                      <MemberAvatar member={item().agent} size="md" />
                    </span>
                    <span class="ws-feed-copy">
                      <span class="ws-feed-heading">
                        <span class="ws-feed-what">
                          {item().agent.name}
                          <AiBadge />
                        </span>
                        <time
                          class="ws-feed-time"
                          datetime={new Date(item().at).toISOString()}
                          title={format.date(item().at, { dateStyle: "medium", timeStyle: "short" })}
                        >
                          {recent(item().at)}
                        </time>
                      </span>
                      <span class="ws-decision-text">{item().text}</span>
                    </span>
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      )}
    </Show>
  );
}

function CreatedLine(props: { creator: WorkspaceMember; at?: number | undefined }): JSX.Element {
  const { t, format } = useText();
  return (
    <span class="ws-details-created">
      <MemberAvatar member={props.creator} size="xs" />
      {props.at === undefined
        ? t("workspace.details.createdBy", { name: props.creator.name })
        : t("workspace.details.createdByOn", {
            name: props.creator.name,
            date: format.date(props.at, { dateStyle: "long" }),
          })}
    </span>
  );
}

function DetailField(props: { label: string; children: JSX.Element; onEdit?: (() => void) | undefined }): JSX.Element {
  const { t } = useText();
  return (
    <div class="ws-details-field">
      <div class="ws-details-field-header">
        <span class="ws-details-field-label">{props.label}</span>
        <Show when={props.onEdit}>
          {(edit) => (
            <Button variant="link" size="xs" class="ws-details-edit" onClick={() => edit()()}>
              <Pencil aria-hidden="true" />
              {t("workspace.details.edit")}
            </Button>
          )}
        </Show>
      </div>
      <div class="ws-details-field-value">{props.children}</div>
    </div>
  );
}

function SettingRow(props: {
  icon: JSX.Element;
  label: string;
  description: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class="ws-details-setting">
      <span class="ws-details-setting-icon">{props.icon}</span>
      <span class="ws-details-setting-copy">
        <span class="ws-details-setting-label">{props.label}</span>
        <span class="ws-details-setting-description">{props.description}</span>
      </span>
      {props.children}
    </div>
  );
}

function AgentMemberRow(props: {
  entry: ChannelDetailsMember;
  onAnswerModeChange?: ((agentId: string, mode: AgentAnswerMode) => void) | undefined;
  onFocusChange?: ((agentId: string, focus: string) => void) | undefined;
  onGateChange?: ((agentId: string, enabled: boolean) => void) | undefined;
  onRemove?: ((memberId: string) => void) | undefined;
}): JSX.Element {
  const { t } = useText();
  const [focus, setFocus] = createSignal(() => props.entry.focus ?? "");
  const mode = () => props.entry.answerMode ?? "mention";
  const commitFocus = () => {
    const next = focus().trim();
    if (next !== (props.entry.focus ?? "")) props.onFocusChange?.(props.entry.member.id, next);
  };
  return (
    <li class="ws-details-member ws-details-agent">
      <MemberAvatar member={props.entry.member} size="md" showStatus animate />
      <span class="ws-details-member-copy">
        <span class="ws-details-member-name">
          {props.entry.member.name}
          <AiBadge />
        </span>
        <span class="ws-details-member-meta">
          <span class="ws-gate" data-on={props.entry.gateEnabled ? "" : undefined}>
            <ShieldCheck aria-hidden="true" />
            {t(props.entry.gateEnabled ? "workspace.gate.on" : "workspace.gate.off")}
          </span>
        </span>
      </span>
      <Show when={props.onRemove}>
        <IconButton
          variant="ghost"
          size="icon-xs"
          class="ws-details-remove"
          label={t("workspace.details.remove", { name: props.entry.member.name })}
          onClick={() => props.onRemove?.(props.entry.member.id)}
        >
          <Trash2 />
        </IconButton>
      </Show>
      <div class="ws-details-agent-settings">
        <WorkspaceSelect<AgentAnswerMode>
          label={t("workspace.details.answerMode", { name: props.entry.member.name })}
          prefix={t("workspace.details.answers")}
          value={mode()}
          disabled={!props.onAnswerModeChange}
          options={ANSWER_MODES.map((option) => ({
            value: option.value,
            label: t(option.label),
            description: t(option.description),
          }))}
          onChange={(next) => props.onAnswerModeChange?.(props.entry.member.id, next)}
        />
        <Show when={props.onGateChange && (mode() === "always" || mode() === "always-no-gate")}>
          <Switch
            size="sm"
            aria-label={t("workspace.details.gate", { name: props.entry.member.name })}
            checked={props.entry.gateEnabled ?? false}
            onChange={(checked: boolean) => props.onGateChange?.(props.entry.member.id, checked)}
          />
        </Show>
        <Input
          size="sm"
          class="ws-details-focus"
          value={focus()}
          placeholder={t("workspace.details.focusPlaceholder")}
          aria-label={t("workspace.details.focus", { name: props.entry.member.name })}
          disabled={!props.onFocusChange}
          onValueChange={setFocus}
          onBlur={commitFocus}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter") commitFocus();
          }}
        />
      </div>
    </li>
  );
}
