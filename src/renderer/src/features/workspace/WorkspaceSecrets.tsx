import {
  WORKSPACE_SECRET_NAME_PATTERN,
  WORKSPACE_SHARED_SECRET_SCOPE,
  type WorkspaceSecret,
} from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { type SecretsGroup, SecretsView } from "@openbot/ui/features/workspace/SecretsView";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, onSettled } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { memberById } from "./workspace-model";

/** The Secrets view: the agent key store of the host, for its owner and admins. */
export function WorkspaceSecretsView() {
  const { t } = useText();
  const ws = useWorkspace();
  const agent = () => ws.channels.port().agent;
  const [secrets, setSecrets] = createSignal<WorkspaceSecret[] | null>(null);

  async function refresh() {
    const list = agent().workspaceSecrets;
    if (!list) {
      setSecrets([]);
      return;
    }
    try {
      setSecrets((await list()).secrets);
    } catch {
      setSecrets([]);
      toast.error(t("workspace.secrets.failed"));
    }
  }
  onSettled(() => void refresh());

  /** Runs a change, says how it went, and reads the list again. A failure is thrown on for the form. */
  async function change(run: () => Promise<void>, done: string) {
    try {
      await run();
      toast.success(done);
    } catch (error) {
      toast.error(t("workspace.secrets.failed"));
      throw error;
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
      scopes={scopes()}
      namePattern={WORKSPACE_SECRET_NAME_PATTERN}
      onReveal={reveal}
      onCopy={async (scope, name) => {
        const value = await reveal(scope, name);
        await navigator.clipboard.writeText(value);
        toast.success(t("workspace.secrets.copied", { name }));
      }}
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
    />
  );
}
