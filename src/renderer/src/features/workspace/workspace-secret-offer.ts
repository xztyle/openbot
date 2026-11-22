/*
 * What the composer does with a key or a password that the reader pasted: the message leaves with a
 * marker where the secret was, and a notice offers to save the secret in Secrets as a shared key.
 * The value stays only in this notice: when it closes unsaved, the secret is gone from Atelier.
 */
import { WORKSPACE_SHARED_SECRET_SCOPE } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { type FoundSecret, freeSecretName, type SecretScan, scanForSecrets } from "./secret-hygiene";
import { useWorkspace } from "./workspace-context";

/** A notice stays this long: the reader may need a moment to decide, and nothing else waits on it. */
const OFFER_DURATION_MS = 60_000;
/** One message seldom holds more; more notices would cover the screen. */
const OFFERS_LIMIT = 3;

export function useSecretHygiene(): {
  /** The text to send, and the secrets that were taken out of it. */
  scan: (text: string) => SecretScan;
  /** Shows the save notice of each found secret. */
  offer: (found: readonly FoundSecret[]) => void;
} {
  const { t } = useText();
  const ws = useWorkspace();
  const agent = () => ws.channels.port().agent;

  async function save(secret: FoundSecret): Promise<void> {
    const port = agent();
    try {
      if (!port.workspaceSecretSave || !port.workspaceSecrets) throw new Error("unsupported");
      // Never over a key that exists: that key may be the one an agent uses now.
      const taken = new Set(
        (await port.workspaceSecrets()).secrets
          .filter((item) => item.scope === WORKSPACE_SHARED_SECRET_SCOPE)
          .map((item) => item.name),
      );
      const name = freeSecretName(secret.name, taken);
      await port.workspaceSecretSave({ scope: WORKSPACE_SHARED_SECRET_SCOPE, name, value: secret.value });
      toast.success(t("workspace.secretHygiene.saved", { name }));
    } catch (error) {
      toast.error(t("workspace.secretHygiene.saveFailed"), { error });
    }
  }

  return {
    scan: (text) => scanForSecrets(text, (secret) => t("workspace.secretHygiene.marker", { label: secret.label })),
    offer: (found) => {
      for (const secret of found.slice(0, OFFERS_LIMIT))
        toast.warning(t("workspace.secretHygiene.title", { label: secret.label }), {
          description: t("workspace.secretHygiene.body"),
          duration: OFFER_DURATION_MS,
          ...(agent().workspaceSecretSave
            ? { action: { label: t("workspace.secretHygiene.save"), onClick: () => void save(secret) } }
            : {}),
        });
    },
  };
}
