import { GENERAL_SPACE_ID, type StorageHygieneArea } from "@openbot/contracts/ipc";
import { StorageView } from "@openbot/ui/features/workspace/StorageView";
import { createStorageHygieneState } from "../storage-hygiene/storage-hygiene-state";
import { useWorkspace } from "./workspace-context";

/** The Storage view of the workspace: what the projects take on the host disk and their cleanup. */
export function WorkspaceStorageView() {
  const ws = useWorkspace();
  const storage = createStorageHygieneState(() => ws.env.storageHygiene?.());
  const state = () => storage.data();
  /** The areas of the space that shows: its project folders and the workspaces of its agents. */
  const spaceReport = () => {
    const report = state()?.report ?? null;
    if (!report || !ws.spaces.available()) return report;
    const shown = (area: StorageHygieneArea) =>
      area.kind === "agent"
        ? area.agentId === undefined || ws.spaces.agentInCurrent(area.agentId)
        : (area.spaceId ?? GENERAL_SPACE_ID) === ws.spaces.current();
    const areas = report.areas.filter(shown);
    const ids = new Set(areas.map((area) => area.id));
    return {
      ...report,
      areas,
      folders: report.folders.filter((folder) => ids.has(folder.areaId)),
      items: report.items.filter((item) => ids.has(item.areaId)),
    };
  };
  return (
    <StorageView
      phase={storage.phase()}
      report={spaceReport()}
      scanning={state()?.scan.running ?? false}
      scanEntries={state()?.scan.entries}
      cleaning={state()?.cleanup.running ?? false}
      lastCleanup={state()?.lastCleanup ?? null}
      recentMinutes={storage.settings().recentMinutes}
      staleIdleHours={storage.settings().staleIdleHours}
      evidenceDeleteAfterDays={storage.settings().evidenceDeleteAfterDays}
      areaName={(area) =>
        area.kind === "agent"
          ? (ws.env.agents().find((agent) => agent.id === area.agentId)?.name ?? area.name)
          : area.name
      }
      onRescan={() => void storage.rescan()}
      onCleanup={storage.cleanup}
      onOpenRules={ws.env.openStorageRules}
      onBack={() => ws.back()}
    />
  );
}
