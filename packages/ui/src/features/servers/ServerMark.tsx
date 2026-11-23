import type { HostedServerSleep, ServerConnectionState, ServerSummary } from "@openbot/contracts/ipc";
import type { AppTextKey, AppTranslate } from "@openbot/i18n";
import { ServerGradientLogo } from "@openbot/ui";
import { createEffect, createSignal, Show } from "solid-js";

const SERVER_STATE_LABELS = {
  online: "server.state.online",
  connecting: "server.state.connecting",
  offline: "server.state.offline",
  error: "server.state.error",
  incompatible: "server.state.incompatible",
} as const satisfies Record<ServerConnectionState, AppTextKey>;

const HOSTED_SLEEP_LABELS = {
  sleeping: "server.state.sleeping",
  waking: "server.state.waking",
} as const satisfies Record<HostedServerSleep, AppTextKey>;

/** Whether a hosted server that is not connected sleeps or wakes. It replaces the connection state word. */
export function serverHostedSleep(server: Pick<ServerSummary, "hostedSleep" | "state">): HostedServerSleep | null {
  return server.state === "online" ? null : (server.hostedSleep ?? null);
}

/** The muted and connection state words that a server's accessible name adds after its name. */
export function serverStatusLabels(
  server: Pick<ServerSummary, "hostedSleep" | "notificationsMuted" | "state">,
  t: AppTranslate,
): string[] {
  const sleep = serverHostedSleep(server);
  return [
    ...(server.notificationsMuted ? [t("server.rail.notificationsMuted")] : []),
    ...(sleep ? [t(HOSTED_SLEEP_LABELS[sleep])] : []),
    ...(sleep || server.state === "online" ? [] : [t(SERVER_STATE_LABELS[server.state])]),
  ];
}

/** The logo of a server, or a gradient made from its id when it has no logo or the logo fails. */
export function ServerMark(props: { server: ServerSummary }) {
  const [failed, setFailed] = createSignal(false);
  createEffect(
    () => props.server.logoUrl,
    () => {
      setFailed(false);
    },
  );
  return (
    <Show when={!failed() ? props.server.logoUrl : null} fallback={<ServerGradientLogo seed={props.server.id} />}>
      {(url) => <img class="server-rail-logo" src={url()} alt="" draggable={false} onError={() => setFailed(true)} />}
    </Show>
  );
}
