/*
 * Where the Fleet and the Artifacts views get their data. Each view reads one small interface, so a
 * host endpoint for the fleet status or an artifacts index plugs in later without a change to the
 * views. Until then the workspace builds both from what it already has: the agent list with its
 * runtime state, the channel list, and the channel messages it has read.
 */

import type {
  AgentEvent,
  ChannelMessage,
  ChannelSummary,
  TeamRealtimeEvent,
  WorkspaceArtifactRecord,
  WorkspaceFleetAgent,
} from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import type { SidebarAgentState } from "@openbot/ui/features/sidebar/sidebar-types";
import type { FleetAgent } from "@openbot/ui/features/workspace/FleetView";
import type { WorkspaceArtifact } from "@openbot/ui/features/workspace/workspace-types";
import { currentText } from "@openbot/ui/text";
import { createMemo, createSignal, onCleanup } from "solid-js";
import type { ChannelsPort } from "../channels/channels-port";
import { agentMember, memberById, messageArtifacts, type WorkspaceDirectory } from "./workspace-model";

/** The live state of every agent, for the Fleet view. */
export interface WorkspaceFleetSource {
  agents: () => readonly FleetAgent[];
  /** True while the first answer of a remote source is on its way. */
  loading?: () => boolean;
  /** Asks the source for a fresh state, such as when the view opens. */
  refresh?: () => void;
}

/** The deliverables of the agents, for the Artifacts view and the channel's artifacts panel. */
export interface WorkspaceArtifactsSource {
  /** All artifacts of the workspace, or those of one channel, newest first. */
  artifacts: (scope?: { channelId?: string | undefined }) => readonly WorkspaceArtifact[];
  loading?: () => boolean;
  refresh?: (scope?: { channelId?: string | undefined }) => void;
}

export interface LocalFleetInput {
  agents: () => readonly AgentProfile[];
  agentStates: () => Readonly<Record<string, SidebarAgentState>>;
  channels: () => readonly ChannelSummary[];
  readerName: () => string;
}

/**
 * The fleet from the agent list and its runtime state. A working agent names the channel where it
 * has a running task; cost and time wait for the host's fleet endpoint.
 */
export function createLocalFleetSource(input: LocalFleetInput): WorkspaceFleetSource {
  const agents = createMemo((): FleetAgent[] => {
    const states = input.agentStates();
    const channels = input.channels();
    return input.agents().map((agent) => {
      const state = states[agent.id];
      const channel = channels.find(
        (summary) =>
          !summary.archived &&
          summary.activeTasks > 0 &&
          (summary.threads?.some((thread) => thread.agentId === agent.id) ??
            summary.members.some((member) => member.agentId === agent.id)),
      );
      const status: FleetAgent["status"] =
        state?.kind === "working"
          ? { state: "working", task: agent.preview || agent.title || agent.name, channelName: channel?.name }
          : state?.kind === "waiting"
            ? { state: "waiting", personName: input.readerName(), channelName: channel?.name }
            : { state: "idle" };
      return {
        member: agentMember(agent, state?.kind === "working"),
        title: agent.title || undefined,
        status,
        currentStep: state?.kind === "waiting" ? (state.detail ?? undefined) : undefined,
      };
    });
  });
  return { agents };
}

/**
 * The artifacts from the channel messages this client has read: links to hosted apps and sites,
 * pages, documents and the files that agents attached. Each channel page that the reader opens adds
 * its artifacts; the list lasts for the session.
 */
export function createMessageArtifactsSource(directory: () => WorkspaceDirectory) {
  const [byChannel, setByChannel] = createSignal<ReadonlyMap<string, readonly WorkspaceArtifact[]>>(new Map());
  /** The artifacts of each message already read. A new page adds messages; it does not change the others. */
  const scanned = new WeakMap<
    ChannelMessage,
    { directory: WorkspaceDirectory; channelName: string; artifacts: readonly WorkspaceArtifact[] }
  >();
  const source: WorkspaceArtifactsSource = {
    artifacts: (scope) => {
      const map = byChannel();
      const list = scope?.channelId ? (map.get(scope.channelId) ?? []) : [...map.values()].flat();
      return [...list].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
    },
  };
  return {
    source,
    /** Records the artifacts of the messages of one channel that the client read. */
    note(channelId: string, channelName: string, messages: readonly ChannelMessage[]) {
      const current = directory();
      const found = messages.flatMap((entry) => {
        // Only agents deliver artifacts, and a message keeps its object until it changes.
        if (entry.author.kind !== "agent") return [];
        const known = scanned.get(entry);
        if (known && known.directory === current && known.channelName === channelName) return known.artifacts;
        const artifacts = messageArtifacts(current, entry, channelName);
        scanned.set(entry, { directory: current, channelName, artifacts });
        return artifacts;
      });
      setByChannel((current) => {
        const known = current.get(channelId) ?? [];
        const ids = new Set(found.map((artifact) => artifact.id));
        const merged = [...found, ...known.filter((artifact) => !ids.has(artifact.id))];
        if (merged.length === known.length && merged.every((artifact, index) => artifact.id === known[index]?.id))
          return current;
        const next = new Map(current);
        next.set(channelId, merged);
        return next;
      });
    },
  };
}

