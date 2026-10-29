import { StorageView } from "@openbot/ui/features/workspace/StorageView";
import { createStorageHygieneState } from "../storage-hygiene/storage-hygiene-state";
import { useWorkspace } from "./workspace-context";

/** The Storage view of the workspace: what the projects take on the host disk and their cleanup. */
export function WorkspaceStorageView() {
  const ws = useWorkspace();
  const storage = createStorageHygieneState(() => ws.env.storageHygiene?.());
  const state = () => storage.data();
  return (
    <StorageView
      phase={storage.phase()}
      report={state()?.report ?? null}
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
