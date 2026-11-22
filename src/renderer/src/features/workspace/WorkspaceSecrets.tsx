import {
  WORKSPACE_SECRET_NAME_PATTERN,
  WORKSPACE_SHARED_SECRET_SCOPE,
  type WorkspaceSecret,
} from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { ConnectionsSection } from "@openbot/ui/features/workspace/ConnectionsSection";
import { MailboxesSection } from "@openbot/ui/features/workspace/MailboxesSection";
import { type SecretsGroup, SecretsView } from "@openbot/ui/features/workspace/SecretsView";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { writeClipboardText, writeClipboardTextLater } from "../../clipboard";
import { useWorkspace } from "./workspace-context";
import { memberById } from "./workspace-model";

/** The Secrets view: the agent key store of the host, for its owner and admins. */
export function WorkspaceSecretsView() {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  const agent = () => ws.channels.port().agent;
  const [secrets, setSecrets] = createSignal<WorkspaceSecret[] | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  async function refresh() {
    const list = agent().workspaceSecrets;
    if (!list) {
      setSecrets([]);
      return;
    }
    try {
      setSecrets((await list()).secrets);
      setLoadError(null);
    } catch (error) {
      // The view says the list did not load, with Retry; an empty list would say there are no keys.
      if (secrets() === null) setLoadError(errorMessage(error, t("workspace.secrets.loadFailed")));
      else toast.error(t("workspace.secrets.loadFailed"));
    }
  }
  onSettled(() => {
    void refresh();
    void ws.env.connectorAccess?.refresh();
    void ws.env.agentMailboxes?.refresh();
  });

  /** Runs a change and reads the list again. A failure is thrown on: the form or the confirm shows it. */
  async function change(run: () => Promise<void>, done: string) {
    try {
      await run();
      toast.success(done);
    } finally {
      void refresh();
    }
  }

  async function reveal(scope: string, name: string): Promise<string> {
    const read = agent().workspaceSecretRead;
    if (!read) throw new Error("unsupported");
    try {
      return (await read({ scope, name })).value;
    } catch (error) {
      toast.error(t("workspace.secrets.failed"));
      throw error;
    }
  }

  /**
   * Copies a link, a token or a secret. A refused write is a toast: the button gives no other sign,
   * and a token that shows once must not look copied when it is not.
   */
  async function copy(text: string | Promise<string>, done: string) {
    let read = true;
    try {
      if (typeof text === "string") await writeClipboardText(text);
      else
        await writeClipboardTextLater(
          text.catch((error: unknown) => {
            read = false;
            throw error;
          }),
        );
    } catch {
      // A failed read has its own toast.
      if (read) toast.error(t("app.clipboard.copyFailed"));
      return;
    }
    toast.success(done);
  }

  const agents = createMemo(() => ws.env.agents());
  const groups = createMemo((): SecretsGroup[] | null => {
    const list = secrets();
    if (!list) return null;
    const scopes = [WORKSPACE_SHARED_SECRET_SCOPE, ...new Set(list.map((secret) => secret.scope))];
    return [...new Set(scopes)].map((scope) => ({
      scope,
      ...(scope === WORKSPACE_SHARED_SECRET_SCOPE ? {} : { agent: memberById(ws.directory(), scope) }),
      secrets: list.filter((secret) => secret.scope === scope).sort((a, b) => a.name.localeCompare(b.name)),
    }));
  });
  const scopes = createMemo(() => [
    { value: WORKSPACE_SHARED_SECRET_SCOPE, label: t("workspace.secrets.shared") },
    ...agents().map((item) => ({ value: item.id, label: item.name })),
  ]);

  return (
    <SecretsView
      groups={groups()}
      loadError={loadError()}
      onRetry={() => {
        setLoadError(null);
        void refresh();
      }}
      scopes={scopes()}
      namePattern={WORKSPACE_SECRET_NAME_PATTERN}
      onReveal={reveal}
      // The read starts in the tap, so Safari still lets the copy write the clipboard after it.
      onCopy={(scope, name) => copy(reveal(scope, name), t("workspace.secrets.copied", { name }))}
      onSave={(input) => {
        const save = agent().workspaceSecretSave;
        return change(
          async () => {
            if (!save) throw new Error("unsupported");
            await save(input);
          },
          t("workspace.secrets.saved", { name: input.name }),
        );
      }}
      onRemove={(scope, name) => {
        const remove = agent().workspaceSecretRemove;
        return change(
          async () => {
            if (!remove) throw new Error("unsupported");
            await remove({ scope, name });
          },
          t("workspace.secrets.deleted", { name }),
        );
      }}
      onBack={() => ws.back()}
      footer={
        <>
          <Show when={ws.env.connectorAccess?.state()}>
            {(state) => (
              <ConnectionsSection
                state={state()}
                spaceId={ws.spaces.current()}
                onCreateToken={(label) => {
                  const store = ws.env.connectorAccess;
                  if (!store) throw new Error("unsupported");
                  return store.createToken(label);
                }}
                onRevokeToken={async (id) => {
                  await ws.env.connectorAccess?.revokeToken(id);
                  toast.success(t("workspace.connections.revoked"));
                }}
                onSetSender={async (input) => {
                  await ws.env.connectorAccess?.setSender(input);
                }}
                onCopy={(text) => copy(text, t("workspace.connections.copied"))}
              />
            )}
          </Show>
          <Show when={ws.env.agentMailboxes?.state()}>
            {(state) => (
              <MailboxesSection
                state={state()}
                spaceId={ws.spaces.current()}
                agents={agents().filter((agent) => ws.spaces.agentInCurrent(agent.id))}
                onSave={async (input) => {
                  const store = ws.env.agentMailboxes;
                  if (!store) throw new Error("unsupported");
                  await store.save(input);
                  toast.success(t("workspace.mailboxes.saved", { address: input.address }));
                }}
                onRemove={async (id) => {
                  await ws.env.agentMailboxes?.remove(id);
                }}
                onSetWorker={async (workerUrl) => {
                  await ws.env.agentMailboxes?.setWorker(workerUrl);
                }}
                onNewSecret={async () => {
                  const store = ws.env.agentMailboxes;
                  if (!store) throw new Error("unsupported");
                  try {
                    return await store.newSecret();
                  } catch (error) {
                    toast.error(t("workspace.mailboxes.failed"));
                    throw error;
                  }
                }}
                onCopy={(text) => copy(text, t("workspace.connections.copied"))}
              />
            )}
          </Show>
        </>
      }
    />
  );
}
