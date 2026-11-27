import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, createStore, createUniqueId, For, Show, untrack } from "solid-js";
import { Button, IconButton } from "../../button";
import { Tabs } from "../../complex";
import { Input, Textarea } from "../../form";
import { Archive, Hash, Lock, LogOut, Pin, ShieldCheck, Trash2, UserRoundPlus } from "../../icons";
import {
  createSettingsDrafts,
  SettingsDraftsContext,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  saveOnEnter,
  useSettingsDraft,
} from "../../settings";
import { Switch } from "../../switch";
import { useText } from "../../text";
import { cx } from "../../utils";
import { SettingsDraftsSaveBar } from "../settings/SettingsDialogShell";
import { roleLabelKey, type WorkspaceRole } from "./MemberProfileCard";
import { AiBadge, MemberAvatar, presenceLabelKey } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { WorkspaceSelect } from "./WorkspaceSelect";
import { useRecentTime } from "./workspace-format";
import type { AgentAnswerMode, ChannelVisibility, WorkspaceMember } from "./workspace-types";

/** The most characters of a channel topic and description. The host keeps the same limits. */
const CHANNEL_TOPIC_MAX = 250;
const CHANNEL_DESCRIPTION_MAX = 2000;

export type ChannelDetailsTab = "about" | "members" | "pins" | "integrations" | "decisions" | "settings";

const TABS: readonly string[] = [
  "about",
  "members",
  "pins",
  "integrations",
  "decisions",
  "settings",
] satisfies ChannelDetailsTab[];

function isChannelDetailsTab(value: string): value is ChannelDetailsTab {
  return TABS.includes(value);
}

/** A message pinned to the channel, as the Pins tab lists it. */
export interface ChannelPinItem {
  /** The id of the pinned message. */
  id: string;
  author: WorkspaceMember;
  /** One plain line of the message. */
  text: string;
  /** The time of the message, in milliseconds since the epoch. */
  at: number;
  /** The name of the person or agent who pinned it. */
  pinnedBy: string;
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
  /**
   * Saves the topic and the description through the panel's save bar; a failure throws its message.
   * Absent, the reader may not change them and the About tab only shows them.
   */
  onSaveAbout?: ((change: { topic?: string; description?: string }) => Promise<void>) | undefined;
  onAddMembers?: (() => void) | undefined;
  onRemoveMember?: ((memberId: string) => void) | undefined;
  onAnswerModeChange?: ((agentId: string, mode: AgentAnswerMode) => void) | undefined;
  /** Saves an agent's focus through the panel's save bar; a failure throws. */
  onFocusChange?: ((agentId: string, focus: string) => Promise<void>) | undefined;
  onGateChange?: ((agentId: string, enabled: boolean) => void) | undefined;
  /** The Discord link row and other bridges. */
  integrations?: JSX.Element;
  /** Under the members: why each agent answered or stayed quiet, for owners and admins. */
  answerLog?: JSX.Element;
  onVisibilityChange?: ((visibility: ChannelVisibility) => void) | undefined;
  onCoordinatorRoutingChange?: ((enabled: boolean) => void) | undefined;
  /** Picks the lead agent of coordinator routing. */
  onLeadChange?: ((agentId: string) => void) | undefined;
  /** The space of the channel and the spaces it can move to. Absent on a host without spaces. */
  space?:
    | {
        value: string;
        options: readonly { value: string; label: string }[];
        /** Absent: the reader may not move it, or it is a DM that follows its agent. */
        onChange?: ((spaceId: string) => void) | undefined;
      }
    | undefined;
  onArchive?: (() => void) | undefined;
  onLeave?: (() => void) | undefined;
  /**
   * The decisions that agents made without a person here, newest first; null while they load.
   * Absent, the panel has no Decisions tab.
   */
  decisions?: readonly ChannelDecisionItem[] | null | undefined;
  /** Opens the message of a decision. */
  onOpenDecision?: ((id: string) => void) | undefined;
  /** The pinned messages, newest pin first; null while they load. Absent, the panel has no Pins tab. */
  pins?: readonly ChannelPinItem[] | null | undefined;
  /** Shows a pinned message in the conversation. */
  onOpenPin?: ((id: string) => void) | undefined;
  /** Whether the channel is in hands-off mode. */
  handsOff?: boolean | undefined;
  /** Turns hands-off mode on or off. Absent, the setting is hidden: only owners and admins change it. */
  onHandsOffChange?: ((enabled: boolean) => void) | undefined;
  class?: string;
}

