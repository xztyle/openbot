import { type AutoModelReason, isAutoModelReason } from "@openbot/contracts/agent-efficiency";
import type { ChannelMessage, ChannelPage, ChannelTask, WorkspaceSteps } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { toast } from "@openbot/ui";
import type { TypingAgent } from "@openbot/ui/features/workspace/TypingIndicator";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
import { shortModelName } from "../efficiency/efficiency-port";
import { useWorkspace } from "./workspace-context";
import { debugMode } from "./workspace-debug";
import { memberById, thinkingAgents, workingAgents } from "./workspace-model";

/** How often the steps of a working agent are read again. */
const STEPS_POLL_MS = 2_000;

/** How long Stop shows "Stopping…" at most when the work does not end. */
const STOP_SETTLE_MS = 15_000;

const ACTIVE_TASK_STATES: ReadonlySet<string> = new Set(["queued", "running", "waiting"]);

/** When the page and the host disagree, the later step of an answer wins: working over waiting over routing. */
const STATE_RANK: Record<TypingAgent["state"], number> = { thinking: 0, routing: 1, waiting: 2, working: 3 };

/**
 * The tasks to stop so that one agent stops its work in a place: its active tasks there, without
 * the ones under another of them, because a stop holds the whole run below a task. `inPlace` says
 * whether a task's request belongs to the channel or the thread the reader looks at. When no task
 * of the agent is in the place, every active task of the agent in the channel is stopped: the line
 * shows the agent at work, so Stop must stop it.
 */

const REASON_TEXT = {
  routine: "efficiency.model.reason.routine",
  note: "efficiency.model.reason.note",
  status: "efficiency.model.reason.status",
  event: "efficiency.model.reason.event",
  default: "efficiency.model.reason.default",
  plan: "efficiency.model.reason.plan",
  retry: "efficiency.model.reason.retry",
  escalated: "efficiency.model.reason.escalated",
  large: "efficiency.model.reason.large",
} as const satisfies Record<AutoModelReason, AppTextKey>;

export function agentRunsToStop(
  tasks: readonly ChannelTask[],
  agentId: string,
  inPlace: (task: ChannelTask) => boolean,
): string[] {
  const own = tasks.filter((task) => task.ownerAgentId === agentId && ACTIVE_TASK_STATES.has(task.state));
  const here = own.filter(inPlace);
  const chosen = here.length ? here : own;
  const ids = new Set(chosen.map((task) => task.id));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const underChosen = (task: ChannelTask) => {
    const seen = new Set<string>();
    for (let parent = task.parentTaskId; parent && !seen.has(parent); parent = byId.get(parent)?.parentTaskId ?? null) {
      if (ids.has(parent)) return true;
      seen.add(parent);
    }
    return false;
  };
  return chosen.filter((task) => !underChosen(task)).map((task) => task.id);
}

/**
 * Who works, waits, routes, thinks and types in a channel or in one of its threads, for the line
 * over the composer: the host's typing list once it sent one, else the tasks and the gate of the
 * page, and in both cases the running tasks and streaming answers of the page. A working agent gets
 * what it does now, its steps so far, and Stop. The channel and the thread panel use this one model,
 * so the line reads the same in both.
 */
