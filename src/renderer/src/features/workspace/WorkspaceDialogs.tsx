import { channelKind, channelVisibility } from "@openbot/contracts/ipc";
import { Button, ConfirmDialog, Hash, IconButton, Input, Lock, Search, Textarea, X } from "@openbot/ui";
import { Dialog } from "@openbot/ui/complex";
import { CreateChannelDialog } from "@openbot/ui/features/workspace/CreateChannelDialog";
import { MemberPicker } from "@openbot/ui/features/workspace/MemberPicker";
import { NewMessageDialog } from "@openbot/ui/features/workspace/NewMessageDialog";
import { AiBadge, MemberAvatar } from "@openbot/ui/features/workspace/WorkspaceAvatar";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
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
    ...ws.env
      .agents()
      .filter((agent) => !ws.env.hiddenAgentIds().has(agent.id))
      .map((agent) => agentMember(agent)),
  ]);
  return (
    <>
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
    </>
  );
}

function DialogFrame(props: {
  title: string;
  description?: string;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
  class?: string;
}) {
  const { t } = useText();
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay>
          <Dialog.Content
            as="section"
            class={["ws-dialog", props.class]}
            onOpenAutoFocus={(event: Event) => event.preventDefault()}
          >
            <header class="ws-dialog-header">
              <Dialog.Title class="ws-dialog-title">{props.title}</Dialog.Title>
              <IconButton variant="ghost" label={t("common.close")} onClick={() => props.onClose()}>
                <X />
              </IconButton>
            </header>
            <div class="ws-dialog-body">
              <Show when={props.description}>
                <Dialog.Description class="ws-dialog-description">{props.description}</Dialog.Description>
              </Show>
              {props.children}
            </div>
            <Show when={props.footer}>
              <footer class="ws-dialog-footer">{props.footer}</footer>
            </Show>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
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
          (channelVisibility(channel) === "public" || readerJoined(ws.directory(), channel)) &&
          (!text ||
            channel.name.toLocaleLowerCase().includes(text) ||
            (channel.topic ?? "").toLocaleLowerCase().includes(text)),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  });
  return (
    <DialogFrame title={t("workspace.app.browse.title")} onClose={props.onClose} class="ws-dialog-wide">
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
    </DialogFrame>
  );
}

interface SwitcherEntry {
  id: string;
  label: string;
  kind: "channel" | "dm" | "agent";
  private?: boolean;
  member?: WorkspaceMember;
  unread?: boolean;
}

/** ⌘K: jump to a channel, a DM or an agent by name. */
function QuickSwitcher(props: { onClose: () => void }) {
  const { t } = useText();
  const ws = useWorkspace();
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const entries = createMemo((): SwitcherEntry[] => {
    const list: SwitcherEntry[] = [];
    for (const channel of ws.channels.state.channels) {
      if (channel.archived || !readerJoined(ws.directory(), channel)) continue;
      const kind = channelKind(channel);
      list.push({
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
      if (ws.env.hiddenAgentIds().has(agent.id)) continue;
      list.push({
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
    <DialogFrame title={t("workspace.app.switcher.title")} onClose={props.onClose} class="ws-switcher">
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
              </Button>
            </li>
          )}
        </For>
      </ul>
    </DialogFrame>
  );
}

function EditMetaDialog(props: { channelId: string; field: "topic" | "description"; onClose: () => void }) {
  const { t } = useText();
  const ws = useWorkspace();
  const channel = () => ws.summary(props.channelId);
  const [value, setValue] = createSignal(channel()?.[props.field] ?? "");
  const [busy, setBusy] = createSignal(false);
  const save = async () => {
    setBusy(true);
    const done = await ws.setMeta(props.channelId, { [props.field]: value().trim() });
    setBusy(false);
    if (done) props.onClose();
  };
  return (
    <DialogFrame
      title={t(props.field === "topic" ? "workspace.app.meta.topicTitle" : "workspace.app.meta.descriptionTitle")}
      description={t(props.field === "topic" ? "workspace.app.meta.topicHint" : "workspace.app.meta.descriptionHint")}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => props.onClose()}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy()} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Show
        when={props.field === "topic"}
        fallback={
          <Textarea
            ref={(element: HTMLTextAreaElement) => {
              requestAnimationFrame(() => element.focus());
            }}
            value={value()}
            maxlength={2000}
            rows={5}
            onValueChange={setValue}
            aria-label={t("workspace.details.description")}
          />
        }
      >
        <Input
          ref={(element) => {
            requestAnimationFrame(() => element.focus());
          }}
          value={value()}
          maxlength={250}
          onValueChange={setValue}
          aria-label={t("workspace.details.topic")}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter") void save();
          }}
        />
      </Show>
    </DialogFrame>
  );
}

function InviteDialog(props: { channelId: string; candidates: readonly WorkspaceMember[]; onClose: () => void }) {
  const { t } = useText();
  const ws = useWorkspace();
  const [ids, setIds] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const present = createMemo(() => {
    const channel = ws.summary(props.channelId);
    return new Set(channel ? channelMembers(ws.directory(), channel).map((member) => member.id) : []);
  });
  const name = () => {
    const channel = ws.summary(props.channelId);
    return channel ? conversationName(ws.directory(), channel) : "";
  };
  return (
    <DialogFrame
      title={t("workspace.app.invite.title", { name: name() })}
      description={t("workspace.app.invite.description")}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => props.onClose()}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={busy()}
            disabled={ids().length === 0}
            onClick={async () => {
              setBusy(true);
              const done = await ws.invite(props.channelId, ids());
              setBusy(false);
              if (done) props.onClose();
            }}
          >
            {t("workspace.app.invite.add")}
          </Button>
        </>
      }
    >
      <MemberPicker
        autofocus
        label={t("workspace.app.invite.label")}
        candidates={props.candidates.filter((member) => !present().has(member.id))}
        selectedIds={ids()}
        onChange={setIds}
      />
    </DialogFrame>
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
