/*
 * "Needs you": the top bar's button with the count and the list. It shows the one decision queue
 * (`useDecisionQueue`): the count and the list are the space that shows, and what waits in the other
 * spaces is one line under them. A row opens the exact place where the request waits.
 */
import { NeedsYouButton } from "@openbot/ui/features/workspace/NeedsYou";
import type { useDecisionQueue } from "./workspace-decisions";

export function WorkspaceNeedsYouButton(props: { queue: ReturnType<typeof useDecisionQueue> }) {
  return (
    <NeedsYouButton rows={props.queue.hereRows()} others={props.queue.elsewhereRows()} onOpen={props.queue.open} />
  );
}