/**
 * The channel details panel: About, Members (with per-agent answer modes), Pins, Integrations,
 * Decisions, Settings. About and Settings are on the settings design system: switches and selects
 * save at once; the topic, the description and each agent's focus save with the one save bar at the
 * foot of the panel.
 */
export function ChannelDetails(props: ChannelDetailsProps): JSX.Element {
  const { t, errorMessage } = useText();
  const [tab, setTab] = createSignal<ChannelDetailsTab>(props.defaultTab ?? "about");
  const humans = () => props.members.filter((entry) => entry.member.kind === "human");
  const agents = () => props.members.filter((entry) => entry.member.kind === "agent");
  const drafts = createSettingsDrafts((error) => errorMessage(error, t("workspace.app.error.meta")));
  const switchId = createUniqueId();
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
      <SettingsDraftsContext value={drafts}>
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
            <Show when={props.pins !== undefined}>
              <Tabs.Trigger class="ws-tab" value="pins">
                {t("workspace.details.pins")}
              </Tabs.Trigger>
            </Show>
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

          <Tabs.Content class="ws-details-content settings-panel-content" value="about">
            <div class="ws-details-page settings-panel-page">
              <SettingsSection
                title={t("workspace.details.aboutSection")}
                description={t("workspace.details.aboutDescription")}
              >
                <SettingsGroup label={t("workspace.details.aboutSection")}>
                  <AboutFields
                    topic={props.channel.topic ?? ""}
                    description={props.channel.description ?? ""}
                    onSave={props.onSaveAbout}
                  />
                  <Show when={props.channel.createdBy}>
                    {(creator) => (
                      <SettingsRow
                        label={t("workspace.details.created")}
                        description={<CreatedLine creator={creator()} at={props.channel.createdAt} />}
                      />
                    )}
                  </Show>
                </SettingsGroup>
              </SettingsSection>
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

          <Show when={props.pins !== undefined}>
            <Tabs.Content class="ws-details-content" value="pins">
              <PinList pins={props.pins ?? null} onOpen={props.onOpenPin} />
            </Tabs.Content>
          </Show>

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

          <Tabs.Content class="ws-details-content settings-panel-content" value="settings">
            <div class="ws-details-page settings-panel-page">
              <SettingsSection
                title={t("workspace.details.accessSection")}
                description={t("workspace.details.accessDescription")}
              >
                <SettingsGroup label={t("workspace.details.accessSection")}>
                  <Show when={props.space}>
                    {(space) => (
                      <SettingsRow label={t("workspace.spaces.space")} description={t("workspace.spaces.spaceHint")}>
                        <WorkspaceSelect
                          label={t("workspace.spaces.space")}
                          value={space().value}
                          options={space().options}
                          disabled={!space().onChange}
                          onChange={(spaceId) => space().onChange?.(spaceId)}
                        />
                      </SettingsRow>
                    )}
                  </Show>
                  <SettingsRow
                    layout="inline"
                    controlId={`${switchId}-private`}
                    label={t("workspace.details.private")}
                    description={t("workspace.details.privateHint")}
                  >
                    <Switch
                      id={`${switchId}-private`}
                      aria-label={t("workspace.details.private")}
                      checked={props.channel.visibility === "private"}
                      disabled={!props.onVisibilityChange}
                      onChange={(checked: boolean) => props.onVisibilityChange?.(checked ? "private" : "public")}
                    />
                  </SettingsRow>
                  <SettingsRow
                    layout="inline"
                    controlId={`${switchId}-coordinator`}
                    label={t("workspace.details.coordinator")}
                    description={t("workspace.details.coordinatorHint")}
                  >
                    <Switch
                      id={`${switchId}-coordinator`}
                      aria-label={t("workspace.details.coordinator")}
                      checked={props.channel.coordinatorRouting ?? false}
                      disabled={!props.onCoordinatorRoutingChange}
                      onChange={(checked: boolean) => props.onCoordinatorRoutingChange?.(checked)}
                    />
                  </SettingsRow>
                  <Show when={props.channel.coordinatorRouting && agents().length > 0}>
                    <SettingsRow label={t("workspace.details.lead")} description={t("workspace.details.leadHint")}>
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
                    </SettingsRow>
                  </Show>
                  <Show when={props.onHandsOffChange}>
                    {(change) => (
                      <SettingsRow
                        layout="inline"
                        controlId={`${switchId}-hands-off`}
                        label={t("workspace.details.handsOff")}
                        description={t("workspace.details.handsOffHint")}
                      >
                        <Switch
                          id={`${switchId}-hands-off`}
                          aria-label={t("workspace.details.handsOff")}
                          checked={props.handsOff ?? false}
                          onChange={(checked: boolean) => change()(checked)}
                        />
                      </SettingsRow>
                    )}
                  </Show>
                </SettingsGroup>
              </SettingsSection>
              <Show when={props.onLeave || props.onArchive}>
                <SettingsSection
                  title={t("workspace.details.dangerSection")}
                  description={t("workspace.details.dangerDescription")}
                >
                  <SettingsGroup label={t("workspace.details.dangerSection")}>
                    <Show when={props.onLeave}>
                      {(leave) => (
                        <SettingsRow
                          label={t("workspace.details.leave")}
                          description={t("workspace.details.leaveHint")}
                        >
                          <Button variant="outline" size="sm" onClick={() => leave()()}>
                            <LogOut aria-hidden="true" />
                            {t("workspace.details.leaveButton")}
                          </Button>
                        </SettingsRow>
                      )}
                    </Show>
                    <Show when={props.onArchive}>
                      {(archive) => (
                        <SettingsRow
                          label={t("workspace.details.archive")}
                          description={t("workspace.details.archiveHint")}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            class="ws-details-danger-button"
                            aria-haspopup="dialog"
                            onClick={() => archive()()}
                          >
                            <Archive aria-hidden="true" />
                            {t("workspace.details.archiveButton")}
                          </Button>
                        </SettingsRow>
                      )}
                    </Show>
                  </SettingsGroup>
                </SettingsSection>
              </Show>
            </div>
          </Tabs.Content>
        </Tabs.Root>
        <SettingsDraftsSaveBar drafts={drafts} label={t("channel.saveBar.label")} />
      </SettingsDraftsContext>
    </section>
  );
}

