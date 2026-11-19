/**
 * The tree layout of the org chart, without the DOM. A manager sits centred over its reports. The
 * reports that have no reports of their own stack in columns under a rail, as in the Teams
 * organization view, so a team of twenty does not make a row of twenty cards. Several roots sit
 * side by side. The connectors are orthogonal lines with round corners.
 */

/** One agent of the chart: its id and its resolved manager. The order of the list is the order of siblings. */
export interface OrgChartNodeInput {
  id: string;
  managerId: string | null;
}

export interface OrgChartBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OrgChartPlacedNode extends OrgChartBox {
  id: string;
  /** The manager, or null for a root. */
  parentId: string | null;
  depth: number;
  /** The direct reports, shown or not. */
  childIds: readonly string[];
  /** All agents under this one, shown or not. */
  descendants: number;
  /** The reports are hidden. Only an agent with reports can be collapsed. */
  collapsed: boolean;
  /** The card sits in a stack under its manager's rail. */
  stacked: boolean;
}

/** The line from a manager to one report. Its id is the id of the report. */
export interface OrgChartEdge {
  id: string;
  from: string;
  to: string;
  /** An SVG path from the manager to the report. */
  path: string;
}

export interface OrgChartLayout {
  /** The cards that show, in the order of the input. */
  nodes: ReadonlyMap<string, OrgChartPlacedNode>;
  edges: readonly OrgChartEdge[];
  /** The box of every card that shows. */
  bounds: OrgChartBox;
}

/** The sizes of the chart, in world pixels. */
export const ORG_CHART_SIZE = {
  card: { width: 264, height: 118 },
  /** Between two subtrees side by side. */
  gapX: 32,
  /** Between a manager and its reports. */
  gapY: 72,
  /** Between two cards of a stack. */
  stackGap: 12,
  /** From the rail of a stack to its cards. */
  stackIndent: 28,
  /** The most cards in one column of a stack. */
  stackRows: 6,
  /** The fewest reports without reports of their own that stack. Fewer sit in the row. */
  stackMin: 3,
  /** The radius of a connector corner. */
  corner: 10,
} as const;

type Unit = { kind: "branch"; id: string; width: number } | { kind: "stack"; ids: string[]; width: number };

/** All agents under each agent, from the full tree. */
function descendantCounts(children: ReadonlyMap<string, string[]>, roots: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  const count = (id: string): number => {
    let total = 0;
    for (const child of children.get(id) ?? []) total += 1 + count(child);
    counts.set(id, total);
    return total;
  };
  for (const root of roots) count(root);
  return counts;
}

/** A path through `points` with round corners. */
export function roundedPath(points: readonly { x: number; y: number }[], radius: number = ORG_CHART_SIZE.corner) {
  const [first, ...rest] = points;
  if (!first) return "";
  let path = `M ${first.x} ${first.y}`;
  for (let index = 0; index < rest.length; index += 1) {
    const corner = rest[index];
    const before = points[index];
    const after = rest[index + 1];
    if (!corner || !before) continue;
    if (!after) {
      path += ` L ${corner.x} ${corner.y}`;
      continue;
    }
    const inLength = Math.hypot(corner.x - before.x, corner.y - before.y);
    const outLength = Math.hypot(after.x - corner.x, after.y - corner.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r <= 0) {
      path += ` L ${corner.x} ${corner.y}`;
      continue;
    }
    const startX = corner.x - ((corner.x - before.x) / inLength) * r;
    const startY = corner.y - ((corner.y - before.y) / inLength) * r;
    const endX = corner.x + ((after.x - corner.x) / outLength) * r;
    const endY = corner.y + ((after.y - corner.y) / outLength) * r;
    path += ` L ${startX} ${startY} Q ${corner.x} ${corner.y} ${endX} ${endY}`;
  }
  return path;
}

