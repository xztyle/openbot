import {
  layoutOrgChart,
  ORG_CHART_SIZE,
  type OrgChartNodeInput,
  orgChartAncestors,
  orgChartNeighbour,
  orgChartSubtree,
} from "@openbot/ui/features/org-chart/org-chart-layout";
import { describe, expect, it } from "vitest";

/** Two roots: a director with two leads, one lead with three reports, and a second root with one. */
const ORG: OrgChartNodeInput[] = [
  { id: "director", managerId: null },
  { id: "lead-a", managerId: "director" },
  { id: "lead-b", managerId: "director" },
  { id: "ux", managerId: "lead-a" },
  { id: "qa", managerId: "lead-a" },
  { id: "ads", managerId: "lead-a" },
  { id: "landing", managerId: null },
  { id: "builder", managerId: "landing" },
];

const overlaps = (left: { x: number; y: number; width: number; height: number }, right: typeof left) =>
  left.x < right.x + right.width &&
  right.x < left.x + left.width &&
  left.y < right.y + right.height &&
  right.y < left.y + left.height;

describe("layoutOrgChart", () => {
  it("places every agent once, without overlaps, managers above their reports", () => {
    const { nodes, edges } = layoutOrgChart(ORG, new Set());
    expect([...nodes.keys()]).toEqual(ORG.map((node) => node.id));
    const boxes = [...nodes.values()];
    for (const box of boxes)
      for (const other of boxes) if (box.id !== other.id) expect(overlaps(box, other)).toBe(false);
    for (const node of boxes) {
      const manager = node.parentId ? nodes.get(node.parentId) : undefined;
      if (manager) expect(node.y).toBeGreaterThan(manager.y + manager.height);
    }
    expect(edges.map((edge) => [edge.from, edge.to])).toHaveLength(ORG.length - 2);
  });

  it("stacks three or more reports without reports under a rail", () => {
    const { nodes } = layoutOrgChart(ORG, new Set());
    const stack = ["ux", "qa", "ads"].map((id) => nodes.get(id));
    expect(stack.every((node) => node?.stacked)).toBe(true);
    expect(new Set(stack.map((node) => node?.x)).size).toBe(1);
    expect(nodes.get("lead-b")?.stacked).toBe(false);
  });

  it("hides the reports of a collapsed agent and counts all agents under it", () => {
    const { nodes } = layoutOrgChart(ORG, new Set(["director"]));
    expect([...nodes.keys()]).toEqual(["director", "landing", "builder"]);
    expect(nodes.get("director")).toMatchObject({ collapsed: true, descendants: 5, childIds: ["lead-a", "lead-b"] });
  });

  it("puts an agent whose manager is not in the list at the top level", () => {
    const { nodes } = layoutOrgChart([{ id: "orphan", managerId: "gone" }], new Set());
    expect(nodes.get("orphan")).toMatchObject({ parentId: null, depth: 0, x: 0, y: 0 });
    expect(nodes.get("orphan")?.width).toBe(ORG_CHART_SIZE.card.width);
  });
});

describe("org chart navigation", () => {
  it("finds the agents under and above an agent", () => {
    expect([...orgChartSubtree(ORG, "lead-a")].sort()).toEqual(["ads", "lead-a", "qa", "ux"]);
    expect(orgChartAncestors(ORG, "qa")).toEqual(["lead-a", "director"]);
  });

  it("moves to the nearest card in the direction of an arrow key", () => {
    const { nodes } = layoutOrgChart(ORG, new Set());
    expect(orgChartNeighbour(nodes, "lead-a", "up")).toBe("director");
    expect(orgChartNeighbour(nodes, "ux", "down")).toBe("qa");
    expect(orgChartNeighbour(nodes, "lead-a", "right")).toBe("lead-b");
    expect(orgChartNeighbour(nodes, "director", "up")).toBeUndefined();
  });
});
