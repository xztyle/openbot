import {
  AGENT_MAILBOX_MODES,
  AGENT_MAILBOX_NAME_LIMIT,
  type AgentMailbox,
  type AgentMailboxesState,
  type AgentMailboxInput,
  type AgentMailboxMode,
} from "@openbot/contracts/team-protocol/agent-mailboxes-v1";
import type { AppTextKey } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Badge } from "../../badge";
import { Button, IconButton } from "../../button";
import { ConfirmDialog } from "../../confirm-dialog";
import { Field, Input } from "../../form";
import { FormDialog } from "../../form-dialog";
import { Copy, KeyRound, Pencil, Plus, Trash2 } from "../../icons";
import { SettingsGroup, SettingsRow } from "../../settings";
import { SwitchField } from "../../switch";
import { useText } from "../../text";
import { WorkspaceSelect } from "./WorkspaceSelect";

export interface MailboxesSectionProps {
  state: AgentMailboxesState;
  /** The space whose addresses show; a new address goes to an agent of it. */
  spaceId: string;
  agents: readonly { id: string; name: string }[];
  onSave: (input: AgentMailboxInput) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onSetWorker: (workerUrl: string) => Promise<void>;
  onNewSecret: () => Promise<string>;
  onCopy: (text: string) => Promise<void>;
}

const MODE_LABEL = {
  reply: "workspace.mailboxes.modeReply",
  "write-first": "workspace.mailboxes.modeWriteFirst",
} as const satisfies Record<AgentMailboxMode, AppTextKey>;

const MODE_HINT = {
  reply: "workspace.mailboxes.modeReplyHint",
  "write-first": "workspace.mailboxes.modeWriteFirstHint",
} as const satisfies Record<AgentMailboxMode, AppTextKey>;

interface Draft {
  id?: string;
  address: string;
  agentId: string;
  mode: AgentMailboxMode;
  displayName: string;
  ownerApprovesEverySend: boolean;
}

/**
 * Agent mailboxes, under Secrets: a business address such as `ventas@aprendivo.com` bound to one
 * agent of this space, reply only (the default) or may write first, and the link to the mail Worker
 * that carries the mail.
 */
