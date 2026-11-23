import { Show } from "solid-js";
import { useAgents } from "../agents/agents-context";
import { useServers } from "../servers/servers-context";
import { hostSetupProviderProps } from "./host-setup-provider-props";
import { ServerOnboarding } from "./ServerOnboarding";
import { useHostProviderSettings } from "./setup-provider-props";

/** The provider step of a joined server with no agents. */
export function WorkspaceServerOnboarding() {
  const { setServerSetupChoice } = useAgents();
  const { activeServer } = useServers();
  const settings = useHostProviderSettings();
  return (
    <Show when={settings()}>
      {(host) => (
        <ServerOnboarding
          serverName={activeServer()?.name ?? ""}
          setup={hostSetupProviderProps(host())}
          onContinue={(provider, model) => setServerSetupChoice({ preferredProvider: provider, preferredModel: model })}
        />
      )}
    </Show>
  );
}
