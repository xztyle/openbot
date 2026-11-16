import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { SidebarLayoutAction } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { z } from "zod";
import type { SidebarLayoutStore } from "../sidebar-layout-store";
import { layoutForSpace, sectionInSpace } from "../spaces/space-scope";
import { openBotToolFailure, openBotToolResult } from "./routine-tools";
import { ToolOperationFailed, toolStep, toToolOperationFailed } from "./tool-operation";

const sectionId = z.string().min(1).max(INPUT_LIMITS.identifier);
const name = z.string().trim().min(1).max(INPUT_LIMITS.sidebarSectionName);
export const createSectionToolSchema = z.object({ name }).strict();
export const renameSectionToolSchema = z.object({ sectionId, name }).strict();
export const deleteSectionToolSchema = z.object({ sectionId }).strict();
export const assignAgentSectionToolSchema = z
  .object({
    agentId: z.string().min(1).max(INPUT_LIMITS.identifier),
    sectionId: sectionId.nullable(),
  })
  .strict();

export type AgentSidebar = Pick<SidebarLayoutStore, "getSnapshot" | "mutate" | "withProfileAssignment">;

export const handleSidebarTool = Effect.fn("SidebarTools.handle")(function* (
  tool: string,
  args: unknown,
  sidebar: AgentSidebar | null,
  agentIds: ReadonlySet<string>,
  /** Whether an agent or channel id is in the caller's space. The caller reads and changes only those. */
  visible: (id: string) => boolean = () => true,
) {
  let action: SidebarLayoutAction | null;
  switch (tool) {
    case "list_sections":
      action = null;
      break;
    case "create_section":
      action = { type: "create", ...(yield* toolStep(() => createSectionToolSchema.parse(args))) };
      break;
    case "rename_section":
      action = { type: "rename", ...(yield* toolStep(() => renameSectionToolSchema.parse(args))) };
      break;
    case "delete_section":
      action = { type: "delete", ...(yield* toolStep(() => deleteSectionToolSchema.parse(args))) };
      break;
    case "assign_agent_section":
      action = { type: "assign", ...(yield* toolStep(() => assignAgentSectionToolSchema.parse(args))) };
      break;
    default:
      return null;
  }
  if (!sidebar) return yield* new ToolOperationFailed({ cause: new Error("Sidebar sections are unavailable.") });
  // A section that holds an agent or a channel of another space belongs to that space too.
  if (
    (action?.type === "rename" || action?.type === "delete" || (action?.type === "assign" && action.sectionId)) &&
    !sectionInSpace(
      sidebar.getSnapshot(),
      action.type === "assign" ? (action.sectionId ?? "") : action.sectionId,
      visible,
    )
  )
    return openBotToolFailure(sourceText("error.backend.spaceOtherSection"));
  // The whole roster, so that the mutation does not take the items of other spaces for deleted ones.
  const layout = action ? yield* sidebar.mutate(action, agentIds).pipe(toToolOperationFailed) : sidebar.getSnapshot();
  return openBotToolResult(layoutForSpace(layout, visible));
});
