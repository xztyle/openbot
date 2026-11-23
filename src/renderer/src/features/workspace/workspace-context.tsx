import { createContext, type ParentProps, useContext } from "solid-js";
import type { WorkspaceController } from "./workspace-controller";

// `null` when no workspace is mounted: a context with no default throws on a read with no provider.
const WorkspaceContext = createContext<WorkspaceController | null>(null);

export function useWorkspace(): WorkspaceController {
  const controller = useContext(WorkspaceContext);
  if (!controller) throw new Error("The workspace is unavailable outside WorkspaceProvider.");
  return controller;
}

/** The workspace, or null where none is mounted, such as an agent chat of the desktop app. */
export function useOptionalWorkspace(): WorkspaceController | null {
  return useContext(WorkspaceContext);
}

/** Mounts a workspace controller that a shell built with its own environment. */
export function WorkspaceProvider(props: ParentProps<{ controller: WorkspaceController }>) {
  return <WorkspaceContext value={props.controller}>{props.children}</WorkspaceContext>;
}