export function createAgentWork(input: {
  channelId: string;
  /** The root of the thread, or null for the channel transcript. */
  threadRootId: string | null;
  /** The messages of the place: the channel page or the thread page. */
  entries: Accessor<readonly ChannelMessage[]>;
  /** Whether the reader may stop work here: a member of a live channel, while connected. */
  canStop: Accessor<boolean>;
}): { agents: Accessor<TypingAgent[]>; humans: Accessor<WorkspaceMember[]> } {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  /** The freshest tasks of the channel. The channel page reads them again on each change. */
  const tasks = (): readonly ChannelTask[] => {
    const page: ChannelPage | null = ws.channels.state.page;
    if (page?.channel.id === input.channelId) return page.tasks;
    const thread = ws.state.thread;
    return thread?.channelId === input.channelId ? (thread.page?.tasks ?? []) : [];
  };
  /** Each known message's thread: null for a top-level message. */
  const threadOf = createMemo(() => {
    const known = new Map<string, string | null>();
    // Only the requests of the tasks are looked up: a long channel has thousands of messages, and
    // this runs again on each change of the page.
    const wanted = new Set(tasks().map((task) => task.requestMessageId));
    if (wanted.size === 0) return known;
    const read = new Set<readonly ChannelMessage[]>();
    const add = (messages: readonly ChannelMessage[] | undefined) => {
      if (!messages || read.has(messages)) return;
      read.add(messages);
      for (const message of messages) {
        const id = message.id;
        if (wanted.has(id)) known.set(id, message.threadRootId ?? null);
      }
    };
    const page = ws.channels.state.page;
    if (page?.channel.id === input.channelId) add(page.messages);
    const thread = ws.state.thread;
    if (thread?.channelId === input.channelId) add(thread.page?.messages);
    add(input.entries());
    return known;
  });
  /** A task belongs here when its request is in this thread, or, for the channel, not in a thread. */
  const inPlace = (task: ChannelTask): boolean => {
    const known = threadOf();
    if (input.threadRootId)
      return task.requestMessageId === input.threadRootId || known.get(task.requestMessageId) === input.threadRootId;
    const thread = known.get(task.requestMessageId);
    return thread === undefined || thread === null;
  };
  const live = createMemo(() => ws.typingIn(input.channelId, input.threadRootId));
  const leadAgentId = (): string | null => {
    const page = ws.channels.state.page;
    return page?.channel.id === input.channelId ? (page.channel.leadAgentId ?? null) : null;
  };
  const humans = createMemo(() => (live()?.humans ?? []).map((id) => memberById(ws.directory(), id)));
  /**
   * What each agent does here. The host's list says it once the host sent one. Without it, the page
   * shows it: the gate's pending agents think, a queued request waits for its owner, and a request
   * without an owner is the lead's to route, and an agent whose answer streams works. Either way,
   * an agent whose task runs here works: the page reads its tasks again on each change, so a typing
   * event that the connection lost does not hide the agent.
   */
  const ids = createMemo(() => {
    const host = live();
    const entries = input.entries();
    const here = tasks().filter(inPlace);
    const states = new Map<string, TypingAgent["state"]>();
    const put = (id: string, state: TypingAgent["state"]) => {
      const known = states.get(id);
      if (!known || STATE_RANK[state] > STATE_RANK[known]) states.set(id, state);
    };
    if (host) for (const agent of host.agents) put(agent.id, agent.state);
    else {
      for (const id of thinkingAgents([...entries])) put(id, "thinking");
      const lead = leadAgentId();
      for (const task of here)
        if (task.state === "queued")
          if (task.ownerAgentId) put(task.ownerAgentId, "waiting");
          else if (lead) put(lead, "routing");
    }
    // Beside the host's list, only a running task whose request the page has: one of a thread reply
    // that the channel page does not hold would show in the channel too.
    const known = threadOf();
    const replies = input.threadRootId ? entries.filter((entry) => entry.id !== input.threadRootId) : entries;
    const working = host
      ? workingAgents(
          [],
          here.filter((task) => known.has(task.requestMessageId)),
        )
      : workingAgents(replies, here);
    for (const id of working) put(id, "working");
    return states;
  });
  /** The agents that may be stopped here: their turn runs, or waits for earlier work. */
  const stoppable = createMemo(() =>
    [...ids()].flatMap(([id, state]) => (state === "working" || state === "waiting" ? [id] : [])),
  );

  /** The steps so far of each working agent, read every 2 s while it works. */
  const [liveSteps, setLiveSteps] = createSignal<Record<string, WorkspaceSteps>>({});
  createEffect(
    () => [...ids()].flatMap(([id, state]) => (state === "working" ? [id] : [])).join(" "),
    (key) => {
      const read = ws.channels.port().agent.workspaceSteps;
      if (!key || !read) {
        setLiveSteps({});
        return;
      }
      const agentIds = key.split(" ");
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        const results = await Promise.all(
          agentIds.map((agentId) =>
            read({ channelId: input.channelId, agentId }).then(
              (steps) => [agentId, steps] as const,
              () => [agentId, null] as const,
            ),
          ),
        );
        if (stopped) return;
        const next: Record<string, WorkspaceSteps> = {};
        for (const [agentId, steps] of results) if (steps && steps.total > 0) next[agentId] = steps;
        setLiveSteps(next);
        timer = setTimeout(() => void poll(), STEPS_POLL_MS);
      };
      void poll();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  );

  /** The agents whose stop was sent. Each one leaves the set when its work ends or the stop fails. */
  const [stopping, setStopping] = createSignal<ReadonlySet<string>>(new Set());
  createEffect(stoppable, (working) => {
    const current = stopping();
    if ([...current].some((id) => !working.includes(id)))
      setStopping(new Set([...current].filter((id) => working.includes(id))));
  });
  async function stop(agentId: string, name: string) {
    if (stopping().has(agentId)) return;
    const taskIds = agentRunsToStop(tasks(), agentId, inPlace);
    if (!taskIds.length) {
      toast.error(t("workspace.typing.stopFailed", { name }));
      return;
    }
    const release = () => setStopping((current) => new Set([...current].filter((id) => id !== agentId)));
    setStopping((current) => new Set([...current, agentId]));
    // A host that never reports the end leaves the button pressable again, so the reader can retry.
    setTimeout(release, STOP_SETTLE_MS);
    try {
      // One at a time: each stop holds a run of the channel, and the host applies them in order.
      for (const taskId of taskIds)
        await ws.channels.port().agent.channelCommand({
          type: "stop",
          operationId: crypto.randomUUID(),
          channelId: input.channelId,
          taskId,
          recipientAgentId: null,
        });
      void ws.channels.refresh();
    } catch (error) {
      release();
      toast.error(errorMessage(error, t("workspace.typing.stopFailed", { name })));
    }
  }

  const agents = createMemo((): TypingAgent[] => {
    const directory = ws.directory();
    const fleet = ws.fleet.agents();
    const steps = liveSteps();
    const halting = stopping();
    const canStop = input.canStop();
    // The agents that think or route first, then the ones that wait, then the ones at work.
    return [...ids()]
      .sort(([, left], [, right]) => STATE_RANK[left] - STATE_RANK[right])
      .map(([id, state]): TypingAgent => {
        const member = memberById(directory, id);
        if (state === "thinking" || state === "routing") return { member, state };
        const onStop = canStop ? () => void stop(id, member.name) : undefined;
        if (state === "waiting") return { member, state, onStop, stopping: halting.has(id) };
        const trail = steps[id];
        const record = fleet.find((agent) => agent.member.id === id);
        const model = record?.model ? modelNote(record.model, record.modelReason) : undefined;
        return {
          member,
          state,
          label: record?.currentStep,
          ...(model ? { model } : {}),
          trail: trail ? { steps: trail.steps, durationMs: trail.durationMs || undefined } : undefined,
          onStop,
          stopping: halting.has(id),
        };
      });
  });
  /** "on Haiku", and in debug mode why the automatic policy chose it: "on Haiku · routine run". */
  function modelNote(model: string, reason: string | undefined): string {
    const line = t("efficiency.model.working", { model: shortModelName(model) });
    const why = reason && isAutoModelReason(reason) ? t(REASON_TEXT[reason]) : null;
    return debugMode() && why ? `${line} · ${why}` : line;
  }
  return { agents, humans };
}
