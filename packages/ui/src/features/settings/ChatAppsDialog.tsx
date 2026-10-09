import type { McpChatGrant, McpChatSnapshot } from "@openbot/contracts/team-protocol/mcp-chat-v1";
import { Button, Dialog, Field, Text } from "@openbot/ui";
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
    <Field label={props.name}>
      <div class="mcp-connect-footer">
        <For each={["off", "read", "write"] as const}>
          {(value) => (
            <Button
              type="button"
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
    </Field>
  );
}
export function ChatAppsDialog(props: ChatAppsDialogProps) {
  const { t } = useText();
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="mcp-connect-backdrop">
          <Dialog.Content class="mcp-connect-dialog" as="section">
            <header class="mcp-connect-header">
              <Dialog.Title>{t("mcp.chat.title")}</Dialog.Title>
              <Dialog.Description>{t("mcp.chat.description")}</Dialog.Description>
            </header>
            <div class="mcp-connect-form">
              <Show when={props.loading}>
                <Text>{t("common.loading")}</Text>
              </Show>
              <For each={props.snapshot.connections}>
                {(connection) => <ChatAppRow {...connection} dialog={props} />}
              </For>
              <Show when={!props.loading && props.snapshot.connections.length === 0}>
                <Text>{t("mcp.chat.empty")}</Text>
              </Show>
              <Text variant="body-sm">{t("mcp.chat.readHint")}</Text>
              <Text variant="body-sm">{t("mcp.chat.limit")}</Text>
              <Show when={props.error}>
                <Text role="alert">{props.error}</Text>
              </Show>
              <div class="mcp-connect-footer">
                <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
                  {t("common.cancel")}
                </Button>
                <Button
                  loading={props.busy}
                  disabled={!props.loaded || props.loading || props.busy}
                  onClick={props.onSave}
                >
                  {t("common.save")}
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
