import { handler, type IpcGroupHandlers } from "./define-ipc-group";

interface WorkspaceLinkIpcDependencies {
  /** The workspace message link that arrived before a window could be told, taken exactly once. */
  takePendingWorkspaceLink: () => string | null;
}

/**
 * The workspace message deep link, and nothing else. A link names a message; the renderer opens
 * its channel and thread only when the reader can see them, and does nothing else with it.
 */
export function workspaceLinkIpcHandlers({
  takePendingWorkspaceLink,
}: WorkspaceLinkIpcDependencies): Pick<IpcGroupHandlers, "workspaceLinks"> {
  return {
    workspaceLinks: {
      takePendingLink: handler(takePendingWorkspaceLink),
    },
  };
}
