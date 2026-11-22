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
import { IconButton } from "../../button";
import { ConfirmDialog } from "../../confirm-dialog";
import { Field, Input } from "../../form";
import { FormDialog } from "../../form-dialog";
import { Copy, Pencil, Trash2 } from "../../icons";
import { useText } from "../../text";
import { WorkspaceList, WorkspaceListRow } from "./WorkspaceList";
import { PaneHeaderAction } from "./WorkspacePaneHeader";
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

  return (
    <>
      <section class="ws-secrets-group">
        <h3 class="ws-secrets-group-title">{t("workspace.mailboxes.title")}</h3>
        <p class="ws-muted">{t("workspace.mailboxes.description")}</p>
        <Show when={!props.state.inboxUrl}>
          <p class="ws-muted">{t("workspace.mailboxes.gatewayOff")}</p>
        </Show>
        <WorkspaceList>
          <WorkspaceListRow
            title={t("workspace.mailboxes.worker")}
            actions={
              <>
                <Show when={props.state.inboxUrl}>
                  {(url) => (
                    <IconButton
                      variant="ghost"
                      size="icon-xs"
                      label={t("workspace.mailboxes.copyInbox")}
                      onClick={() => void props.onCopy(url())}
                    >
                      <Copy />
                    </IconButton>
                  )}
                </Show>
                <IconButton
                  variant="ghost"
                  size="icon-xs"
                  label={t("workspace.mailboxes.linkWorker")}
                  onClick={() => {
                    setWorkerUrl(props.state.workerUrl ?? "");
                    setError(null);
                    setWorkerOpen(true);
                  }}
                >
                  <Pencil />
                </IconButton>
              </>
            }
          >
            <span class="ws-muted">{props.state.workerUrl ?? t("workspace.mailboxes.workerUnset")}</span>
            <span class="ws-muted">
              {props.state.hasSecret ? t("workspace.mailboxes.secretSet") : t("workspace.mailboxes.secretUnset")}
            </span>
            <Show when={props.state.lastMailAt}>
              {(time) => (
                <span class="ws-muted">
                  {t("workspace.mailboxes.lastMail", {
                    time: when(time()),
                    status: String(props.state.lastStatus ?? ""),
                  })}
                </span>
              )}
            </Show>
          </WorkspaceListRow>
        </WorkspaceList>
        <PaneHeaderAction
          label={t("workspace.mailboxes.newSecret")}
          onClick={() =>
            void run(async () => {
              setSecret(await props.onNewSecret());
            })
          }
        />
        <Show when={mailboxes().length > 0} fallback={<p class="ws-muted">{t("workspace.mailboxes.empty")}</p>}>
          <WorkspaceList>
            <For each={mailboxes()} keyed={(mailbox) => mailbox.id}>
              {(mailbox) => (
                <WorkspaceListRow
                  title={mailbox().address}
                  actions={
                    <>
                      <IconButton
                        variant="ghost"
                        size="icon-xs"
                        label={t("workspace.mailboxes.edit")}
                        onClick={() => {
                          setError(null);
                          setDraft({
                            id: mailbox().id,
                            address: mailbox().address,
                            agentId: mailbox().agentId,
                            mode: mailbox().mode,
                            displayName: mailbox().displayName,
                          });
                        }}
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="icon-xs"
                        label={t("workspace.mailboxes.remove")}
                        onClick={() => {
                          setRemoveError(null);
                          setRemoving(mailbox());
                        }}
                      >
                        <Trash2 />
                      </IconButton>
                    </>
                  }
                >
                  <span class="ws-muted">
                    {t("workspace.mailboxes.line", {
                      agent: mailbox().agentName,
                      mode: t(MODE_LABEL[mailbox().mode]),
                    })}
                  </span>
                  <span class="ws-muted">
                    {t("workspace.mailboxes.stats", {
                      received: String(mailbox().received),
                      sent: String(mailbox().sentToday),
                    })}
                  </span>
                </WorkspaceListRow>
              )}
            </For>
          </WorkspaceList>
        </Show>
        <Show when={props.agents.length > 0}>
          <PaneHeaderAction
            label={t("workspace.mailboxes.add")}
            onClick={() => {
              setError(null);
              setDraft({ address: "", agentId: props.agents[0]?.id ?? "", mode: "reply", displayName: "" });
            }}
          />
        </Show>
      </section>
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
          // A refused removal keeps the question open with the reason: the address still gets mail.
          try {
            if (mailbox) await props.onRemove(mailbox.id);
            setRemoving(null);
          } catch (cause) {
            setRemoveError(errorMessage(cause, t("workspace.mailboxes.failed")));
          }
        }}
      />
    </>
  );
}