export function MailboxesSection(props: MailboxesSectionProps): JSX.Element {
  const { t, format, errorMessage } = useText();
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [removing, setRemoving] = createSignal<AgentMailbox | null>(null);
  const [removeError, setRemoveError] = createSignal<string | null>(null);
  /** Set while the owner confirms a new mail secret: the one the Worker holds stops working at once. */
  const [replacingSecret, setReplacingSecret] = createSignal(false);
  const [workerOpen, setWorkerOpen] = createSignal(false);
  const [workerUrl, setWorkerUrl] = createSignal("");
  const [secret, setSecret] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const mailboxes = createMemo(() => props.state.mailboxes.filter((mailbox) => mailbox.spaceId === props.spaceId));
  const when = (time: number) => format.date(time, { dateStyle: "medium", timeStyle: "short" });
  const update = (change: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...change } : current));

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause, t("workspace.mailboxes.failed")));
    } finally {
      setBusy(false);
    }
  }

  const newSecret = () =>
    run(async () => {
      setSecret(await props.onNewSecret());
    });

  const workerLinked = () => Boolean(props.state.workerUrl && props.state.hasSecret && props.state.inboxUrl);
  const addMailbox = () => {
    setError(null);
    setDraft({
      address: "",
      agentId: props.agents[0]?.id ?? "",
      mode: "reply",
      displayName: "",
      ownerApprovesEverySend: false,
    });
  };

  return (
    <>
      <SettingsGroup
        title={t("workspace.mailboxes.title")}
        description={t("workspace.mailboxes.description")}
        actions={
          <Show when={props.agents.length > 0}>
            <Button variant="outline" size="sm" onClick={addMailbox}>
              <Plus />
              {t("workspace.mailboxes.add")}
            </Button>
          </Show>
        }
      >
        <SettingsRow
          label={t("workspace.mailboxes.worker")}
          description={
            props.state.lastMailAt
              ? t("workspace.mailboxes.lastMail", {
                  time: when(props.state.lastMailAt),
                  status: String(props.state.lastStatus ?? ""),
                })
              : workerLinked()
                ? t("workspace.mailboxes.noMailYet")
                : t("workspace.mailboxes.workerUnsetShort")
          }
          help={
            <details class="ws-technical">
              <summary>{t("workspace.connections.technical")}</summary>
              <span class="ws-technical-body">
                <Show when={!props.state.inboxUrl}>
                  <span>{t("workspace.mailboxes.gatewayOff")}</span>
                </Show>
                <span class="ws-secrets-mono">{props.state.workerUrl ?? t("workspace.mailboxes.workerUnset")}</span>
                <span>
                  {props.state.hasSecret ? t("workspace.mailboxes.secretSet") : t("workspace.mailboxes.secretUnset")}
                </span>
                <span class="ws-technical-actions">
                  <Show when={props.state.inboxUrl}>
                    {(url) => (
                      <Button variant="ghost" size="sm" onClick={() => void props.onCopy(url())}>
                        <Copy />
                        {t("workspace.mailboxes.copyInbox")}
                      </Button>
                    )}
                  </Show>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setWorkerUrl(props.state.workerUrl ?? "");
                      setError(null);
                      setWorkerOpen(true);
                    }}
                  >
                    <Pencil />
                    {t("workspace.mailboxes.linkWorker")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (props.state.hasSecret) setReplacingSecret(true);
                      else void newSecret();
                    }}
                  >
                    <KeyRound />
                    {t("workspace.mailboxes.newSecret")}
                  </Button>
                </span>
              </span>
            </details>
          }
        >
          <Badge variant={workerLinked() ? "success-light" : "warning-light"}>
            {workerLinked() ? t("workspace.mailboxes.statusOn") : t("workspace.mailboxes.statusOff")}
          </Badge>
        </SettingsRow>
        <Show when={mailboxes().length > 0} fallback={<SettingsRow label={t("workspace.mailboxes.empty")} />}>
          <For each={mailboxes()} keyed={(mailbox) => mailbox.id}>
            {(mailbox) => {
              const agent = () => props.agents.find((candidate) => candidate.id === mailbox().agentId);
              return (
                <SettingsRow
                  layout="inline"
                  class="ws-mailbox-row"
                  label={<span class="ws-secrets-mono">{mailbox().address}</span>}
                  description={t("workspace.mailboxes.line", {
                    agent: agent()?.name ?? mailbox().agentName,
                    mode: mailbox().ownerApprovesEverySend
                      ? t("workspace.mailboxes.modeWithOwnerApproval", { mode: t(MODE_LABEL[mailbox().mode]) })
                      : t(MODE_LABEL[mailbox().mode]),
                  })}
                  help={t("workspace.mailboxes.stats", {
                    received: format.number(mailbox().received),
                    sent: format.number(mailbox().sentToday),
                  })}
                >
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    label={t("workspace.mailboxes.edit")}
                    onClick={() => {
                      setError(null);
                      setDraft({
                        id: mailbox().id,
                        address: mailbox().address,
                        agentId: mailbox().agentId,
                        mode: mailbox().mode,
                        displayName: mailbox().displayName,
                        ownerApprovesEverySend: mailbox().ownerApprovesEverySend,
                      });
                    }}
                  >
                    <Pencil />
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    label={t("workspace.mailboxes.remove")}
                    onClick={() => {
                      setRemoveError(null);
                      setRemoving(mailbox());
                    }}
                  >
                    <Trash2 />
                  </IconButton>
                </SettingsRow>
              );
            }}
          </For>
        </Show>
      </SettingsGroup>
      <FormDialog
        open={draft() !== null}
        onOpenChange={(open) => {
          if (open) return;
          setDraft(null);
          setError(null);
        }}
        title={draft()?.id ? t("workspace.mailboxes.edit") : t("workspace.mailboxes.add")}
        description={t("workspace.mailboxes.addDescription")}
        size="sm"
        busy={busy()}
        error={error()}
        submitLabel={t("workspace.mailboxes.save")}
        submitDisabled={!draft()?.address.trim() || !draft()?.agentId}
        onSubmit={() =>
          void run(async () => {
            const current = draft();
            if (!current) return;
            await props.onSave({
              ...(current.id ? { id: current.id } : {}),
              address: current.address.trim(),
              agentId: current.agentId,
              mode: current.mode,
              ownerApprovesEverySend: current.ownerApprovesEverySend,
              ...(current.displayName.trim() ? { displayName: current.displayName.trim() } : {}),
            });
            setDraft(null);
          })
        }
      >
        <Field label={t("workspace.mailboxes.address")} required>
          <Input
            type="email"
            value={draft()?.address ?? ""}
            maxlength={254}
            placeholder={t("workspace.mailboxes.addressPlaceholder")}
            onValueChange={(address) => update({ address })}
          />
        </Field>
        <Field label={t("workspace.mailboxes.agent")}>
          <WorkspaceSelect
            value={draft()?.agentId ?? ""}
            options={props.agents.map((agent) => ({ value: agent.id, label: agent.name }))}
            label={t("workspace.mailboxes.agent")}
            onChange={(agentId) => update({ agentId })}
          />
        </Field>
        <Field label={t("workspace.mailboxes.mode")}>
          <WorkspaceSelect
            value={draft()?.mode ?? "reply"}
            options={AGENT_MAILBOX_MODES.map((value) => ({ value, label: t(MODE_LABEL[value]) }))}
            label={t("workspace.mailboxes.mode")}
            onChange={(mode) => update({ mode })}
          />
        </Field>
        <p class="ws-muted">{t(MODE_HINT[draft()?.mode ?? "reply"])}</p>
        <SwitchField
          checked={draft()?.ownerApprovesEverySend ?? false}
          onChange={(ownerApprovesEverySend: boolean) => update({ ownerApprovesEverySend })}
          label={t("workspace.mailboxes.ownerApprovesEverySend")}
          description={t("workspace.mailboxes.ownerApprovesEverySendHint")}
        />
        <Field label={t("workspace.mailboxes.displayName")}>
          <Input
            value={draft()?.displayName ?? ""}
            maxlength={AGENT_MAILBOX_NAME_LIMIT}
            placeholder={t("workspace.mailboxes.displayNamePlaceholder")}
            onValueChange={(displayName) => update({ displayName })}
          />
        </Field>
      </FormDialog>
      <FormDialog
        open={workerOpen()}
        onOpenChange={(open) => {
          if (open) return;
          setWorkerOpen(false);
          setError(null);
        }}
        title={t("workspace.mailboxes.linkWorker")}
        description={t("workspace.mailboxes.linkWorkerDescription")}
        size="sm"
        busy={busy()}
        error={error()}
        submitLabel={t("workspace.mailboxes.save")}
        onSubmit={() =>
          void run(async () => {
            await props.onSetWorker(workerUrl().trim());
            setWorkerOpen(false);
          })
        }
      >
        <Field label={t("workspace.mailboxes.workerUrl")}>
          <Input
            type="url"
            value={workerUrl()}
            maxlength={2_048}
            class="ws-secrets-mono"
            placeholder={t("workspace.mailboxes.workerUrlPlaceholder")}
            onValueChange={setWorkerUrl}
          />
        </Field>
      </FormDialog>
      <FormDialog
        open={secret() !== null}
        onOpenChange={(open) => {
          if (!open) setSecret(null);
        }}
        title={t("workspace.mailboxes.newSecretTitle")}
        description={t("workspace.mailboxes.newSecretDescription")}
        size="sm"
        submitLabel={t("workspace.mailboxes.copySecret")}
        onSubmit={() => {
          const shown = secret();
          if (shown) void props.onCopy(shown);
        }}
      >
        <Field label={t("workspace.mailboxes.secret")}>
          <Input readonly value={secret() ?? ""} class="ws-secrets-mono" />
        </Field>
      </FormDialog>
      <ConfirmDialog
        open={removing() !== null}
        tone="destructive"
        title={t("workspace.mailboxes.removeTitle")}
        description={t("workspace.mailboxes.removeDescription", { address: removing()?.address ?? "" })}
        confirmLabel={t("workspace.mailboxes.remove")}
        error={removeError()}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const mailbox = removing();
          // A refused remove keeps the dialog open with the reason: mail to the address still arrives.
          try {
            if (mailbox) await props.onRemove(mailbox.id);
            setRemoving(null);
          } catch (cause) {
            setRemoveError(errorMessage(cause, t("workspace.mailboxes.failed")));
          }
        }}
      />
      <ConfirmDialog
        open={replacingSecret()}
        tone="destructive"
        title={t("workspace.mailboxes.replaceSecretTitle")}
        description={t("workspace.mailboxes.replaceSecretDescription")}
        confirmLabel={t("workspace.mailboxes.replaceSecret")}
        onCancel={() => setReplacingSecret(false)}
        onConfirm={async () => {
          setReplacingSecret(false);
          await newSecret();
        }}
      />
    </>
  );
}
