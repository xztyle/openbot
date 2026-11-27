import type { McpChatGrant, McpChatSnapshot } from "@openbot/contracts/team-protocol/mcp-chat-v1";
import { FormDialog, LoadingState, NativeSelect, SettingsGroup, SettingsRow, Text } from "@openbot/ui";
import { createUniqueId, For, Show } from "solid-js";
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
/** One app: its name on the left, Off, Read or Write on the right. A choice applies at once. */
function ChatAppRow(props: { id: string; name: string; dialog: ChatAppsDialogProps }) {
  const { t } = useText();
  const controlId = `chat-app-${createUniqueId()}`;
  const mode = () => props.dialog.snapshot.grants.find((grant) => grant.connectionId === props.id)?.mode ?? "off";
  return (
    <SettingsRow layout="inline" label={props.name} controlId={controlId}>
      <NativeSelect
        id={controlId}
        value={mode()}
        disabled={props.dialog.busy}
        onChange={(event) => {
          const value = event.currentTarget.value;
          props.dialog.onMode(props.id, value === "read" || value === "write" ? value : "off");
        }}
      >
        <For each={["off", "read", "write"] as const}>
          {(value) => <option value={value}>{t(MODE_LABEL[value])}</option>}
        </For>
      </NativeSelect>
    </SettingsRow>
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
      <Show when={props.snapshot.connections.length > 0}>
        <SettingsGroup label={t("mcp.chat.title")}>
          <For each={props.snapshot.connections}>{(connection) => <ChatAppRow {...connection} dialog={props} />}</For>
        </SettingsGroup>
      </Show>
      <Show when={!props.loading && props.snapshot.connections.length === 0}>
        <Text>{t("mcp.chat.empty")}</Text>
      </Show>
      <Text variant="body-sm">{t("mcp.chat.readHint")}</Text>
      <Text variant="body-sm">{t("mcp.chat.limit")}</Text>
    </FormDialog>
  );
}
