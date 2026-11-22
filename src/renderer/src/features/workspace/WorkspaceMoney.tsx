/*
 * Money: the one place for what the agents cost, the revenue and ad spend the host reads, the spend
 * that waits for the owner's OK (from every space), each agent's cost and the plan's limits. Today's
 * spend card, the fleet's cost line and the Insights costs tab link here.
 */
import { MoneyView } from "@openbot/ui/features/workspace/MoneyView";
import { createMemo } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { useDecisionQueue } from "./workspace-decisions";
import { openInsightTab, useInsightReport } from "./workspace-insight-report";
import { memberById } from "./workspace-model";

export function WorkspaceMoneyView() {
  const ws = useWorkspace();
  const queue = useDecisionQueue();
  const insight = useInsightReport(ws, () => 30);
  // Only spending needs the owner's OK: an approval is a payment or an ad launch, a decision with an
  // amount is a budget.
  const spend = createMemo(() =>
    queue.queue().filter((decision) => decision.amountUsd !== undefined || decision.kind === "approval"),
  );
  const today = createMemo(() => new Map(ws.fleet.agents().map((agent) => [agent.member.id, agent.todayCostUsd])));
  const agents = createMemo(() => {
    const report = insight.report();
    const totals = new Map<string, { cost: number; turns: number }>();
    for (const row of report?.costs.agents ?? []) {
      const known = totals.get(row.agentId) ?? { cost: 0, turns: 0 };
      totals.set(row.agentId, { cost: known.cost + row.costUsd, turns: known.turns + row.turns });
    }
    // Without the report's rows, today's cost of the fleet is all there is.
    if (totals.size === 0) for (const [agentId, usd] of today()) if (usd) totals.set(agentId, { cost: usd, turns: 0 });
    return [...totals]
      .filter(([, total]) => total.cost > 0)
      .sort(([, left], [, right]) => right.cost - left.cost)
      .map(([agentId, total]) => ({
        member: memberById(ws.directory(), agentId),
        costUsd: total.cost,
        todayUsd: today().get(agentId),
        turns: total.turns,
        onOpen: () => ws.openAgent(agentId),
      }));
  });
  const todayUsd = createMemo(() => [...today().values()].reduce((sum: number, usd) => sum + (usd ?? 0), 0));
  const insights = () => ws.viewAvailable("insights");
  return (
    <MoneyView
      report={insight.report()}
      loading={insights() && insight.report() === null && !insight.failed()}
      todayUsd={todayUsd()}
      spend={spend()}
      agents={agents()}
      onOpenUsage={ws.env.openUsage}
      onOpenDetails={insights() ? () => openInsightTab(ws, "costs") : undefined}
      onOpenRules={insights() ? () => openInsightTab(ws, "briefing") : undefined}
      onBack={() => ws.back()}
    />
  );
}