/** The fleet that the host reports (`workspaceFleet`), with the local one until it answers or where it cannot. */
export function createHostFleetSource(input: {
  port: () => ChannelsPort;
  directory: () => WorkspaceDirectory;
  channels: () => readonly ChannelSummary[];
  onHostEvent: (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void;
  fallback: WorkspaceFleetSource;
}): WorkspaceFleetSource {
  const [hosted, setHosted] = createSignal<readonly WorkspaceFleetAgent[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = 0;
  async function load() {
    const read = input.port().agent.workspaceFleet;
    if (!read || failed) return;
    last = Date.now();
    setLoading(hosted() === null);
    try {
      const fleet = await read({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setHosted(fleet.agents);
    } catch {
      // A host without the fleet route keeps the local fleet for this session.
      failed = true;
    } finally {
      setLoading(false);
    }
  }
  /** At most one read a second: the host sends its change event that often while agents work. */
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), Math.max(0, 1_000 - (Date.now() - last)));
  }
  const unsubscribe = input.onHostEvent((event) => {
    if (event.type === "workspace-fleet-changed" && hosted() !== null) schedule();
  });
  onCleanup(() => {
    unsubscribe();
    clearTimeout(timer);
  });
  const agents = createMemo((): readonly FleetAgent[] => {
    const records = hosted();
    if (!records) return input.fallback.agents();
    const directory = input.directory();
    const channelName = (id: string | undefined) =>
      id ? input.channels().find((channel) => channel.id === id)?.name : undefined;
    const { t } = currentText();
    return directory.agents.map((agent): FleetAgent => {
      const record = records.find((entry) => entry.agentId === agent.id);
      const status = record?.status;
      const work: FleetAgent["status"] =
        status?.kind === "working"
          ? { state: "working", task: status.what, channelName: channelName(status.channelId) }
          : status?.kind === "waiting"
            ? {
                state: "waiting",
                personName: status.forMemberId ? memberById(directory, status.forMemberId).name : directory.reader.name,
                channelName: channelName(status.channelId),
                ...(status.reason === "usage-limit" ? { usageLimit: { resetsAt: status.resetsAt } } : {}),
              }
            : status?.kind === "queued"
              ? { state: "working", task: t("workspace.app.fleet.queued", { count: status.count }) }
              : { state: "idle" };
      return {
        member: agentMember(agent, status?.kind === "working"),
        title: agent.title || undefined,
        status: work,
        currentStep: record?.currentStep,
        todayCostUsd: record?.todayCostUsd,
        todayDurationMs: record?.todayDurationMs,
      };
    });
  });
  return { agents, loading, refresh: () => void load() };
}

function artifactView(
  directory: WorkspaceDirectory,
  channels: readonly ChannelSummary[],
  record: WorkspaceArtifactRecord,
): WorkspaceArtifact {
  const agent = record.agentId ? directory.agents.find((candidate) => candidate.id === record.agentId) : undefined;
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    description: record.description,
    url: record.url,
    thumbnailUrl: record.thumbnailUrl,
    agent: agent ? agentMember(agent) : undefined,
    channelId: record.channelId,
    channelName: record.channelId ? channels.find((channel) => channel.id === record.channelId)?.name : undefined,
    costUsd: record.costUsd,
    durationMs: record.durationMs,
    createdAt: record.updatedAt,
  };
}

/**
 * The artifacts index of the host (`workspaceArtifacts`), for the whole workspace and for one
 * channel. Until it answers, or on a host without it, the artifacts of the messages read stand in.
 */
export function createHostArtifactsSource(input: {
  port: () => ChannelsPort;
  directory: () => WorkspaceDirectory;
  channels: () => readonly ChannelSummary[];
  onHostEvent: (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void;
  fallback: WorkspaceArtifactsSource;
}) {
  const [records, setRecords] = createSignal<ReadonlyMap<string, readonly WorkspaceArtifactRecord[]>>(new Map());
  const [loading, setLoading] = createSignal(false);
  let failed = false;
  const watched = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const scopeKey = (channelId?: string) => channelId ?? "*";
  async function load(channelId?: string) {
    const read = input.port().agent.workspaceArtifacts;
    if (!read || failed) return;
    const key = scopeKey(channelId);
    watched.add(key);
    setLoading(!records().has(key));
    try {
      const result = await read({ ...(channelId ? { channelId } : {}), limit: 200 });
      setRecords((current) => new Map(current).set(key, result.artifacts));
    } catch {
      failed = true;
    } finally {
      setLoading(false);
    }
  }
  const unsubscribe = input.onHostEvent((event) => {
    if (event.type !== "channel-message" && event.type !== "channel-message-removed") return;
    for (const key of [scopeKey(event.channelId), scopeKey()]) {
      if (!watched.has(key)) continue;
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => void load(key === "*" ? undefined : key), 2_000),
      );
    }
  });
  onCleanup(() => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
  });
  const source: WorkspaceArtifactsSource = {
    artifacts: (scope) => {
      const list = records().get(scopeKey(scope?.channelId));
      if (!list) return input.fallback.artifacts(scope);
      const directory = input.directory();
      const channels = input.channels();
      return list.map((record) => artifactView(directory, channels, record));
    },
    loading,
    refresh: (scope) => void load(scope?.channelId),
  };
  return {
    source,
    /** The record of an artifact, to open its file. */
    record: (id: string) => {
      for (const list of records().values()) {
        const found = list.find((record) => record.id === id);
        if (found) return found;
      }
      return undefined;
    },
  };
}
