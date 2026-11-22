import type { WorkspaceInsightInput } from "@openbot/contracts/ipc";
import type { InsightViewProps } from "@openbot/ui/features/workspace/InsightView";
import { render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

// Failure mode: Insights shows the numbers of another period than the one picked: the read asked
// for the period before, an older read answered last, or a change answered with the host's week.

/** The part of a report that this test reads back. */
interface Report {
  at: number;
  days: number;
  alerts: [];
}

const fake = vi.hoisted(() => {
  const state: {
    props: InsightViewProps | null;
    reads: { input: WorkspaceInsightInput; resolve: (report: Report) => void }[];
    actions: ((report: Report) => void)[];
  } = { props: null, reads: [], actions: [] };
  return state;
});

// The view only draws the report; the test drives its callbacks.
vi.mock("@openbot/ui/features/workspace/InsightView", () => ({
  InsightView: (props: InsightViewProps) => {
    fake.props = props;
    return null;
  },
}));

vi.mock("./workspace-context", () => ({
  useWorkspace: () => ({
    spaces: { list: () => [] },
    directory: () => [],
    channels: {
      port: () => ({
        agent: {
          workspaceInsight: (input: WorkspaceInsightInput) =>
            new Promise((resolve) => fake.reads.push({ input, resolve })),
          workspaceInsightAction: () => new Promise((resolve) => fake.actions.push(resolve)),
        },
      }),
    },
  }),
}));

const { WorkspaceInsightView } = await import("./WorkspaceInsight");

const report = (days: number, at: number): Report => ({ at, days, alerts: [] });
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  flush();
};

describe("Insights period", () => {
  it("reads the period that the reader picked and keeps it over older answers", async () => {
    render(() => <WorkspaceInsightView />);
    await settle();
    expect(fake.reads.map((read) => read.input.days)).toEqual([7]);
    fake.reads[0]?.resolve(report(7, 1));
    await settle();

    fake.props?.onDaysChange(30);
    expect(fake.reads.at(-1)?.input.days).toBe(30);
    fake.props?.onDaysChange(90);
    expect(fake.reads.at(-1)?.input.days).toBe(90);
    // The 90-day read answers first, the 30-day one after it.
    fake.reads[2]?.resolve(report(90, 3));
    fake.reads[1]?.resolve(report(30, 2));
    await settle();
    expect(fake.props?.report?.days).toBe(90);

    // A change answers with the host's week: the view keeps its 90 days and reads them again.
    const saved = fake.props?.onSaveGoal({
      spaceId: "s1",
      title: "Sales",
      metric: "sales",
      target: 10,
      deadline: null,
      source: "manual",
    });
    fake.actions[0]?.(report(7, 4));
    await saved;
    await settle();
    expect(fake.props?.report?.days).toBe(90);
    expect(fake.reads.at(-1)?.input.days).toBe(90);
  });
});
