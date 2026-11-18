import type { McpChatGrant, McpChatSnapshot } from "@openbot/contracts/team-protocol/mcp-chat-v1";
import { Button, FormDialog, FormSection, LoadingState, Text } from "@openbot/ui";
import { For, Show } from "solid-js";
import { useText } from "../../text";

const MODE_LABEL = { off: "mcp.chat.off", read: "mcp.chat.read", write: "mcp.chat.write" } as const;
export interface ChatAppsDialogProps {
  open: boolean;
  busy: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  snapshot: McpChatSnapshot;
  onMode: (id: string, mode: McpChatGrant["mode"] | "off") => void;
  onSave: () => void;
  onClose: () => void;
}
function ChatAppRow(props: { id: string; name: string; dialog: ChatAppsDialogProps }) {
  const { t } = useText();
  const mode = () => props.dialog.snapshot.grants.find((grant) => grant.connectionId === props.id)?.mode ?? "off";
  return (
    <FormSection title={props.name}>
      <div class="chat-apps-modes">
        <For each={["off", "read", "write"] as const}>
          {(value) => (
            <Button
              type="button"
              size="sm"
              variant={mode() === value ? "default" : "outline"}
              aria-pressed={mode() === value ? "true" : "false"}
              disabled={props.dialog.busy}
              onClick={() => props.dialog.onMode(props.id, value)}
            >
              {t(MODE_LABEL[value])}
            </Button>
          )}
        </For>
      </div>
    </FormSection>
  );
}

/** Which chat apps an agent in a chat may read or write: the shared `FormDialog`. */
export function ChatAppsDialog(props: ChatAppsDialogProps) {
  const { t } = useText();
  return (
    <FormDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={t("mcp.chat.title")}
      description={t("mcp.chat.description")}
      error={props.error}
      busy={props.busy}
      submitLabel={t("common.save")}
      submitDisabled={!props.loaded || props.loading}
      onSubmit={props.onSave}
    >
      <Show when={props.loading}>
        <LoadingState rows={2} label={t("mcp.chat.title")} />
      </Show>
      <For each={props.snapshot.connections}>{(connection) => <ChatAppRow {...connection} dialog={props} />}</For>
      <Show when={!props.loading && props.snapshot.connections.length === 0}>
        <Text>{t("mcp.chat.empty")}</Text>
      </Show>
      <Text variant="body-sm">{t("mcp.chat.readHint")}</Text>
      <Text variant="body-sm">{t("mcp.chat.limit")}</Text>
    </FormDialog>
  );
}
