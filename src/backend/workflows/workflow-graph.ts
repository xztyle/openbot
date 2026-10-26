/**
 * The rules of a workflow graph that need the meaning of its nodes, without the database: which
 * port types each kind takes and sends, and where a branch edge may start. A loop is allowed: the run
 * takes its edge back as the next pass (`workflowLoopEdges`). The shape and the limits of a graph are
 * the contract's (`isWorkflowGraph`).
 */

import {
  isWorkflowStepKind,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowPortType,
} from "@openbot/contracts/ipc";

export type WorkflowGraphProblem = "annotation" | "port" | "branch" | "condition-branch" | "duplicate";

const ALL_PORTS = ["text", "image", "file"] as const satisfies readonly WorkflowPortType[];

/** The port types each step kind takes in and sends out. The canvas offers the same ports. */
const PORTS: Record<WorkflowNodeKind, { in: readonly WorkflowPortType[]; out: readonly WorkflowPortType[] }> = {
  trigger: { in: [], out: ["text"] },
  prompt: { in: [], out: ["text"] },
  asset: { in: [], out: ALL_PORTS },
  llm: { in: ALL_PORTS, out: ["text"] },
  agent: { in: ALL_PORTS, out: ["text"] },
  image: { in: ["text", "image"], out: ["image"] },
  condition: { in: ["text"], out: ["text"] },
  approval: { in: ["text"], out: ["text"] },
  output: { in: ALL_PORTS, out: [] },
  text: { in: [], out: [] },
  note: { in: [], out: [] },
  shape: { in: [], out: [] },
};

/** The zone that a trigger node names, or null when it names none. */
export function nodeTimezone(node: WorkflowNode): string | null {
  const timezone = node.fields.timezone;
  return typeof timezone === "string" && timezone.length > 0 ? timezone : null;
}

/** Why the graph is not a workflow that can run, or null when it is. */
export function workflowGraphProblem(graph: WorkflowGraph): WorkflowGraphProblem | null {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    // `isWorkflowGraph` already holds every edge to two nodes of the graph.
    if (!from || !to) return "port";
    const problem = edgeProblem(from, to, edge);
    if (problem) return problem;
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.type}\u0000${edge.branch ?? ""}`;
    if (seen.has(key)) return "duplicate";
    seen.add(key);
  }
  return null;
}

function edgeProblem(from: WorkflowNode, to: WorkflowNode, edge: WorkflowEdge): WorkflowGraphProblem | null {
  if (!isWorkflowStepKind(from.kind) || !isWorkflowStepKind(to.kind)) return "annotation";
  if (!PORTS[from.kind].out.includes(edge.type) || !PORTS[to.kind].in.includes(edge.type)) return "port";
  if (from.kind === "condition") return edge.branch === undefined ? "condition-branch" : null;
  return edge.branch === undefined ? null : "branch";
}
