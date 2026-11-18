import { channelKind, channelVisibility } from "@openbot/contracts/ipc";
import { Button, ConfirmDialog, FormDialog, Hash, Input, Lock, Search, Textarea } from "@openbot/ui";
import { CreateChannelDialog } from "@openbot/ui/features/workspace/CreateChannelDialog";
import { MemberPicker } from "@openbot/ui/features/workspace/MemberPicker";
import { NewMessageDialog } from "@openbot/ui/features/workspace/NewMessageDialog";
import { AiBadge, MemberAvatar } from "@openbot/ui/features/workspace/WorkspaceAvatar";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { WorkspaceSpaceDialogs } from "./WorkspaceSpaceDialogs";
import { useWorkspace } from "./workspace-context";
import {
  AGENT_DM_PREFIX,
  agentMember,
  channelMembers,
  conversationName,
  memberById,
  personMember,
  readerJoined,
} from "./workspace-model";

/** Every dialog of the workspace, one at a time. */
export function WorkspaceDialogs() {
  const ws = useWorkspace();
  const dialog = () => ws.state.dialog;
  const close = () => ws.openDialog(null);
  /** The people and agents the reader can add or message, without the reader. */
  const candidates = createMemo((): WorkspaceMember[] => [
    ...ws.env
      .people()
      .filter((person) => !ws.env.isReader(person.id))
      .map(personMember),
    // Only the agents of the space that shows: a channel or a DM is in one space.
    ...ws
      .spaceAgents()
      .filter((agent) => !ws.env.hiddenAgentIds().has(agent.id) && ws.canMessageAgent(agent.id))
      .map((agent) => agentMember(agent)),
  ]);
  return (
    <>
      <WorkspaceSpaceDialogs />
      <CreateChannelDialog
        open={dialog()?.kind === "create-channel"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        candidates={candidates()}
        existingNames={ws.channels.state.channels
          .filter((channel) => channelKind(channel) === "channel" && !channel.archived)
          .map((channel) => channel.name)}
        onCreate={(input) => ws.createChannel(input)}
      />
      <NewMessageDialog
        open={dialog()?.kind === "new-message"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        candidates={candidates()}
        onStart={(ids) => ws.startDm(ids)}
      />
      <Switch>
        <Match when={dialog()?.kind === "browse"}>
          <ChannelBrowser onClose={close} />
        </Match>
        <Match when={dialog()?.kind === "switcher"}>
          <QuickSwitcher onClose={close} />
        </Match>
        <Match
          when={(() => {
            const current = dialog();
            return current?.kind === "edit-meta" ? current : undefined;
          })()}
        >
          {(current) => <EditMetaDialog channelId={current().channelId} field={current().field} onClose={close} />}
        </Match>
        <Match
          when={(() => {
            const current = dialog();
            return current?.kind === "invite" ? current : undefined;
          })()}
        >
          {(current) => <InviteDialog channelId={current().channelId} candidates={candidates()} onClose={close} />}
        </Match>
      </Switch>
      <DeleteMessageDialog />
      <ChannelConfirmDialogs />
    </>
  );
}

/** A picker dialog: a search and a list that acts on a row, with no footer. */
function PickerDialog(props: { title: string; onClose: () => void; children: JSX.Element; size?: "md" | "lg" }) {
  return (
    <FormDialog
      open
      size={props.size}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={props.title}
    >
      {props.children}
    </FormDialog>
  );
}

/** The public channels the reader is not in, to join one. */
function ChannelBrowser(props: { onClose: () => void }) {
  const { t } = useText();
  const ws = useWorkspace();
  const [query, setQuery] = createSignal("");
  const channels = createMemo(() => {
    const text = query().trim().toLocaleLowerCase();
    return ws.channels.state.channels
      .filter(
        (channel) =>
          !channel.archived &&
          channelKind(channel) === "channel" &&
          ws.spaces.channelInCurrent(channel.id) &&
          (channelVisibility(channel) === "public" || readerJoined(ws.directory(), channel)) &&
          (!text ||
            channel.name.toLocaleLowerCase().includes(text) ||
            (channel.topic ?? "").toLocaleLowerCase().includes(text)),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  });
  return (
    <PickerDialog title={t("workspace.app.browse.title")} onClose={props.onClose} size="lg">
      <div class="ws-switcher-field">
        <Search aria-hidden="true" />
        <Input
          ref={(element) => {
            requestAnimationFrame(() => element.focus());
          }}
          value={query()}
          onValueChange={setQuery}
          placeholder={t("workspace.app.browse.search")}
          aria-label={t("workspace.app.browse.search")}
        />
      </div>
      <ul class="ws-browse-list">
        <For each={channels()} fallback={<li class="ws-details-empty">{t("workspace.app.browse.empty")}</li>}>
          {(channel) => {
            const joined = () => readerJoined(ws.directory(), channel);
            return (
              <li class="ws-browse-item">
                <span class="ws-browse-glyph" aria-hidden="true">
                  <Show when={channelVisibility(channel) === "private"} fallback={<Hash />}>
                    <Lock />
                  </Show>
                </span>
                <span class="ws-browse-copy">
                  <strong>{channel.name}</strong>
                  <span class="ws-muted">
                    {t("workspace.app.browse.members", { count: channelMembers(ws.directory(), channel).length })}
                    <Show when={channel.topic}>{(topic) => ` · ${topic()}`}</Show>
                  </span>
                </span>
                <Show
                  when={joined()}
                  fallback={
                    <Button
                      size="xs"
                      onClick={() => {
                        props.onClose();
                        void ws.join(channel.id);
                      }}
                    >
                      {t("workspace.app.channel.join")}
                    </Button>
                  }
                >
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      props.onClose();
                      ws.openChannel(channel.id);
                    }}
                  >
                    {t("workspace.app.browse.open")}
                  </Button>
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
      <footer class="ws-browse-footer">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            props.onClose();
            ws.openDialog({ kind: "create-channel" });
          }}
        >
          {t("workspace.app.browse.create")}
        </Button>
      </footer>
    </PickerDialog>
  );
}

interface SwitcherEntry {
  id: string;
  label: string;
  kind: "channel" | "dm" | "agent";
  private?: boolean;
  member?: WorkspaceMember;
  unread?: boolean;
  /** The name of the space of a conversation of another space. Opening it shows that space. */
  space?: string;
}

/** ⌘K: jump to a channel, a DM or an agent by name. */
function QuickSwitcher(props: { onClose: () => void }) {
  const { t } = useText();
  const ws = useWorkspace();
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const entries = createMemo((): SwitcherEntry[] => {
    const list: SwitcherEntry[] = [];
    // Every space: a conversation of another space says which one, and opening it shows that space.
    const elsewhere = (spaceId: string) =>
      ws.spaces.available() && spaceId !== ws.spaces.current() ? { space: ws.spaces.space(spaceId)?.name } : {};
    for (const channel of ws.channels.state.channels) {
      if (channel.archived || !readerJoined(ws.directory(), channel)) continue;
      const kind = channelKind(channel);
      list.push({
        ...elsewhere(ws.spaces.channelSpace(channel.id)),
        id: channel.id,
        label: conversationName(ws.directory(), channel),
        kind: kind === "channel" ? "channel" : "dm",
        private: channelVisibility(channel) === "private",
        member:
          kind === "channel"
            ? undefined
            : channelMembers(ws.directory(), channel).find((member) => !ws.env.isReader(member.id)),
        unread: channel.unreadCount > 0,
      });
    }
    for (const agent of ws.env.agents()) {
      if (ws.env.hiddenAgentIds().has(agent.id) || !ws.canMessageAgent(agent.id)) continue;
      list.push({
        ...elsewhere(ws.spaces.agentSpace(agent.id)),
        id: `${AGENT_DM_PREFIX}${agent.id}`,
        label: agent.name,
        kind: "agent",
        member: memberById(ws.directory(), agent.id),
      });
    }
    for (const person of ws.env.people()) {
      if (ws.env.isReader(person.id)) continue;
      list.push({ id: `person:${person.id}`, label: person.name, kind: "dm", member: personMember(person) });
    }
    // The space that shows comes first.
    list.sort((left, right) => Number(left.space !== undefined) - Number(right.space !== undefined));
    const text = query().trim().toLocaleLowerCase();
    if (!text) return list.filter((entry) => entry.kind !== "dm" || !entry.id.startsWith("person:")).slice(0, 30);
    return list
      .map((entry) => {
        const name = entry.label.toLocaleLowerCase();
        const rank = name.startsWith(text)
          ? 0
          : name.split(/[\s\-_,]+/u).some((word) => word.startsWith(text))
            ? 1
            : name.includes(text)
              ? 2
              : -1;
        return { entry, rank };
      })
      .filter((item) => item.rank >= 0)
      .sort((left, right) => left.rank - right.rank)
      .map((item) => item.entry)
      .slice(0, 30);
  });
  const choose = (entry: SwitcherEntry | undefined) => {
    if (!entry) return;
    props.onClose();
    if (entry.id.startsWith("person:")) ws.messageMember(entry.id.slice("person:".length));
    else ws.openConversation(entry.id);
  };
  return (
    <PickerDialog title={t("workspace.app.switcher.title")} onClose={props.onClose}>
      <div class="ws-switcher-field">
        <Search aria-hidden="true" />
        <Input
          ref={(element) => {
            requestAnimationFrame(() => element.focus());
          }}
          value={query()}
          onValueChange={(value) => {
            setQuery(value);
            setActive(0);
          }}
          placeholder={t("workspace.app.switcher.placeholder")}
          aria-label={t("workspace.app.switcher.placeholder")}
          onKeyDown={(event: KeyboardEvent) => {
            const count = entries().length;
            if (event.key === "ArrowDown" && count) {
              event.preventDefault();
              setActive((index) => (index + 1) % count);
            } else if (event.key === "ArrowUp" && count) {
              event.preventDefault();
              setActive((index) => (index - 1 + count) % count);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(entries()[active()]);
            }
          }}
        />
      </div>
      <ul class="ws-switcher-list" aria-label={t("workspace.app.switcher.results")}>
        <For each={entries()} fallback={<li class="ws-details-empty">{t("workspace.app.switcher.empty")}</li>}>
          {(entry, index) => (
            <li>
              <Button
                variant="ghost"
                class="ws-switcher-item"
                data-active={active() === index() ? "" : undefined}
                data-unread={entry.unread ? "" : undefined}
                onMouseEnter={() => setActive(index())}
                onClick={() => choose(entry)}
              >
                <span class="ws-switcher-glyph" aria-hidden="true">
                  <Show
                    when={entry.member}
                    fallback={
                      <Show when={entry.private} fallback={<Hash />}>
                        <Lock />
                      </Show>
                    }
                  >
                    {(member) => <MemberAvatar member={member()} size="xs" />}
                  </Show>
                </span>
                <span class="ws-switcher-label">{entry.label}</span>
                <Show when={entry.kind === "agent"}>
                  <AiBadge />
                </Show>
                <Show when={entry.space}>{(space) => <span class="ws-switcher-space">{space()}</span>}</Show>
              </Button>
            </li>
          )}
        </For>
      </ul>
    </PickerDialog>
  );
}

function EditMetaDialog(props: { channelId: string; field: "topic" | "description"; onClose: () => void }) {
  const { t } = useText();
  const ws = useWorkspace();
  const channel = () => ws.summary(props.channelId);
  const [value, setValue] = createSignal(channel()?.[props.field] ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    const done = await ws.setMeta(props.channelId, { [props.field]: value().trim() });
    setBusy(false);
    if (done === true) props.onClose();
    else setError(done);
  };
  return (
    <FormDialog
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={t(props.field === "topic" ? "workspace.app.meta.topicTitle" : "workspace.app.meta.descriptionTitle")}
      description={t(props.field === "topic" ? "workspace.app.meta.topicHint" : "workspace.app.meta.descriptionHint")}
      error={error()}
      busy={busy()}
      submitLabel={t("common.save")}
      onSubmit={() => void save()}
    >
      <Show
        when={props.field === "topic"}
        fallback={
          <Textarea
            value={value()}
            maxlength={2000}
            rows={5}
            onValueChange={setValue}
            aria-label={t("workspace.details.description")}
          />
        }
      >
        <Input value={value()} maxlength={250} onValueChange={setValue} aria-label={t("workspace.details.topic")} />
      </Show>
    </FormDialog>
  );
}

function InviteDialog(props: { channelId: string; candidates: readonly WorkspaceMember[]; onClose: () => void }) {
  const { t } = useText();
  const ws = useWorkspace();
  const [ids, setIds] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const present = createMemo(() => {
    const channel = ws.summary(props.channelId);
    return new Set(channel ? channelMembers(ws.directory(), channel).map((member) => member.id) : []);
  });
  const name = () => {
    const channel = ws.summary(props.channelId);
    return channel ? conversationName(ws.directory(), channel) : "";
  };
  const add = async () => {
    setBusy(true);
    setError(null);
    const done = await ws.invite(props.channelId, ids());
    setBusy(false);
    if (done === true) props.onClose();
    else setError(done);
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={t("workspace.app.invite.title", { name: name() })}
      description={t("workspace.app.invite.description")}
      error={error()}
      busy={busy()}
      submitLabel={t("workspace.app.invite.add")}
      submitDisabled={ids().length === 0}
      onSubmit={() => void add()}
    >
      <MemberPicker
        autofocus
        label={t("workspace.app.invite.label")}
        candidates={props.candidates.filter((member) => !present().has(member.id))}
        selectedIds={ids()}
        onChange={setIds}
      />
    </FormDialog>
  );
}

function DeleteMessageDialog() {
  const { t } = useText();
  const ws = useWorkspace();
  const target = () => {
    const dialog = ws.state.dialog;
    return dialog?.kind === "delete-message" ? dialog : null;
  };
  return (
    <ConfirmDialog
      open={target() !== null}
      tone="destructive"
      title={t("workspace.app.message.deleteTitle")}
      description={t("workspace.app.message.deleteDescription")}
      confirmLabel={t("workspace.app.message.delete")}
      onCancel={() => ws.openDialog(null)}
      onConfirm={async () => {
        const current = target();
        if (!current) return;
        await ws.deleteMessage(current.channelId, current.messageId);
        ws.openDialog(null);
      }}
    />
  );
}

/**
 * The confirms of a channel: leave a private channel, delete a channel, take someone out. Each
 * shows its failure inside and stays open (docs/ux/standard.md § 6).
 */
function ChannelConfirmDialogs() {
  const { t } = useText();
  const ws = useWorkspace();
  const [error, setError] = createSignal<string | null>(null);
  const dialog = () => {
    const current = ws.state.dialog;
    return current?.kind === "leave" || current?.kind === "archive" || current?.kind === "remove-member"
      ? current
      : null;
  };
  const channelName = () => {
    const current = dialog();
    const channel = current ? ws.summary(current.channelId) : undefined;
    return channel ? conversationName(ws.directory(), channel) : "";
  };
  const memberName = () => {
    const current = dialog();
    return current?.kind === "remove-member" ? memberById(ws.directory(), current.memberId).name : "";
  };
  const close = () => {
    setError(null);
    ws.openDialog(null);
  };
  const confirm = async () => {
    const current = dialog();
    if (!current) return;
    setError(null);
    const result =
      current.kind === "leave"
        ? await ws.leave(current.channelId)
        : current.kind === "archive"
          ? await ws.archive(current.channelId)
          : await ws.removeMember(current.channelId, current.memberId);
    if (result === true) close();
    else setError(result);
  };
  return (
    <ConfirmDialog
      open={dialog() !== null}
      tone={dialog()?.kind === "archive" ? "destructive" : "default"}
      title={
        dialog()?.kind === "leave"
          ? t("workspace.confirm.leaveTitle", { name: channelName() })
          : dialog()?.kind === "archive"
            ? t("sidebar.delete.title", { name: channelName() })
            : t("workspace.confirm.removeTitle", { name: memberName(), channel: channelName() })
      }
      description={
        dialog()?.kind === "leave"
          ? t("workspace.confirm.leaveDescription")
          : dialog()?.kind === "archive"
            ? t("sidebar.delete.channelDescription")
            : t("workspace.confirm.removeDescription")
      }
      confirmLabel={
        dialog()?.kind === "leave"
          ? t("workspace.details.leave")
          : dialog()?.kind === "archive"
            ? t("sidebar.channelMenu.delete")
            : t("common.remove")
      }
      error={error() ?? undefined}
      onCancel={close}
      onConfirm={confirm}
    />
  );
}
