import { useText } from "@openbot/ui/text";
import { Loading, Match, Show, Switch } from "solid-js";
import { AgentUsagePanel, WorkflowsPage } from "../../lazy-views";
import { SkillsMarketplace } from "../../WorkspaceOverlays";
import { SchedulePanel } from "../schedule/SchedulePanel";
import { useServers } from "../servers/servers-context";
import { useUsage } from "../usage/usage-context";
import { SettingsPage } from "./SettingsPage";
import { useWindowPage } from "./window-page-context";

/**
 * The page of the desktop window that covers the conversation: a settings page, usage, schedule,
 * workflows or the Marketplace. The tasks page shows in the middle pane, in `WorkspaceShell`.
 */
export function WindowPageView() {
  const { t } = useText();
  const windowPage = useWindowPage();
  const usage = useUsage();
  const { servers } = useServers();
  /** Both settings pages show in the one Settings page. */
  const settingsOpen = () => windowPage.page() === "settings" || windowPage.page() === "server-settings";
  const hostName = (serverId: string) =>
    servers().find((server) => server.id === serverId)?.name ?? t("app.page.serverFallback");
  return (
    <Show
      when={settingsOpen() ? null : usage.state.serverId}
      fallback={
        <Show when={settingsOpen()} fallback={<SkillsMarketplace />}>
          <SettingsPage />
        </Show>
      }
    >
      {(serverId) => (
        <Switch
          fallback={
            <Loading>
              <AgentUsagePanel
                serverId={serverId()}
                hostName={hostName(serverId())}
                agentId={usage.state.agentId}
                onBack={usage.closeUsage}
              />
            </Loading>
          }
        >
          <Match when={usage.state.view === "schedule"}>
            <SchedulePanel serverId={serverId()} hostName={hostName(serverId())} onBack={usage.closeUsage} />
          </Match>
          <Match when={usage.state.view === "workflows"}>
            <Loading>
              <WorkflowsPage serverId={serverId()} />
            </Loading>
          </Match>
        </Switch>
      )}
    </Show>
  );
}
