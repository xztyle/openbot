import type { SecretOverview, SecretVaultCall, SecretVaultResult } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { SecretsVault } from "@openbot/ui/features/secrets/SecretsVault";
import { ConnectionsSection } from "@openbot/ui/features/workspace/ConnectionsSection";
import { MailboxesSection } from "@openbot/ui/features/workspace/MailboxesSection";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { writeClipboardText, writeClipboardTextLater } from "../../clipboard";
import { useWorkspace } from "./workspace-context";
import { memberById } from "./workspace-model";

/**
 * The keys and passwords screen: the host's key store, for its owner and admins, on the desktop, the
 * web and the phone through the same channels port. Values stay on the host until the owner shows or
 * copies one.
 */
export function WorkspaceSecretsView() {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  const agent = () => ws.channels.port().agent;
  const [overview, setOverview] = createSignal<SecretOverview | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  async function call(input: SecretVaultCall): Promise<SecretVaultResult> {
    const vault = agent().workspaceVault;
    if (!vault) throw new Error(t("secrets.failed"));
    return vault(input);
  }

  async function refresh() {
    try {
      const result = await call({ kind: "overview" });
      if (result.kind === "overview") setOverview(result);
      setLoadError(null);
    } catch (error) {
      // The view says the list did not load, with Retry; an empty list would say there are no keys.
      if (overview() === null) setLoadError(errorMessage(error, t("secrets.loadFailed")));
      else toast.error(t("secrets.loadFailed"));
    }
  }
  onSettled(() => {
    void refresh();
    void ws.env.connectorAccess?.refresh();
    void ws.env.agentMailboxes?.refresh();
  });

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
      else toast.error(t("secrets.failed"));
      return;
    }
    toast.success(done);
  }

  const agents = createMemo(() => ws.env.agents());
  const members = createMemo(() => agents().map((item) => memberById(ws.directory(), item.id)));
  const spaces = createMemo(() => ws.spaces.list().map((space) => ({ id: space.id, name: space.name })));

  return (
    <SecretsVault
      overview={overview()}
      loadError={loadError()}
      onRetry={() => {
        setLoadError(null);
        void refresh();
      }}
      agents={members()}
      spaces={spaces()}
      owner={ws.env.secretsOwner?.() === true}
      call={call}
      // The read starts in the tap, so Safari still lets the copy write the clipboard after it.
      copyValue={(value, name) => copy(value, t("secrets.value.copied", { name }))}
      refresh={() => void refresh()}
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
