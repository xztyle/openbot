import type { BitwardenConnectorStatus } from "@openbot/contracts/ipc";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  Button,
  Input,
  Lock,
  SettingsSection,
  Text,
  TriangleAlert,
} from "@openbot/ui";
import { createEffect, createSignal, Show } from "solid-js";
import { useText } from "../../text";
import { DangerZone, DetailHeader } from "./IntegrationLayout";

export interface BitwardenConnectorPanelProps {
  status: BitwardenConnectorStatus;
  busy: boolean;
  /** The status could not be read, so "Not connected" would be a guess. */
  statusFailed?: boolean | undefined;
  onConnect: (sessionKey: string) => void;
  onDisconnect: () => void;
  /** Stops a connect that waits for the Bitwarden CLI. It never ends a connection that stands. */
  onCancel?: (() => void) | undefined;
  /** Reads the status again after a failed read. */
  onRetryStatus?: (() => void) | undefined;
}

export function BitwardenConnectorPanel(props: BitwardenConnectorPanelProps) {
  const { t } = useText();
  const [key, setKey] = createSignal("");
  /* The key leaves the field when the connection holds it, not when it was sent: a refused key is
     one the user fixes, and a field that emptied would make them type it all again. */
  createEffect(
    () => props.status.connected,
    (connected) => {
      if (connected) setKey("");
    },
  );
  const unknown = () => props.statusFailed === true && !props.status.connected;
  const statusLabel = () => {
    if (props.status.connected) return t("connector.bitwarden.connected");
    return unknown() ? t("connector.bitwarden.statusUnknown") : t("connector.bitwarden.disconnected");
  };
  return (
    <div class="onepassword-connector">
      <DetailHeader
        logo={<Lock />}
        name={t("connector.bitwarden.title")}
        subtitle={t("connector.bitwarden.description")}
        status={props.status.connected ? "connected" : unknown() ? "attention" : "idle"}
        statusLabel={statusLabel()}
      />
      <Show when={unknown()}>
        <Alert tone="warning" role="alert">
          <AlertIcon>
            <TriangleAlert />
          </AlertIcon>
          <AlertContent>
            <AlertDescription>{t("connector.bitwarden.statusFailed")}</AlertDescription>
          </AlertContent>
          <Show when={props.onRetryStatus}>
            {(retry) => (
              <AlertActions>
                <Button type="button" size="sm" onClick={() => retry()()}>
                  {t("common.retry")}
                </Button>
              </AlertActions>
            )}
          </Show>
        </Alert>
      </Show>
      <Text variant="body-sm" tone="muted">
        {t("connector.bitwarden.scope")}
      </Text>
      <Text variant="body-sm" tone="muted">
        {t("connector.bitwarden.session")}
      </Text>
      <Show
        when={!props.status.connected}
        fallback={
          <DangerZone
            title={t("connector.bitwarden.disconnectTitle")}
            description={t("connector.bitwarden.disconnectSummary")}
            action={t("connector.bitwarden.disconnect")}
            busy={props.busy}
            confirm
            onAction={() => props.onDisconnect()}
          />
        }
      >
        <SettingsSection title={t("connector.bitwarden.connect")} description={t("connector.bitwarden.setup")}>
          <form
            class="onepassword-connector-token"
            onSubmit={(event) => {
              event.preventDefault();
              const value = key().trim();
              if (!value || props.busy) return;
              props.onConnect(value);
            }}
          >
            <Input
              type="password"
              autocomplete="off"
              spellcheck={false}
              aria-label={t("connector.bitwarden.sessionKey")}
              value={key()}
              disabled={props.busy}
              onInput={(event) => setKey(event.currentTarget.value)}
            />
            <Button type="submit" loading={props.busy} disabled={!key().trim()}>
              {t("connector.bitwarden.connect")}
            </Button>
          </form>
          <Show when={props.busy && props.onCancel}>
            {(cancel) => (
              <Button type="button" variant="ghost" onClick={() => cancel()()}>
                {t("common.cancel")}
              </Button>
            )}
          </Show>
        </SettingsSection>
      </Show>
    </div>
  );
}
