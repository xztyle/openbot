/*
 * "Needs you": the top bar's button with the count and the list. It shows the one decision queue of
 * every space (`useDecisionQueue`), the same list as Today, so the counts agree. A row opens the
 * exact place where the request waits.
 */
import { NeedsYouButton } from "@openbot/ui/features/workspace/NeedsYou";
import type { useDecisionQueue } from "./workspace-decisions";

export function WorkspaceNeedsYouButton(props: { queue: ReturnType<typeof useDecisionQueue> }) {
  return <NeedsYouButton rows={props.queue.rows()} onOpen={props.queue.open} />;
}