/**
 * The topic and the description: one text form of the panel's save bar. A field takes the stored
 * value while it holds no change of its own, so a save elsewhere does not overwrite what is typed.
 * Without `onSave` the reader may not change them, and the rows only show them.
 */
function AboutFields(props: {
  topic: string;
  description: string;
  onSave?: ((change: { topic?: string; description?: string }) => Promise<void>) | undefined;
}): JSX.Element {
  const { t } = useText();
  const id = createUniqueId();
  const [fields, setFields] = createStore({ topic: "", description: "", topicDirty: false, descriptionDirty: false });
  createEffect(
    () => ({ topic: props.topic, description: props.description }),
    (stored) =>
      setFields((state) => {
        if (!state.topicDirty) state.topic = stored.topic;
        if (!state.descriptionDirty) state.description = stored.description;
      }),
  );
  const drafts = useSettingsDraft({
    dirty: () => fields.topicDirty || fields.descriptionDirty,
    async save() {
      const save = props.onSave;
      if (!save) return;
      const topic = fields.topic.trim();
      const description = fields.description.trim();
      await save({
        ...(fields.topicDirty ? { topic } : {}),
        ...(fields.descriptionDirty ? { description } : {}),
      });
      setFields((state) => {
        state.topic = topic;
        state.description = description;
        state.topicDirty = false;
        state.descriptionDirty = false;
      });
    },
    reset() {
      setFields((state) => {
        state.topic = props.topic;
        state.description = props.description;
        state.topicDirty = false;
        state.descriptionDirty = false;
      });
    },
  });
  return (
    <Show
      when={props.onSave}
      fallback={
        <>
          <SettingsRow
            label={t("workspace.details.topic")}
            description={props.topic || t("workspace.details.noTopic")}
          />
          <SettingsRow
            label={t("workspace.details.description")}
            description={props.description || t("workspace.details.noDescription")}
          />
        </>
      }
    >
      <SettingsRow
        layout="stack"
        controlId={`${id}-topic`}
        label={t("workspace.details.topic")}
        description={t("workspace.app.meta.topicHint")}
      >
        <Input
          id={`${id}-topic`}
          value={fields.topic}
          maxlength={CHANNEL_TOPIC_MAX}
          placeholder={t("workspace.details.noTopic")}
          onValueChange={(value) =>
            setFields((state) => {
              state.topic = value;
              state.topicDirty = true;
            })
          }
          onKeyDown={saveOnEnter(drafts)}
        />
      </SettingsRow>
      <SettingsRow
        layout="stack"
        controlId={`${id}-description`}
        label={t("workspace.details.description")}
        description={t("workspace.app.meta.descriptionHint")}
      >
        <Textarea
          id={`${id}-description`}
          value={fields.description}
          maxlength={CHANNEL_DESCRIPTION_MAX}
          rows={4}
          placeholder={t("workspace.details.noDescription")}
          onValueChange={(value) =>
            setFields((state) => {
              state.description = value;
              state.descriptionDirty = true;
            })
          }
        />
      </SettingsRow>
    </Show>
  );
}

