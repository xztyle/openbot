import {
  type ChannelGateDecision,
  type ChannelGateFallback,
  channelKind,
  channelRouting,
  channelVisibility,
} from "@openbot/contracts/ipc";
import { Button, Plug } from "@openbot/ui";
import { ChannelDetails, type ChannelDetailsMember } from "@openbot/ui/features/workspace/ChannelDetails";
import { MemberAvatar } from "@openbot/ui/features/workspace/WorkspaceAvatar";
import { WorkspaceSelect } from "@openbot/ui/features/workspace/WorkspaceSelect";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { conversationName, humanIds, memberById, previewText, readerJoined } from "./workspace-model";

/** The right panel of a channel: About, Members with each agent's answer mode, Integrations, Settings. */
export function WorkspaceDetailsPanel(props: { channelId: string }) {
  const ws = useWorkspace();
  const channel = () => {
    const page = ws.channels.state.page;
    return page?.channel.id === props.channelId ? page.channel : ws.summary(props.channelId);
  };
  const tab = () => {
    const panel = ws.state.panel;
    return panel?.kind === "details" ? panel.tab : "about";
  };
  return (
    <Show when={channel()} keyed>
      {(current) => {
        const kind = channelKind(current);
        const manage = () => ws.canManage(current);
        const joined = () => readerJoined(ws.directory(), current);
        const members = createMemo((): ChannelDetailsMember[] => {
          const live = channel() ?? current;
          const people = humanIds(live).map((id) => ({
            member: memberById(ws.directory(), id),
            role: ws.env.people().find((person) => person.id === id)?.role,
          }));
          const agents = live.members.map((member) => ({
            member: memberById(ws.directory(), member.agentId),
            answerMode: member.answerMode ?? (live.leadAgentId === member.agentId ? "lead" : "mention"),
            focus: member.focus,
            gateEnabled: member.answerMode === "always",
          }));
          return [...people, ...agents];
        });
        const live = () => channel() ?? current;
        return (
          <ChannelDetails
            channel={{
              name: conversationName(ws.directory(), live()),
              visibility: channelVisibility(live()),
              topic: live().topic,
              description: live().description,
              createdBy: live().createdBy ? memberById(ws.directory(), live().createdBy?.id ?? "") : undefined,
              createdAt: Date.parse(live().createdAt),
              coordinatorRouting: channelRouting(live()) === "coordinator",
              leadAgentId: live().leadAgentId,
              archived: live().archived,
            }}
            members={members()}
            defaultTab={tab()}
            onTabChange={(next) => ws.setDetailsTab(next)}
            onClose={() => ws.closePanel()}
            onBack={() => ws.back()}
            onEditTopic={
              joined() && !live().archived
                ? () => ws.openDialog({ kind: "edit-meta", channelId: props.channelId, field: "topic" })
                : undefined
            }
            onEditDescription={
              joined() && !live().archived
                ? () => ws.openDialog({ kind: "edit-meta", channelId: props.channelId, field: "description" })
                : undefined
            }
            onAddMembers={
              joined() && !live().archived && kind !== "dm"
                ? () => ws.openDialog({ kind: "invite", channelId: props.channelId })
                : undefined
            }
            onRemoveMember={
              manage() && !live().archived
                ? (memberId) => {
                    if (ws.env.isReader(memberId)) void ws.leave(props.channelId);
                    else void ws.removeMember(props.channelId, memberId);
                  }
                : undefined
            }
            onAnswerModeChange={
              joined() && !live().archived
                ? (agentId, mode) => void ws.setMember(props.channelId, agentId, { answerMode: mode })
                : undefined
            }
            onFocusChange={
              joined() && !live().archived
                ? (agentId, focus) => void ws.setMember(props.channelId, agentId, { focus })
                : undefined
            }
            onGateChange={
              joined() && !live().archived
                ? (agentId, enabled) =>
                    void ws.setMember(props.channelId, agentId, { answerMode: enabled ? "always" : "always-no-gate" })
                : undefined
            }
            integrations={kind === "channel" ? <DiscordIntegration channelId={props.channelId} /> : undefined}
            answerLog={ws.isAdmin() ? <AnswerLog channelId={props.channelId} /> : undefined}
            onVisibilityChange={
              ws.isAdmin() && kind === "channel" && !live().archived
                ? (visibility) => void ws.setVisibility(props.channelId, visibility)
                : undefined
            }
            onCoordinatorRoutingChange={
              ws.isAdmin() && kind === "channel" && !live().archived
                ? (enabled) =>
                    void ws.setRouting(
                      props.channelId,
                      enabled ? "coordinator" : "responders",
                      enabled ? (live().leadAgentId ?? live().members[0]?.agentId) : undefined,
                    )
                : undefined
            }
            onLeadChange={
              ws.isAdmin() && kind === "channel" && !live().archived
                ? (agentId) => void ws.setRouting(props.channelId, channelRouting(live()), agentId)
                : undefined
            }
            onArchive={
              manage() && kind === "channel" && !live().archived ? () => void ws.archive(props.channelId) : undefined
            }
            onLeave={
              joined() && kind !== "dm" && humanIds(live()).length > 0
                ? () => void ws.leave(props.channelId)
                : undefined
            }
          />
        );
      }}
    </Show>
  );
}

