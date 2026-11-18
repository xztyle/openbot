import { channelKind } from "@openbot/contracts/ipc";
import { ConfirmDialog, FormDialog, Input, Textarea } from "@openbot/ui";
import { CreateChannelDialog } from "@openbot/ui/features/workspace/CreateChannelDialog";
import { MemberPicker } from "@openbot/ui/features/workspace/MemberPicker";
import { NewMessageDialog } from "@openbot/ui/features/workspace/NewMessageDialog";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { ChannelBrowser } from "./WorkspaceBrowse";
import { WorkspaceSpaceDialogs } from "./WorkspaceSpaceDialogs";
import { QuickSwitcher } from "./WorkspaceSwitcher";
import { useWorkspace } from "./workspace-context";
import { agentMember, channelMembers, conversationName, memberById, personMember } from "./workspace-model";

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
        initialName={(() => {
          const current = dialog();
          return current?.kind === "create-channel" ? current.name : undefined;
        })()}
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
