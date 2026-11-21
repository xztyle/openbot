import type { WorkspaceView } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type { TextValue } from "@openbot/ui/text";

/** The name of a workspace view, as its header, Jump to and the tab title show it. */
export function workspaceViewLabel(view: WorkspaceView, t: TextValue["t"]): string {
  switch (view) {
    case "unreads":
      return t("workspace.view.unreads");
    case "threads":
      return t("workspace.view.threads");
    case "activity":
      return t("workspace.view.activity");
    case "dms":
      return t("workspace.view.dms");
    case "later":
      return t("workspace.view.later");
    case "drafts":
      return t("workspace.view.drafts");
    case "fleet":
      return t("workspace.view.fleet");
    case "org":
      return t("workspace.view.org");
    case "artifacts":
      return t("workspace.view.artifacts");
    case "agents":
      return t("workspace.view.agents");
    case "space-agents":
      return t("workspace.view.spaceAgents");
    case "storage":
      return t("storageHygiene.title");
    case "secrets":
      return t("workspace.view.secrets");
    case "reviews":
      return t("efficiency.view.title");
    case "loops":
      return t("workspace.view.loops");
    case "routines":
      return t("workspace.app.menu.routines");
    case "search":
      return t("workspace.view.search");
  }
}
