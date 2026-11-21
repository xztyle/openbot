/**
 * The org chart of the agents of a space, on a canvas: who reports to whom, and what each agent does
 * now. Drag the canvas to pan, scroll with Ctrl or ⌘ (or pinch) to zoom. A card opens its panel; a
 * card dropped on another card reports there after a confirm. The arrow keys move between cards.
 */

import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  createUniqueId,
  For,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { Button } from "../../button";
import { ConfirmDialog } from "../../confirm-dialog";
import { Input } from "../../form";
import { Bot, ChevronsDownUp, ChevronsUpDown, Network, Search } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState } from "../../view-state";
import { DotGrid, devicePixel } from "../workflows/canvas-dot-grid";
import { HudButton } from "../workflows/WorkflowCanvasHud";
import { WorkflowZoomMenu, type ZoomAction } from "../workflows/WorkflowZoomMenu";
import { type Camera, type CameraMotion, glideCamera } from "../workflows/workflow-camera";
import { TicketChip, type WorkspaceTicket } from "../workspace/TicketChip";
import { MemberAvatar } from "../workspace/WorkspaceAvatar";
import { WorkspacePaneHeader } from "../workspace/WorkspacePaneHeader";
import type { AgentWorkStatus, WorkspaceMember } from "../workspace/workspace-types";
import { OrgChartPanel } from "./OrgChartPanel";
import {
  layoutOrgChart,
  ORG_CHART_SIZE,
  type OrgChartBox,
  type OrgChartPlacedNode,
  orgChartAncestors,
  orgChartNeighbour,
  orgChartSubtree,
} from "./org-chart-layout";

/** What an agent's card shows: working, waiting for the user, a failed last turn, or nothing. */
export type OrgChartAgentState = "working" | "waiting" | "failed" | "idle";

export interface OrgChartAgent {
  member: WorkspaceMember;
  title?: string | undefined;
  /** The resolved manager, or null at the top level. */
  managerId: string | null;
  /** The model id and the effort name, for the card's chip. */
  model?: string | undefined;
  effort?: string | undefined;
  state: OrgChartAgentState;
  /** What the agent does now, as the fleet says it. */
  status?: AgentWorkStatus | undefined;
  /** The step that runs now, or what the agent waits for. */
  activity?: string | undefined;
  /** Messages that wait in its queue. */
  queued?: number | undefined;
  /** The last message of its chat. */
  preview?: string | undefined;
  /** A background teammate: the user does not talk to it. */
  background?: boolean | undefined;
  /** It sleeps: no routine, check or message starts a turn of it. */
  sleeping?: boolean | undefined;
  /** The Motion ticket it works on now. */
  ticket?: WorkspaceTicket | undefined;
}

/** A message from one agent to another. Each new id sends a pulse along the chart. */
export interface OrgChartMessage {
  id: string;
  from: string;
  to: string;
}

