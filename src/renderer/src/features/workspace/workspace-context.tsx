import { createContext, type ParentProps, useContext } from "solid-js";
import type { WorkspaceController } from "./workspace-controller";

const WorkspaceContext = createContext<WorkspaceController>();

export function useWorkspace(): WorkspaceController {
  return useContext(WorkspaceContext);
}

/** Mounts a workspace controller that a shell built with its own environment. */
export function WorkspaceProvider(props: ParentProps<{ controller: WorkspaceController }>) {
  return <WorkspaceContext value={props.controller}>{props.children}</WorkspaceContext>;
}