const FALLBACK_LABEL = {
  timeout: "workspace.app.gate.timeout",
  error: "workspace.app.gate.error",
  invalid: "workspace.app.gate.invalid",
  interrupted: "workspace.app.gate.interrupted",
} as const satisfies Record<ChannelGateFallback, string>;

/**
 * Why each agent answered or stayed quiet on the newest messages of people, from the decisions of
 * the gate. Only owners and admins receive them.
 */
function AnswerLog(props: { channelId: string }) {
  const { t, format } = useText();
  const ws = useWorkspace();
  const decisions = createMemo(() => {
    const page = ws.channels.state.page;
    if (page?.channel.id !== props.channelId) return [];
    const result: { key: string; decision: ChannelGateDecision; text: string; at: number }[] = [];
    for (const entry of [...page.messages].reverse()) {
      for (const decision of entry.gateDecisions ?? [])
        result.push({
          key: `${entry.id}:${decision.agentId}`,
          decision,
          text: previewText(entry.message.text, 80),
          at: Date.parse(entry.message.createdAt),
        });
      if (result.length >= 12) break;
    }
    return result.slice(0, 12);
  });
  const outcome = (decision: ChannelGateDecision) =>
    decision.fallback
      ? t(FALLBACK_LABEL[decision.fallback])
      : decision.limited
        ? t("workspace.app.gate.limited")
        : decision.answer
          ? t("workspace.app.gate.answered")
          : t("workspace.app.gate.quiet");
  return (
    <section class="ws-answer-log" aria-label={t("workspace.app.gate.title")}>
      <h3 class="ws-details-section-title">{t("workspace.app.gate.title")}</h3>
      <Show when={decisions().length} fallback={<p class="ws-details-empty">{t("workspace.app.gate.empty")}</p>}>
        <ul class="ws-answer-log-list">
          <For each={decisions()} keyed={(item) => item.key}>
            {(item) => {
              const agent = () => memberById(ws.directory(), item().decision.agentId);
              return (
                <li class="ws-answer-log-item" data-answer={item().decision.answer ? "" : undefined}>
                  <MemberAvatar member={agent()} size="xs" />
                  <span class="ws-answer-log-copy">
                    <span class="ws-answer-log-head">
                      <strong>{agent().name}</strong> {outcome(item().decision)}
                      <Show when={item().decision.round === 2}>
                        <span class="ws-muted"> · {t("workspace.app.gate.round2")}</span>
                      </Show>
                      <span class="ws-muted">
                        {" · "}
                        {format.date(item().at, { hour: "numeric", minute: "2-digit" })}
                      </span>
                    </span>
                    <Show when={item().decision.reason}>
                      <span class="ws-answer-log-reason">{item().decision.reason}</span>
                    </Show>
                    <span class="ws-answer-log-message">“{item().text}”</span>
                  </span>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** The Discord bridge of a channel: the linked Discord channel, or a picker to link one. */
function DiscordIntegration(props: { channelId: string }) {
  const { t } = useText();
  const ws = useWorkspace();
  const link = () => {
    const page = ws.channels.state.page;
    const channel = page?.channel.id === props.channelId ? page.channel : ws.summary(props.channelId);
    return channel?.discordLink;
  };
  const admin = () => ws.isAdmin();
  const [servers, setServers] = createSignal<{ id: string; name: string }[] | null>(null);
  const [server, setServer] = createSignal<string>("");
  const [discordChannels, setDiscordChannels] = createSignal<{ id: string; name: string }[]>([]);
  const [discordChannel, setDiscordChannel] = createSignal<string>("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(
    () => admin() && !link(),
    (load) => {
      if (!load || servers() !== null) return;
      const api = ws.env.messaging?.();
      if (!api) {
        setServers([]);
        return;
      }
      void api
        .overview("discord")
        .then((overview) => {
          const list = overview.connections
            .filter((connection) => connection.platform === "discord")
            .map((connection) => ({ id: connection.workspaceId, name: connection.workspaceName }));
          setServers(list);
          if (list[0]) setServer(list[0].id);
        })
        .catch(() => setServers([]));
    },
  );
  createEffect(server, (id) => {
    setDiscordChannels([]);
    setDiscordChannel("");
    const api = ws.env.messaging?.();
    if (!id || !api) return;
    void api
      .discordChannels(id)
      .then((list) => {
        setDiscordChannels(list.channels);
        if (list.channels[0]) setDiscordChannel(list.channels[0].id);
      })
      .catch(() => setError(t("workspace.app.discord.channelsFailed")));
  });
  return (
    <div class="ws-integration">
      <div class="ws-integration-head">
        <span class="ws-integration-logo" aria-hidden="true">
          <Plug />
        </span>
        <span class="ws-integration-copy">
          <strong>{t("workspace.app.discord.title")}</strong>
          <span class="ws-muted">
            <Show when={link()} fallback={t("workspace.app.discord.notLinked")}>
              {(current) =>
                t(current().webhook ? "workspace.app.discord.linkedWebhook" : "workspace.app.discord.linkedBot", {
                  name: current().channelName,
                })
              }
            </Show>
          </span>
        </span>
        <Show when={link() && admin()}>
          <Button
            variant="outline"
            size="xs"
            disabled={busy()}
            onClick={async () => {
              setBusy(true);
              await ws.unlinkDiscord(props.channelId);
              setBusy(false);
            }}
          >
            {t("workspace.app.discord.unlink")}
          </Button>
        </Show>
      </div>
      <Show when={!link() && admin()}>
        <Show
          when={servers()?.length}
          fallback={
            <p class="ws-integration-note">
              {servers() === null ? t("workspace.app.discord.loading") : t("workspace.app.discord.noServers")}
            </p>
          }
        >
          <div class="ws-integration-form">
            <WorkspaceSelect
              label={t("workspace.app.discord.server")}
              prefix={t("workspace.app.discord.serverPrefix")}
              value={server()}
              options={(servers() ?? []).map((item) => ({ value: item.id, label: item.name }))}
              onChange={setServer}
            />
            <Show when={discordChannels().length}>
              <WorkspaceSelect
                label={t("workspace.app.discord.channel")}
                prefix="#"
                value={discordChannel()}
                options={discordChannels().map((item) => ({ value: item.id, label: item.name }))}
                onChange={setDiscordChannel}
              />
            </Show>
            <Button
              size="xs"
              disabled={!discordChannel() || busy()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                await ws.linkDiscord(props.channelId, server(), discordChannel());
                setBusy(false);
              }}
            >
              {t("workspace.app.discord.link")}
            </Button>
          </div>
        </Show>
      </Show>
      <Show when={error()}>
        {(message) => (
          <p class="ws-composer-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </div>
  );
}