export interface OrgChartViewProps {
  /** The agents of the space, in the order of siblings. */
  agents: readonly OrgChartAgent[];
  messages?: readonly OrgChartMessage[] | undefined;
  /** Opens the agent's chat. */
  onOpenChat: (agentId: string) => void;
  /** Changes an agent's manager; `null` is the top level. Absent, the chart cannot be changed. */
  onChangeManager?: ((agentId: string, managerId: string | null) => Promise<void>) | undefined;
  /** Puts the agent and every agent under it to sleep, or wakes them. Absent: no sleep button. */
  onSleepTeam?: ((agentId: string, sleeping: boolean) => Promise<void>) | undefined;
  /** The agent whose panel shows first, such as from a link. */
  initialAgentId?: string | null | undefined;
  onBack?: (() => void) | undefined;
  class?: string;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 1.6;
const ZOOM_STEP = 1.2;
/** As on the workflow canvas: half of a scroll pans, and a pinch sends smaller steps than a wheel. */
const WHEEL_PAN_SPEED = 0.5;
const PINCH_ZOOM_RATE = 0.007;
const WHEEL_ZOOM_RATE = 0.002;
const WHEEL_ZOOM_MAX = Math.log(ZOOM_STEP);
const FIT_MARGIN = 56;
/** The top of the view that the search bar covers, so a fit leaves the top row clear. */
const FIT_TOP = 72;
const DRAG_THRESHOLD = 4;
/** A view this narrow is a phone: a fit keeps the cards readable and shows the top of the tree. */
const NARROW_VIEW = 600;
/** The smallest scale of a fit on a phone, where the text of a card still reads. */
const NARROW_FIT_SCALE = 0.75;
/** How long a message pulse shows; its animation in org-chart.css is a little shorter. */
const PULSE_MS = 1_600;

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

const STATE_LABEL = {
  working: "workspace.org.state.working",
  waiting: "workspace.org.state.waiting",
  failed: "workspace.org.state.failed",
  idle: "workspace.org.state.idle",
} as const;

/** The path of a message pulse: a curve from the middle of one card to the middle of the other. */
function messagePath(from: OrgChartBox, to: OrgChartBox): string {
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  // Two cards of one column, such as in a stack, get a bow to the right; others an arch over the top.
  if (Math.abs(end.x - start.x) < from.width) {
    const side = Math.max(start.x, end.x) + from.width * 0.9;
    return `M ${start.x} ${start.y} C ${side} ${start.y} ${side} ${end.y} ${end.x} ${end.y}`;
  }
  const top = Math.min(start.y, end.y) - Math.max(80, Math.abs(end.x - start.x) / 3);
  return `M ${start.x} ${start.y} C ${start.x} ${top} ${end.x} ${top} ${end.x} ${end.y}`;
}

/** A card being dragged: how far, in world pixels, and what is under it. */
interface OrgChartDrag {
  id: string;
  dx: number;
  dy: number;
  /** The card it would report to. */
  over: string | null;
  /** Over the drop zone of the top level. */
  top: boolean;
}

interface OrgChartUi {
  selectedId: string | null;
  focusedId: string | null;
  query: string;
  /** The card that a jump or a search marks for a moment. */
  flashId: string | null;
  /** A manager change waiting for the confirm. */
  move: { agentId: string; managerId: string | null } | null;
  moveError: string | null;
  drag: OrgChartDrag | null;
  panning: boolean;
}

/** The arrow keys, as the directions `orgChartNeighbour` moves in. */
const ARROW_DIRECTION: Readonly<Record<string, "up" | "down" | "left" | "right">> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

export function OrgChartView(props: OrgChartViewProps): JSX.Element {
  const { t, errorMessage } = useText();
  const idPrefix = createUniqueId();
  const cardId = (agentId: string) => `${idPrefix}-${agentId}`;

  const [ui, setUi] = createStore<OrgChartUi>({
    selectedId: null,
    focusedId: null,
    query: "",
    flashId: null,
    move: null,
    moveError: null,
    drag: null,
    panning: false,
  });
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [camera, setCamera] = createStore<Camera>({ x: 0, y: 0, scale: 1 });
  const [view, setView] = createSignal({ width: 0, height: 0 });
  const [pulses, setPulses] = createSignal<readonly { key: string; path: string }[]>([]);

  const agents = createMemo(() => new Map(props.agents.map((agent) => [agent.member.id, agent])));
  const input = createMemo(() => props.agents.map((agent) => ({ id: agent.member.id, managerId: agent.managerId })));
  const layout = createMemo(() => layoutOrgChart(input(), collapsed()));
  const placed = createMemo(() => [...layout().nodes.values()]);
  const selected = () => (ui.selectedId ? agents().get(ui.selectedId) : undefined);
  const canMove = () => props.onChangeManager !== undefined;

  /** The card that takes Tab: the focused one, the selected one, else the first root. */
  const tabStop = createMemo(() => {
    const nodes = layout().nodes;
    if (ui.focusedId && nodes.has(ui.focusedId)) return ui.focusedId;
    if (ui.selectedId && nodes.has(ui.selectedId)) return ui.selectedId;
    return placed()[0]?.id ?? null;
  });

  /** The lines from the selected agent up to its root and down to its reports. */
  const highlighted = createMemo(() => {
    const id = ui.selectedId;
    if (!id) return new Set<string>();
    const lines = new Set<string>([id, ...orgChartAncestors(input(), id)]);
    for (const node of input()) if (node.managerId === id) lines.add(node.id);
    return lines;
  });

  const summary = createMemo(() => {
    const working = props.agents.filter((agent) => agent.state === "working").length;
    const waiting = props.agents.filter((agent) => agent.state === "waiting").length;
    return [
      t("workspace.org.agents", { count: props.agents.length }),
      ...(working ? [t("workspace.org.workingCount", { count: working })] : []),
      ...(waiting ? [t("workspace.org.waitingCount", { count: waiting })] : []),
    ].join(" · ");
  });

  const matches = createMemo(() => {
    const text = ui.query.trim().toLocaleLowerCase();
    if (!text) return [];
    return props.agents
      .filter(
        (agent) =>
          agent.member.name.toLocaleLowerCase().includes(text) ||
          (agent.title?.toLocaleLowerCase().includes(text) ?? false),
      )
      .slice(0, 8);
  });

  /* ------------------------------------------------------------- Camera */

  let stage: HTMLDivElement | undefined;
  let viewport: HTMLDivElement | undefined;
  let topZone: HTMLDivElement | undefined;
  /** True once the reader moved the camera: a new agent then does not fit the view again. */
  let cameraMoved = false;
  const glide: { stop: () => void; goal: Camera | undefined } = { stop: () => {}, goal: undefined };

  const placeCamera = (next: Camera) =>
    setCamera((draft) => {
      draft.x = next.x;
      draft.y = next.y;
      draft.scale = clampScale(next.scale);
    });
  const stopGlide = () => {
    glide.stop();
    glide.goal = undefined;
  };
  const moveCamera = (next: Camera, byUser = true) => {
    stopGlide();
    cameraMoved ||= byUser;
    placeCamera(next);
  };
  const glideTo = (next: Camera, motion: CameraMotion) => {
    stopGlide();
    cameraMoved = true;
    const goal = { ...next, scale: clampScale(next.scale) };
    glide.goal = goal;
    glide.stop = glideCamera({ x: camera.x, y: camera.y, scale: camera.scale }, goal, motion, view(), (at, done) => {
      placeCamera(at);
      if (done) glide.goal = undefined;
    });
  };
  const target = (): Camera => glide.goal ?? camera;
  const zoomAround = (scale: number, point: { x: number; y: number }, from: Camera = camera): Camera => {
    const next = clampScale(scale);
    return {
      scale: next,
      x: point.x - ((point.x - from.x) * next) / from.scale,
      y: point.y - ((point.y - from.y) * next) / from.scale,
    };
  };
  const zoomTo = (scale: number) =>
    glideTo(zoomAround(scale, { x: view().width / 2, y: view().height / 2 }, target()), "step");
  const fitCamera = (): Camera | undefined => {
    const { width, height } = view();
    const bounds = layout().bounds;
    if (!width || !height || bounds.width === 0) return undefined;
    const room = { width: width - FIT_MARGIN * 2, height: height - FIT_MARGIN - FIT_TOP };
    const scale = clampScale(Math.min(room.width / bounds.width, room.height / bounds.height, 1));
    // A phone does not shrink the whole team into cards too small to read. It shows the first card
    // at the top at a size that reads, and a drag or a pinch shows the rest.
    if (width < NARROW_VIEW && scale < NARROW_FIT_SCALE) {
      const first = [...layout().nodes.values()].reduce<OrgChartPlacedNode | undefined>(
        (top, node) => (!top || node.y < top.y || (node.y === top.y && node.x < top.x) ? node : top),
        undefined,
      );
      if (first)
        return {
          scale: NARROW_FIT_SCALE,
          x: width / 2 - (first.x + first.width / 2) * NARROW_FIT_SCALE,
          y: FIT_TOP + FIT_MARGIN / 2 - first.y * NARROW_FIT_SCALE,
        };
    }
    return {
      scale,
      x: (width - bounds.width * scale) / 2 - bounds.x * scale,
      y: FIT_TOP + Math.max(0, (room.height - bounds.height * scale) / 2) - bounds.y * scale,
    };
  };
  const fitView = (byUser: boolean) => {
    const next = fitCamera();
    if (!next) return;
    if (byUser) glideTo(next, "flight");
    else moveCamera(next, false);
  };
  const zoom = (action: ZoomAction) => {
    if (action === "in") zoomTo(target().scale * ZOOM_STEP);
    else if (action === "out") zoomTo(target().scale / ZOOM_STEP);
    else if (action === "reset") zoomTo(1);
    else fitView(true);
  };
  /** Glides to a card, at a size where its text reads, unless it already shows whole. */
  const reveal = (id: string, always = false) => {
    const node = layout().nodes.get(id);
    const { width, height } = view();
    if (!node || !width) return;
    const at = target();
    const left = node.x * at.scale + at.x;
    const top = node.y * at.scale + at.y;
    const inView =
      left >= FIT_MARGIN / 2 &&
      top >= FIT_TOP &&
      left + node.width * at.scale <= width - FIT_MARGIN / 2 &&
      top + node.height * at.scale <= height - FIT_MARGIN / 2;
    if (inView && !always) return;
    const scale = Math.max(at.scale, 0.85);
    // On a phone the agent's panel is a sheet over the lower part of the chart: the card goes above it.
    const centreY =
      width < NARROW_VIEW ? Math.min(height / 2, FIT_TOP + (node.height * scale) / 2 + FIT_MARGIN / 2) : height / 2;
    glideTo(
      {
        scale,
        x: width / 2 - (node.x + node.width / 2) * scale,
        y: centreY - (node.y + node.height / 2) * scale,
      },
      "flight",
    );
  };

  // A new or removed agent fits the view again until the reader moves the camera.
  createEffect(
    () => [layout().bounds.width, layout().bounds.height, view().width, view().height] as const,
    () => {
      if (!cameraMoved) untrack(() => fitView(false));
    },
  );

  /* ----------------------------------------------------- Selection, keys */

  const focusCard = (id: string) => {
    setUi((draft) => {
      draft.focusedId = id;
    });
    // The card can mount in this frame, after an expand.
    requestAnimationFrame(() => document.getElementById(cardId(id))?.focus({ preventScroll: true }));
    reveal(id);
  };
  const select = (id: string | null) =>
    setUi((draft) => {
      draft.selectedId = id;
      if (id) draft.focusedId = id;
    });
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Opens every manager above `id`, centres its card, selects it and marks it for a moment. */
  const jumpTo = (id: string) => {
    const above = orgChartAncestors(input(), id);
    if (above.some((manager) => collapsed().has(manager)))
      setCollapsed((current) => new Set([...current].filter((manager) => !above.includes(manager))));
    select(id);
    setUi((draft) => {
      draft.flashId = id;
      draft.query = "";
    });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(
      () =>
        setUi((draft) => {
          draft.flashId = null;
        }),
      PULSE_MS,
    );
    // The layout changes with the expand, so the camera reads it on the next frame.
    requestAnimationFrame(() => {
      reveal(id, true);
      document.getElementById(cardId(id))?.focus({ preventScroll: true });
    });
  };
  const toggleCollapsed = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** Shows only the agents that have reports, or every agent. */
  const collapseAll = (on: boolean) => {
    if (!on) {
      setCollapsed(new Set<string>());
      return;
    }
    const managers = new Set(input().flatMap((node) => (node.managerId ? [node.managerId] : [])));
    // A manager whose reports all have no reports keeps them hidden; the managers above stay open.
    const hidden = [...managers].filter((id) =>
      input().every((node) => node.managerId !== id || !managers.has(node.id)),
    );
    setCollapsed(new Set(hidden));
  };

  /** The arrows move to the nearest card that way; - and + hide and show the reports. Enter opens the panel. */
  const onCardKey = (event: KeyboardEvent, id: string) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const move = ARROW_DIRECTION[event.key];
    if (move) {
      event.preventDefault();
      const next = orgChartNeighbour(layout().nodes, id, move);
      if (next) focusCard(next);
      return;
    }
    const node = layout().nodes.get(id);
    if (!node?.childIds.length) return;
    if ((event.key === "-" && !node.collapsed) || ((event.key === "+" || event.key === "=") && node.collapsed)) {
      event.preventDefault();
      toggleCollapsed(id);
    }
  };

