import type { WorkspaceLoopAction, WorkspaceLoopActionResult } from "@openbot/contracts/ipc";
import { render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

// Failure mode: the board's timed read began before an action and answered after it, and the item
// the reader moved went back to its old stage until the next read.

/** The part of a board that this test reads back. */
interface Board {
  spaceId: string;
  stage: string;
}

const fake = vi.hoisted(() => {
  const state: {
    board: () => unknown;
    onAction: ((action: WorkspaceLoopAction) => Promise<WorkspaceLoopActionResult>) | null;
    reads: ((board: Board) => void)[];
    actions: ((board: Board) => void)[];
  } = { board: () => null, onAction: null, reads: [], actions: [] };
  return state;
});

// The view only draws the board; the test drives its callbacks.
vi.mock("@openbot/ui/features/workspace/LoopsView", () => ({
  LoopsView: (props: {
    board: unknown;
    onAction: (action: WorkspaceLoopAction) => Promise<WorkspaceLoopActionResult>;
  }) => {
    fake.board = () => props.board;
    fake.onAction = props.onAction;
    return null;
  },
}));

vi.mock("./loop-decisions-feed", () => ({
  useLoopDecisions: () => ({ decisions: () => [], refresh: () => undefined }),
}));

vi.mock("./workspace-context", () => ({
  useWorkspace: () => ({
    spaces: { current: () => "s1" },
    spaceAgents: () => [],
    directory: () => [],
    isAdmin: () => true,
    channels: {
      port: () => ({
        agent: {
          workspaceLoops: () => new Promise((resolve) => fake.reads.push(resolve)),
          workspaceLoopAction: () => new Promise((resolve) => fake.actions.push(resolve)),
        },
      }),
    },
  }),
}));

const { WorkspaceLoopsView } = await import("./WorkspaceLoops");

const board = (stage: string): Board => ({ spaceId: "s1", stage });
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  flush();
};

describe("Loops board", () => {
  it("keeps an action's answer over a read that began before it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      render(() => <WorkspaceLoopsView />);
      await settle();
      fake.reads[0]?.(board("lead"));
      await settle();
      // The timed read starts; the reader moves the item before it answers.
      vi.advanceTimersByTime(30_000);
      expect(fake.reads).toHaveLength(2);
      const moved = fake.onAction?.({ kind: "move-item", itemId: "item", toStageId: "won" });
      fake.actions[0]?.(board("won"));
      await moved;
      fake.reads[1]?.(board("lead"));
      await settle();
      expect(fake.board()).toEqual(board("won"));
    } finally {
      vi.useRealTimers();
    }
  });
});