/** The decisions of a hands-off channel, newest first. Each one opens its message. */
function PinList(props: {
  pins: readonly ChannelPinItem[] | null;
  onOpen?: ((id: string) => void) | undefined;
}): JSX.Element {
  const { t, format } = useText();
  const recent = useRecentTime();
  return (
    <Show when={props.pins} fallback={<p class="ws-details-empty">{t("workspace.details.pinsLoading")}</p>}>
      {(pins) => (
        <Show when={pins().length > 0} fallback={<p class="ws-details-empty">{t("workspace.details.pinsEmpty")}</p>}>
          <ul class="ws-feed">
            <For each={pins()} keyed={(item) => item.id}>
              {(item) => (
                <li>
                  <Button
                    variant="ghost"
                    class="ws-feed-row"
                    disabled={!props.onOpen}
                    onClick={() => props.onOpen?.(item().id)}
                  >
                    <span class="ws-feed-avatar">
                      <MemberAvatar member={item().author} size="md" />
                    </span>
                    <span class="ws-feed-copy">
                      <span class="ws-feed-heading">
                        <span class="ws-feed-what">
                          {item().author.name}
                          <Show when={item().author.kind === "agent"}>
                            <AiBadge />
                          </Show>
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
                      <span class="ws-pin-by">
                        <Pin aria-hidden="true" />
                        {t("workspace.details.pinnedBy", { name: item().pinnedBy })}
                      </span>
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

function AgentMemberRow(props: {
  entry: ChannelDetailsMember;
  onAnswerModeChange?: ((agentId: string, mode: AgentAnswerMode) => void) | undefined;
  onFocusChange?: ((agentId: string, focus: string) => Promise<void>) | undefined;
  onGateChange?: ((agentId: string, enabled: boolean) => void) | undefined;
  onRemove?: ((memberId: string) => void) | undefined;
}): JSX.Element {
  const { t } = useText();
  // The field holds what the reader typed until the save bar saves or resets it.
  const [focus, setFocus] = createSignal<string | null>(null);
  const stored = () => props.entry.focus ?? "";
  const mode = () => props.entry.answerMode ?? "mention";
  const drafts = useSettingsDraft({
    dirty: () => focus() !== null && focus()?.trim() !== stored(),
    async save() {
      const next = focus()?.trim() ?? stored();
      await props.onFocusChange?.(props.entry.member.id, next);
      setFocus(next);
    },
    reset: () => setFocus(null),
  });
  // The saved focus comes back from the host: the field then follows the host again.
  createEffect(stored, (value) => {
    if (untrack(focus)?.trim() === value) setFocus(null);
  });
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
          value={focus() ?? stored()}
          placeholder={t("workspace.details.focusPlaceholder")}
          aria-label={t("workspace.details.focus", { name: props.entry.member.name })}
          disabled={!props.onFocusChange}
          onValueChange={setFocus}
          onKeyDown={saveOnEnter(drafts)}
        />
      </div>
    </li>
  );
}