  const onStageKey = (event: KeyboardEvent) => {
    const editable = event.target instanceof HTMLElement && event.target.closest("input, textarea");
    if (event.key === "Escape" && !editable && ui.selectedId) {
      event.preventDefault();
      select(null);
      return;
    }
    if (editable) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && (event.key === "=" || event.key === "+")) zoom("in");
    else if (mod && event.key === "-") zoom("out");
    else if (mod && event.key === "0") zoom("reset");
    else if (event.shiftKey && event.code === "Digit1") zoom("fit");
    else return;
    event.preventDefault();
  };

  /* -------------------------------------------------------- Pointer input */

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = viewport?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };
  const toWorld = (point: { x: number; y: number }) => ({
    x: (point.x - camera.x) / camera.scale,
    y: (point.y - camera.y) / camera.scale,
  });

  type Gesture =
    | { kind: "pan"; pointerId: number; last: { x: number; y: number } }
    | {
        kind: "card";
        pointerId: number;
        id: string;
        start: { x: number; y: number };
        dragging: boolean;
        blocked: Set<string>;
      }
    | { kind: "pinch"; distance: number; centre: { x: number; y: number } };
  let gesture: Gesture | undefined;
  const touches = new Map<number, { x: number; y: number }>();

  /** The card under a world point that the dragged card may report to. */
  const dropTarget = (point: { x: number; y: number }, blocked: ReadonlySet<string>) => {
    for (const node of placed()) {
      if (blocked.has(node.id)) continue;
      if (point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height)
        return node.id;
    }
    return null;
  };
  const overTopZone = (event: PointerEvent) => {
    const rect = topZone?.getBoundingClientRect();
    return Boolean(
      rect &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom,
    );
  };

  const pinchOf = () => {
    const [first, second] = [...touches.values()];
    if (!first || !second) return undefined;
    return {
      distance: Math.hypot(first.x - second.x, first.y - second.y),
      centre: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    };
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !viewport) return;
    const at = local(event);
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, at);
      const pinch = touches.size === 2 ? pinchOf() : undefined;
      if (pinch) {
        gesture = { kind: "pinch", ...pinch };
        return;
      }
    }
    const element = event.target instanceof Element ? event.target : null;
    // A control, such as the reports toggle of a card, keeps its own click. The card's own button
    // is its keyboard stop; a press on it selects or drags the card here.
    const control = element?.closest("button, input, [data-org-hud]");
    if (control && !control.classList.contains("ws-org-card-main")) return;
    stopGlide();
    const card = element?.closest<HTMLElement>(".ws-org-card");
    const id = card?.dataset.agentId;
    viewport.setPointerCapture(event.pointerId);
    if (id) {
      gesture = { kind: "card", pointerId: event.pointerId, id, start: at, dragging: false, blocked: new Set() };
      return;
    }
    gesture = { kind: "pan", pointerId: event.pointerId, last: at };
    setUi((draft) => {
      draft.panning = true;
    });
  };

  const onPointerMove = (event: PointerEvent) => {
    const at = local(event);
    if (event.pointerType === "touch" && touches.has(event.pointerId)) touches.set(event.pointerId, at);
    const current = gesture;
    if (!current) return;
    if (current.kind === "pinch") {
      const pinch = pinchOf();
      if (!pinch || current.distance === 0) return;
      const scaled = zoomAround(camera.scale * (pinch.distance / current.distance), current.centre);
      moveCamera({
        ...scaled,
        x: scaled.x + pinch.centre.x - current.centre.x,
        y: scaled.y + pinch.centre.y - current.centre.y,
      });
      gesture = { kind: "pinch", ...pinch };
      return;
    }
    if (current.pointerId !== event.pointerId) return;
    if (current.kind === "pan") {
      moveCamera({ x: camera.x + at.x - current.last.x, y: camera.y + at.y - current.last.y, scale: camera.scale });
      current.last = at;
      return;
    }
    const dx = at.x - current.start.x;
    const dy = at.y - current.start.y;
    // A finger on a card moves the chart, as on every map on a phone. A card changes its manager
    // there from its panel; a mouse can still drag it.
    if (event.pointerType === "touch" && !current.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD * 2) return;
      gesture = { kind: "pan", pointerId: current.pointerId, last: at };
      moveCamera({ x: camera.x + dx, y: camera.y + dy, scale: camera.scale });
      setUi((draft) => {
        draft.panning = true;
      });
      return;
    }
    if (!current.dragging) {
      if (!canMove() || Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      current.dragging = true;
      current.blocked = orgChartSubtree(input(), current.id);
    }
    const top = overTopZone(event);
    const over = top ? null : dropTarget(toWorld(at), current.blocked);
    setUi((draft) => {
      draft.drag = { id: current.id, dx: dx / camera.scale, dy: dy / camera.scale, over, top };
    });
  };

  const onPointerUp = (event: PointerEvent) => {
    touches.delete(event.pointerId);
    const current = gesture;
    if (current?.kind === "pinch") {
      if (touches.size < 2) gesture = undefined;
      return;
    }
    if (!current || current.pointerId !== event.pointerId) return;
    gesture = undefined;
    if (viewport?.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (current.kind === "pan") {
      setUi((draft) => {
        draft.panning = false;
      });
      return;
    }
    if (!current.dragging) {
      select(current.id);
      return;
    }
    const drag = ui.drag;
    setUi((draft) => {
      draft.drag = null;
    });
    if (event.type === "pointercancel" || !drag) return;
    const agent = agents().get(current.id);
    const managerId = drag.top ? null : drag.over;
    if (!agent || (!drag.top && drag.over === null) || agent.managerId === managerId) return;
    setUi((draft) => {
      draft.move = { agentId: current.id, managerId };
      draft.moveError = null;
    });
  };

  const onWheel = (event: WheelEvent) => {
    if (event.target instanceof Element && event.target.closest("[data-org-hud], .ws-org-panel")) return;
    event.preventDefault();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? view().height
          : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    if (event.ctrlKey || event.metaKey) {
      const step = Math.max(
        -WHEEL_ZOOM_MAX,
        Math.min(WHEEL_ZOOM_MAX, -dy * (event.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE)),
      );
      moveCamera(zoomAround(camera.scale * Math.exp(step), local(event)));
      return;
    }
    moveCamera({ x: camera.x - dx * WHEEL_PAN_SPEED, y: camera.y - dy * WHEEL_PAN_SPEED, scale: camera.scale });
  };

  onSettled(() => {
    const area = viewport;
    if (!area) return;
    const size = new ResizeObserver(() => setView({ width: area.clientWidth, height: area.clientHeight }));
    size.observe(area);
    area.addEventListener("wheel", onWheel, { passive: false });
    // The zoom keys and Escape work while focus is anywhere on the canvas, its bars included.
    stage?.addEventListener("keydown", onStageKey);
    if (props.initialAgentId) {
      const id = props.initialAgentId;
      requestAnimationFrame(() => jumpTo(id));
    }
    return () => {
      size.disconnect();
      area.removeEventListener("wheel", onWheel);
      stage?.removeEventListener("keydown", onStageKey);
      stopGlide();
      clearTimeout(flashTimer);
    };
  });

  /* ------------------------------------------------------ Message pulses */

  /** The messages that were there when the chart opened do not pulse; only new ones do. */
  let seen: Set<string> | undefined;
  createEffect(
    () => props.messages ?? [],
    (messages) => {
      const known = seen;
      seen = new Set(messages.map((message) => message.id));
      if (!known) return;
      const nodes = untrack(layout).nodes;
      const fresh = messages.flatMap((message) => {
        const from = nodes.get(message.from);
        const to = nodes.get(message.to);
        return !known.has(message.id) && from && to ? [{ key: message.id, path: messagePath(from, to) }] : [];
      });
      if (fresh.length === 0) return;
      setPulses((current) => [...current, ...fresh]);
      setTimeout(
        () => setPulses((current) => current.filter((pulse) => !fresh.some((item) => item.key === pulse.key))),
        PULSE_MS,
      );
    },
  );

  /* ------------------------------------------------------------- Moves */

  const moveText = createMemo(() => {
    const move = ui.move;
    if (!move) return undefined;
    const name = agents().get(move.agentId)?.member.name ?? "";
    const managerAgent = move.managerId ? agents().get(move.managerId) : undefined;
    // Several leads can share a name, so the title tells them apart.
    const manager = move.managerId
      ? [managerAgent?.member.name, managerAgent?.title].filter(Boolean).join(" · ")
      : null;
    return {
      title: t("workspace.org.move.title", { name }),
      description:
        manager === null
          ? t("workspace.org.move.toTop", { name })
          : t("workspace.org.move.toManager", { name, manager }),
    };
  });
  const confirmMove = async () => {
    const move = ui.move;
    if (!move || !props.onChangeManager) return;
    try {
      await props.onChangeManager(move.agentId, move.managerId);
      setUi((draft) => {
        draft.move = null;
      });
      jumpTo(move.agentId);
    } catch (error) {
      setUi((draft) => {
        draft.moveError = errorMessage(error, t("workspace.org.moveFailed"));
      });
    }
  };

  /* ------------------------------------------------------------ Render */

  const worldStyle = () => ({
    transform: `translate(${devicePixel(camera.x)}px, ${devicePixel(camera.y)}px) scale(${camera.scale})`,
  });
  const dragging = () => ui.drag;

  return (
    <section class={cx("ws-view ws-org", props.class)} aria-label={t("workspace.view.org")}>
      <WorkspacePaneHeader
        icon={<Network aria-hidden="true" />}
        title={t("workspace.view.org")}
        subtitle={summary()}
        onBack={props.onBack}
      />
      <Show
        when={props.agents.length > 0}
        fallback={
          <div class="ws-view-scroll">
            <EmptyState icon={<Bot />} title={t("workspace.org.empty")} description={t("workspace.org.emptyHint")} />
          </div>
        }
      >
        <div class="ws-org-body" data-panel={selected() ? "" : undefined}>
          {/* The workflow canvas styles give the stage, the dot grid and the glass bars. */}
          <div
            ref={(element: HTMLDivElement) => {
              stage = element;
            }}
            class="ws-org-stage wfn-stage wfn-canvas"
          >
            <div
              ref={(element: HTMLDivElement) => {
                viewport = element;
              }}
              class="wfn-viewport ws-org-viewport"
              data-panning={ui.panning ? "" : undefined}
              data-dragging={dragging() ? "" : undefined}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <DotGrid camera={camera} />
              <div class="wfn-world ws-org-world" style={worldStyle()}>
                <svg
                  class="ws-org-lines"
                  width={layout().bounds.width}
                  height={layout().bounds.height}
                  aria-hidden="true"
                >
                  <For each={layout().edges} keyed={(edge) => edge.id}>
                    {(edge) => (
                      <g
                        class="ws-org-line"
                        data-state={agents().get(edge().to)?.state ?? "idle"}
                        data-highlight={highlighted().has(edge().to) ? "" : undefined}
                      >
                        <path class="ws-org-line-base" d={edge().path} />
                        <path class="ws-org-line-flow" d={edge().path} pathLength="100" />
                      </g>
                    )}
                  </For>
                  <For each={pulses()} keyed={(pulse) => pulse.key}>
                    {(pulse) => <path class="ws-org-message-line" d={pulse().path} pathLength="100" />}
                  </For>
                </svg>
                <For each={pulses()} keyed={(pulse) => pulse.key}>
                  {(pulse) => <span class="ws-org-pulse" style={{ "offset-path": `path("${pulse().path}")` }} />}
                </For>
                <div class="ws-org-cards">
                  <For each={placed()} keyed={(node) => node.id}>
                    {(node) => {
                      const agent = () => agents().get(node().id);
                      return (
                        <Show when={agent()}>
                          {(current) => (
                            <OrgCard
                              id={cardId(node().id)}
                              agent={current()}
                              node={node()}
                              focusable={tabStop() === node().id}
                              selected={ui.selectedId === node().id}
                              flash={ui.flashId === node().id}
                              dimmed={
                                ui.query.trim() !== "" && !matches().some((match) => match.member.id === node().id)
                              }
                              drag={dragging()}
                              onToggle={() => toggleCollapsed(node().id)}
                              onSelect={() => select(node().id)}
                              onFocus={() =>
                                setUi((draft) => {
                                  draft.focusedId = node().id;
                                })
                              }
                              onKeyDown={(event) => onCardKey(event, node().id)}
                            />
                          )}
                        </Show>
                      );
                    }}
                  </For>
                </div>
              </div>
            </div>

            <div class="wfn-hud ws-org-search" data-org-hud="">
              <Search aria-hidden="true" />
              <Input
                size="sm"
                value={ui.query}
                aria-label={t("workspace.org.search")}
                placeholder={t("workspace.org.search")}
                onValueChange={(value) =>
                  setUi((draft) => {
                    draft.query = value;
                  })
                }
                onKeyDown={(event: KeyboardEvent) => {
                  const first = matches()[0];
                  if (event.key === "Enter" && first) {
                    event.preventDefault();
                    jumpTo(first.member.id);
                  } else if (event.key === "Escape") {
                    setUi((draft) => {
                      draft.query = "";
                    });
                  }
                }}
              />
              <span class="wfn-hud-separator" aria-hidden="true" />
              <HudButton label={t("workspace.org.collapseAll")} onClick={() => collapseAll(true)}>
                <ChevronsDownUp />
              </HudButton>
              <HudButton label={t("workspace.org.expandAll")} onClick={() => collapseAll(false)}>
                <ChevronsUpDown />
              </HudButton>
            </div>
            <Show when={ui.query.trim()}>
              <div class="ws-org-results" data-org-hud="">
                <Show
                  when={matches().length > 0}
                  fallback={<p class="ws-org-results-empty">{t("workspace.org.noMatch")}</p>}
                >
                  <For each={matches()} keyed={(agent) => agent.member.id}>
                    {(agent) => (
                      <Button variant="ghost" size="sm" class="ws-org-result" onClick={() => jumpTo(agent().member.id)}>
                        <MemberAvatar member={agent().member} size="sm" />
                        <span class="ws-org-result-name">{agent().member.name}</span>
                        <Show when={agent().title}>
                          <span class="ws-org-result-title">{agent().title}</span>
                        </Show>
                      </Button>
                    )}
                  </For>
                </Show>
              </div>
            </Show>

            <Show when={canMove()}>
              <div
                ref={(element: HTMLDivElement) => {
                  topZone = element;
                }}
                class="ws-org-top-zone"
                data-shown={dragging() ? "" : undefined}
                data-over={dragging()?.top ? "" : undefined}
                aria-hidden="true"
              >
                {t("workspace.org.dropTop")}
              </div>
              <p class="ws-org-hint">{t("workspace.org.dragHint")}</p>
            </Show>

            <WorkflowZoomMenu
              scale={camera.scale}
              minScale={MIN_SCALE}
              maxScale={MAX_SCALE}
              onZoom={zoom}
              onZoomTo={zoomTo}
            />
          </div>

          <Show when={selected()}>
            {(agent) => (
              <aside class="ws-org-panel" data-org-hud="">
                <OrgChartPanel
                  agent={agent()}
                  agents={props.agents}
                  layoutInput={input()}
                  canChangeManager={canMove()}
                  onOpenChat={() => props.onOpenChat(agent().member.id)}
                  onJump={jumpTo}
                  onChangeManager={async (managerId) => {
                    await props.onChangeManager?.(agent().member.id, managerId);
                    jumpTo(agent().member.id);
                  }}
                  onClose={() => select(null)}
                  {...(props.onSleepTeam
                    ? {
                        onSleepTeam: (sleeping: boolean) =>
                          props.onSleepTeam?.(agent().member.id, sleeping) ?? Promise.resolve(),
                      }
                    : {})}
                />
              </aside>
            )}
          </Show>
        </div>
      </Show>

      <ConfirmDialog
        open={ui.move !== null}
        tone="default"
        title={moveText()?.title ?? ""}
        description={moveText()?.description}
        confirmLabel={t("workspace.org.move.confirm")}
        error={ui.moveError ?? undefined}
        onCancel={() =>
          setUi((draft) => {
            draft.move = null;
            draft.moveError = null;
          })
        }
        onConfirm={confirmMove}
      />
    </section>
  );
}