/** Places every agent that shows. `collapsed` hides the reports of those agents. */
export function layoutOrgChart(input: readonly OrgChartNodeInput[], collapsed: ReadonlySet<string>): OrgChartLayout {
  const { card, gapX, gapY, stackGap, stackIndent, stackRows, stackMin } = ORG_CHART_SIZE;
  const ids = new Set(input.map((node) => node.id));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string | null>();
  const roots: string[] = [];
  for (const node of input) {
    const parent = node.managerId !== null && ids.has(node.managerId) ? node.managerId : null;
    parents.set(node.id, parent);
    if (parent === null) roots.push(node.id);
    else children.set(parent, [...(children.get(parent) ?? []), node.id]);
  }
  const descendants = descendantCounts(children, roots);
  const open = (id: string) => !collapsed.has(id) && (children.get(id)?.length ?? 0) > 0;
  const shownChildren = (id: string) => (open(id) ? (children.get(id) ?? []) : []);
  const isLeaf = (id: string) => shownChildren(id).length === 0;

  /** A stack of `count` cards: its columns, rows and width. */
  const stackShape = (count: number) => {
    const columns = Math.ceil(count / stackRows);
    const rows = Math.ceil(count / columns);
    return { columns, rows, width: columns * (stackIndent + card.width) + (columns - 1) * gapX };
  };

  // The width of each subtree, from the leaves up.
  const widths = new Map<string, number>();
  const units = new Map<string, Unit[]>();
  const measure = (id: string): number => {
    const kids = shownChildren(id);
    const leaves = kids.filter(isLeaf);
    const stacks = leaves.length >= stackMin;
    const list: Unit[] = kids
      .filter((kid) => !stacks || !isLeaf(kid))
      .map((kid) => ({ kind: "branch", id: kid, width: measure(kid) }));
    if (stacks) list.push({ kind: "stack", ids: leaves, width: stackShape(leaves.length).width });
    units.set(id, list);
    const total = list.reduce((sum, unit) => sum + unit.width, 0) + Math.max(0, list.length - 1) * gapX;
    const width = Math.max(card.width, total);
    widths.set(id, width);
    return width;
  };

  const nodes = new Map<string, OrgChartPlacedNode>();
  const edges: OrgChartEdge[] = [];
  const place = (id: string, left: number, top: number, depth: number, stacked: boolean) => {
    const width = widths.get(id) ?? card.width;
    const x = stacked ? left : left + (width - card.width) / 2;
    nodes.set(id, {
      id,
      parentId: parents.get(id) ?? null,
      depth,
      childIds: children.get(id) ?? [],
      descendants: descendants.get(id) ?? 0,
      collapsed: collapsed.has(id) && (children.get(id)?.length ?? 0) > 0,
      stacked,
      x,
      y: top,
      width: card.width,
      height: card.height,
    });
    const list = units.get(id) ?? [];
    if (list.length === 0) return;
    const total = list.reduce((sum, unit) => sum + unit.width, 0) + (list.length - 1) * gapX;
    const from = { x: x + card.width / 2, y: top + card.height };
    const busY = top + card.height + gapY / 2;
    const childTop = top + card.height + gapY;
    let cursor = left + (width - total) / 2;
    for (const unit of list) {
      if (unit.kind === "branch") {
        place(unit.id, cursor, childTop, depth + 1, false);
        const child = nodes.get(unit.id);
        if (child) {
          const toX = child.x + card.width / 2;
          edges.push({
            id: unit.id,
            from: id,
            to: unit.id,
            path: roundedPath([from, { x: from.x, y: busY }, { x: toX, y: busY }, { x: toX, y: childTop }]),
          });
        }
      } else {
        const shape = stackShape(unit.ids.length);
        unit.ids.forEach((kid, index) => {
          const column = Math.floor(index / shape.rows);
          const row = index % shape.rows;
          const columnLeft = cursor + column * (stackIndent + card.width + gapX);
          const cardTop = childTop + row * (card.height + stackGap);
          place(kid, columnLeft + stackIndent, cardTop, depth + 1, true);
          const railX = columnLeft + stackIndent / 2;
          const cardMiddle = cardTop + card.height / 2;
          edges.push({
            id: kid,
            from: id,
            to: kid,
            path: roundedPath([
              from,
              { x: from.x, y: busY },
              { x: railX, y: busY },
              { x: railX, y: cardMiddle },
              { x: columnLeft + stackIndent, y: cardMiddle },
            ]),
          });
        });
      }
      cursor += unit.width + gapX;
    }
  };

  let left = 0;
  for (const root of roots) {
    const width = measure(root);
    place(root, left, 0, 0, false);
    left += width + gapX * 2;
  }

  const placed = input.flatMap((node) => {
    const at = nodes.get(node.id);
    return at ? [at] : [];
  });
  const right = Math.max(0, ...placed.map((node) => node.x + node.width));
  const bottom = Math.max(0, ...placed.map((node) => node.y + node.height));
  return {
    nodes: new Map(placed.map((node) => [node.id, node])),
    edges,
    bounds: { x: 0, y: 0, width: right, height: bottom },
  };
}

/** The agent under `id` and all agents under it, so a drop there cannot make a loop. */
export function orgChartSubtree(layoutInput: readonly OrgChartNodeInput[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of layoutInput)
    if (node.managerId !== null) children.set(node.managerId, [...(children.get(node.managerId) ?? []), node.id]);
  const found = new Set<string>([id]);
  const walk = (current: string) => {
    for (const child of children.get(current) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      walk(child);
    }
  };
  walk(id);
  return found;
}

/** The managers above `id`, nearest first. */
export function orgChartAncestors(layoutInput: readonly OrgChartNodeInput[], id: string): string[] {
  const managers = new Map(layoutInput.map((node) => [node.id, node.managerId]));
  const found: string[] = [];
  for (
    let current = managers.get(id) ?? null;
    current && !found.includes(current);
    current = managers.get(current) ?? null
  )
    found.push(current);
  return found;
}

/**
 * The card that an arrow key moves to: the nearest card in that direction, where a card straight
 * ahead counts as nearer than one to the side.
 */
export function orgChartNeighbour(
  nodes: ReadonlyMap<string, OrgChartBox>,
  from: string,
  direction: "up" | "down" | "left" | "right",
): string | undefined {
  const origin = nodes.get(from);
  if (!origin) return undefined;
  const centre = (box: OrgChartBox) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const start = centre(origin);
  let best: { id: string; score: number } | undefined;
  for (const [id, box] of nodes) {
    if (id === from) continue;
    const at = centre(box);
    const dx = at.x - start.x;
    const dy = at.y - start.y;
    const ahead = direction === "up" ? -dy : direction === "down" ? dy : direction === "left" ? -dx : dx;
    const aside = direction === "up" || direction === "down" ? Math.abs(dx) : Math.abs(dy);
    if (ahead <= 1) continue;
    const score = ahead + aside * 2;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id;
}