function OrgCard(props: {
  id: string;
  agent: OrgChartAgent;
  node: OrgChartPlacedNode;
  focusable: boolean;
  selected: boolean;
  flash: boolean;
  dimmed: boolean;
  drag: OrgChartDrag | null;
  onToggle: () => void;
  /** A click from the keyboard: Enter or Space on the card. A pointer selects through the canvas. */
  onSelect: () => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}): JSX.Element {
  const { t } = useText();
  const reports = () => props.node.childIds.length;
  const dragged = () => props.drag?.id === props.node.id;
  const stateText = () => t(STATE_LABEL[props.agent.state]);
  /** The line under the name: what it does now, else its last message. */
  const line = () =>
    props.agent.state === "idle" ? props.agent.preview : (props.agent.activity ?? props.agent.preview);
  return (
    <div
      class="ws-org-card"
      data-agent-id={props.node.id}
      data-state={props.agent.state}
      data-selected={props.selected ? "" : undefined}
      data-flash={props.flash ? "" : undefined}
      data-dimmed={props.dimmed ? "" : undefined}
      data-dragged={dragged() ? "" : undefined}
      data-drop-target={props.drag?.over === props.node.id ? "" : undefined}
      data-background={props.agent.background ? "" : undefined}
      style={{
        left: `${props.node.x}px`,
        top: `${props.node.y}px`,
        width: `${ORG_CHART_SIZE.card.width}px`,
        height: `${ORG_CHART_SIZE.card.height}px`,
        translate: dragged() ? `${props.drag?.dx ?? 0}px ${props.drag?.dy ?? 0}px` : undefined,
      }}
    >
      {/* The card's one keyboard stop, as a row of the trace waterfall has. */}
      <Button
        id={props.id}
        variant="ghost"
        class="ws-org-card-main"
        tabindex={props.focusable ? 0 : -1}
        aria-label={[props.agent.member.name, props.agent.title, stateText()].filter(Boolean).join(", ")}
        aria-pressed={props.selected ? "true" : "false"}
        aria-expanded={reports() > 0 ? (props.node.collapsed ? "false" : "true") : undefined}
        onFocus={() => props.onFocus()}
        onKeyDown={(event: KeyboardEvent) => props.onKeyDown(event)}
        onClick={(event: MouseEvent) => {
          if (event.detail === 0) props.onSelect();
        }}
      >
        <span class="ws-org-card-head">
          <MemberAvatar
            member={{ ...props.agent.member, working: props.agent.state === "working" }}
            size="md"
            animate
            class="ws-org-card-avatar"
          />
          <span class="ws-org-card-copy">
            <span class="ws-org-card-name">{props.agent.member.name}</span>
            <span class="ws-org-card-title">{props.agent.title || "\u00a0"}</span>
          </span>
          <Show when={props.agent.state !== "idle"}>
            <span class="ws-org-state" data-state={props.agent.state}>
              <span class="ws-org-state-dot" aria-hidden="true" />
              {stateText()}
            </span>
          </Show>
        </span>
        <span class="ws-org-card-line" data-state={props.agent.state}>
          {line() || "\u00a0"}
        </span>
      </Button>
      <div class="ws-org-card-meta">
        <Show when={props.agent.ticket}>{(ticket) => <TicketChip ticket={ticket()} />}</Show>
        <Show when={props.agent.model}>
          <span class="ws-org-chip" title={props.agent.model}>
            {props.agent.effort ? `${props.agent.model} · ${props.agent.effort}` : props.agent.model}
          </span>
        </Show>
        <Show when={props.agent.queued}>
          {(queued) => <span class="ws-org-chip">{t("workspace.org.queued", { count: queued() })}</span>}
        </Show>
        <Show when={reports() > 0}>
          <Button
            variant="ghost"
            size="xs"
            class="ws-org-toggle"
            tabindex={-1}
            aria-label={t(props.node.collapsed ? "workspace.org.expand" : "workspace.org.collapse", {
              name: props.agent.member.name,
            })}
            data-collapsed={props.node.collapsed ? "" : undefined}
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              props.onToggle();
            }}
          >
            {props.node.collapsed
              ? t("workspace.org.hidden", { count: props.node.descendants })
              : t("workspace.org.reports", { count: reports() })}
          </Button>
        </Show>
      </div>
    </div>
  );
}
