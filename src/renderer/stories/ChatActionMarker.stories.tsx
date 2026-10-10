import { Heading, Text } from "@openbot/ui";
import type { AgentMessage, AgentProfile, ChatActionMarkerModel } from "@openbot/ui/data";
import { AgentMessageDialog } from "@openbot/ui/features/conversation/AgentMessageDialog";
import { ChatActionMarker } from "@openbot/ui/features/conversation/ChatActionMarker";
import { ChatMessageRow } from "@openbot/ui/features/conversation/ChatMessageRow";
import { createSignal, For } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AgentSkillsModal } from "../src/features/conversation/AgentSkillsModal";
import { requireFixture, STORY_AGENTS } from "./fixtures";

const agents: AgentProfile[] = [
  agent("research", "Research"),
  agent("sales", "Sales"),
  agent("social", "OpenBot SM manager for very long names"),
];
const onSelectAgent = fn();
const onOpenRoutine = fn();
const onOpenHostedSite = fn();

const meta = {
  title: "Conversation/Chat Action Marker",
  component: ChatActionMarker,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof ChatActionMarker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Chat action markers
      </Heading>
      <Text tone="secondary">Agent actions and permanent routine history use one marker.</Text>
      <section class="chat-primitives-gallery chat-action-marker-gallery" aria-label="Chat action marker states">
        <ChatActionMarker
          marker={agentMarker(
            [
              { agentId: "research", status: "completed" },
              { agentId: "sales", status: "running" },
            ],
            "in-progress",
          )}
          agents={agents}
          onSelectAgent={onSelectAgent}
        />
        <ChatActionMarker
          marker={{
            ...agentMarker([{ agentId: "chief", status: "completed" }], "completed"),
            direction: "incoming",
            sourceAgentId: "research",
          }}
          agents={agents}
          onSelectAgent={onSelectAgent}
        />
        <ChatActionMarker
          marker={{ ...agentMarker([{ agentId: "sales", status: "completed" }], "completed"), expectsReply: false }}
          agents={agents}
          onSelectAgent={onSelectAgent}
        />
        <ChatActionMarker
          marker={{
            ...agentMarker([{ agentId: "chief", status: "completed" }], "completed"),
            direction: "incoming",
            sourceAgentId: "research",
            expectsReply: false,
          }}
          agents={agents}
          onSelectAgent={onSelectAgent}
        />
        <SkillMarkers />
        {routineStatuses.map((status) => (
          <ChatActionMarker
            marker={routineMarker(status)}
            agents={agents}
            onSelectAgent={onSelectAgent}
            onOpenRoutine={onOpenRoutine}
          />
        ))}
        {routineActions.map((action) => (
          <ChatActionMarker
            marker={lifecycleMarker(action)}
            agents={agents}
            routineAvailable={action !== "deleted"}
            onSelectAgent={onSelectAgent}
            onOpenRoutine={onOpenRoutine}
          />
        ))}
        {siteActions.flatMap((action) =>
          siteStatuses.map((status) => (
            <ChatActionMarker
              marker={siteMarker(action, status)}
              agents={agents}
              onSelectAgent={onSelectAgent}
              onOpenHostedSite={onOpenHostedSite}
            />
          )),
        )}
        <ChatActionMarker
          marker={{ kind: "unavailable", label: "Action unavailable", timestamp: timestamp }}
          agents={agents}
          onSelectAgent={onSelectAgent}
        />
        <ChatActionMarker marker={{ kind: "context-reset", timestamp }} agents={agents} onSelectAgent={onSelectAgent} />
      </section>
    </main>
  ),
};

/**
 * An event check has no row of its own. The first and the last agent message of the interaction
 * carry a chip on the top edge of the bubble, and a long name is cut with an ellipsis.
 */
export const EventCheckOrigin: Story = {
  render: () => {
    const chief = requireFixture(STORY_AGENTS[0], "Story agent 0");
    const origin = { name: "Slack mentions and DMs", checkId: "slack", timestamp: "2026-09-13T21:03:00.000Z" };
    const rows: Array<{ message: AgentMessage; chip?: "start" | "end" | "only"; name?: string }> = [
      {
        message: storyMessage("start", "Two new mentions in the release channel. I am opening both threads."),
        chip: "start",
      },
      { message: storyMessage("middle", "The first one asks for the changelog link. I sent it.") },
      {
        message: storyMessage("end", "Done. Both threads have an answer and nothing else is waiting."),
        chip: "end",
      },
      {
        message: storyMessage("long", "A check with a very long name keeps the chip inside the chat."),
        chip: "only",
        name: "Slack mentions, direct messages and every channel the team added this quarter",
      },
    ];
    return (
      <main class="conversation-panel" aria-label="Conversation" style={{ height: "100dvh" }}>
        <section class="conversation-scroll" aria-label="Messages">
          <div class="virtual-chat-list virtual-chat-list-static">
            <For each={rows}>
              {(row, index) => (
                <div class="virtual-chat-row" data-grouped={index() === 1 ? "sender" : undefined}>
                  <ChatMessageRow
                    message={row.message}
                    author={{ kind: "agent", name: chief.name, agent: chief }}
                    agents={STORY_AGENTS}
                    eventCheckOrigin={
                      row.chip ? { ...origin, name: row.name ?? origin.name, position: row.chip } : undefined
                    }
                    onSelectAgent={onSelectAgent}
                    onOpenLink={fn()}
                    onPreview={fn()}
                    onAttachmentAction={fn()}
                  />
                </div>
              )}
            </For>
          </div>
        </section>
      </main>
    );
  },
};

function storyMessage(id: string, body: string): AgentMessage {
  return { id, author: "agent", body, time: "9:03 PM", createdAt: "2026-09-13T21:03:00.000Z" };
}

export const CompactAndUnavailable: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Compact markers
      </Heading>
      <section class="chat-primitives-stage chat-primitives-stage-narrow" aria-label="Compact chat action markers">
        <ChatActionMarker
          marker={{
            ...routineMarker("needs-attention"),
            routineName: "Portfolio review with a long unavailable routine name",
          }}
          agents={agents}
          routineAvailable={false}
          onSelectAgent={onSelectAgent}
          onOpenRoutine={onOpenRoutine}
        />
        <ChatActionMarker
          marker={agentMarker([{ agentId: "missing", status: "failed" }], "failed")}
          agents={agents}
          onSelectAgent={onSelectAgent}
        />
        <ChatActionMarker
          marker={{
            ...siteMarker("publish", "running"),
            title: "A very long public launch page title that must remain compact in a narrow conversation",
          }}
          agents={agents}
          onSelectAgent={onSelectAgent}
          onOpenHostedSite={onOpenHostedSite}
        />
      </section>
    </main>
  ),
};

export const AgentRecipientsMenu: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Recipient menu
      </Heading>
      <section class="chat-primitives-stage chat-primitives-stage-narrow" aria-label="Chat marker recipient menu">
        <ChatActionMarker
          marker={agentMarker(
            [
              { agentId: "research", status: "completed" },
              { agentId: "social", status: "completed" },
              { agentId: "sales", status: "running" },
            ],
            "in-progress",
          )}
          agents={agents}
          onSelectAgent={onSelectAgent}
        />
      </section>
    </main>
  ),
};

export const ReducedMotion: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Reduced motion marker
      </Heading>
      <section class="chat-primitives-stage chat-primitives-stage-narrow" aria-label="Reduced motion chat marker">
        <ChatActionMarker
          marker={siteMarker("replace", "running")}
          agents={agents}
          onSelectAgent={onSelectAgent}
          onOpenHostedSite={onOpenHostedSite}
        />
      </section>
    </main>
  ),
  parameters: { chromatic: { prefersReducedMotion: "reduce" } },
};

export const RoutineRunSummary: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Completed routine run
      </Heading>
      <Text tone="secondary">The latest state stays visible. Earlier states are available on demand.</Text>
      <section class="chat-primitives-stage chat-primitives-stage-narrow" aria-label="Routine run summary">
        <ChatActionMarker
          marker={{
            ...routineMarker("succeeded"),
            runId: "run-summary",
            previousTransitions: [
              { status: "queued", timestamp: "2026-09-01T08:00:00.000Z" },
              { status: "running", timestamp: "2026-09-01T08:01:00.000Z" },
              { status: "needs-attention", timestamp: "2026-09-01T08:02:00.000Z" },
              { status: "running", timestamp: "2026-09-01T08:03:00.000Z" },
            ],
          }}
          agents={agents}
          onSelectAgent={onSelectAgent}
          onOpenRoutine={onOpenRoutine}
        />
      </section>
    </main>
  ),
};

export const RoutineRunGroup: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Routine run group
      </Heading>
      <Text tone="secondary">
        Consecutive completed runs of one routine show as one row that opens. A failed run keeps its own row.
      </Text>
      <section class="chat-primitives-stage chat-primitives-stage-narrow" aria-label="Routine run group">
        <ChatActionMarker
          marker={routineRunGroupMarker(["17:15", "17:30", "17:45", "18:00"])}
          agents={agents}
          onSelectAgent={onSelectAgent}
          onOpenRoutine={onOpenRoutine}
        />
        <ChatActionMarker
          marker={{ ...watchRun("18:15"), status: "failed" }}
          agents={agents}
          onSelectAgent={onSelectAgent}
          onOpenRoutine={onOpenRoutine}
        />
        <ChatActionMarker
          marker={routineRunGroupMarker(["18:30", "18:45"])}
          agents={agents}
          onSelectAgent={onSelectAgent}
          onOpenRoutine={onOpenRoutine}
        />
      </section>
    </main>
  ),
};

const peekRequest: AgentMessage = {
  id: "peek-request",
  author: "agent",
  body: "Please check the **pricing page** before we ship.\n\n- Compare it with the plan table\n- Tell me what differs",
  time: "10:00",
  createdAt: "2026-09-13T10:00:00Z",
  exchange: {
    direction: "outgoing",
    messageId: "peek-1",
    senderAgentId: "research",
    recipientAgentIds: ["sales"],
    replyToMessageId: null,
    deliveries: [],
  },
};

const peekReply: AgentMessage = {
  id: "peek-reply",
  author: "agent",
  body: "Two prices differ. I fixed both.",
  time: "10:06",
  createdAt: "2026-09-13T10:06:00Z",
  exchange: {
    direction: "incoming",
    messageId: "peek-2",
    senderAgentId: "sales",
    recipientAgentIds: ["research"],
    replyToMessageId: "peek-1",
    deliveries: [],
  },
};

export const AgentMessagePeek: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Peek at a message between agents
      </Heading>
      <Text tone="secondary">A translucent layer over the chat. The chat row stays compact.</Text>
      <AgentMessageDialog
        entries={[
          { message: peekRequest, senderName: "Research", recipientNames: ["Sales"], status: "completed" },
          { message: peekReply, senderName: "Sales", recipientNames: ["Research"], status: "completed" },
        ]}
        openedMessageId="peek-1"
        agents={agents}
        onClose={fn()}
        onSelectAgent={onSelectAgent}
        onOpenLink={fn()}
        onPreview={fn()}
        onAttachmentAction={fn()}
      />
    </main>
  ),
};

export const AgentMessageGroup: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Agent message group
      </Heading>
      <Text tone="secondary">Consecutive messages with other agents show as one row that opens.</Text>
      <section class="chat-primitives-stage chat-primitives-stage-narrow" aria-label="Agent message group">
        <ChatActionMarker
          marker={{
            kind: "agent-message-group",
            timestamp,
            messages: [
              { id: "group-1", marker: agentMarker([{ agentId: "research", status: "completed" }], "completed") },
              {
                id: "group-2",
                marker: {
                  ...agentMarker([{ agentId: "chief", status: "completed" }], "completed"),
                  direction: "incoming",
                  sourceAgentId: "research",
                },
              },
              {
                id: "group-3",
                marker: agentMarker(
                  [
                    { agentId: "sales", status: "completed" },
                    { agentId: "social", status: "running" },
                  ],
                  "in-progress",
                ),
              },
            ],
          }}
          agents={agents}
          onSelectAgent={onSelectAgent}
        />
      </section>
    </main>
  ),
};

const timestamp = "2026-09-01T08:00:00.000Z";
const routineStatuses: Array<Extract<ChatActionMarkerModel, { kind: "routine-run" }>["status"]> = [
  "queued",
  "running",
  "needs-attention",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
];
const routineActions: Array<Extract<ChatActionMarkerModel, { kind: "routine-lifecycle" }>["action"]> = [
  "created",
  "updated",
  "deleted",
];
const siteActions: Array<Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["action"]> = [
  "publish",
  "replace",
  "delete",
];
const siteStatuses: Array<Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["status"]> = [
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
];

function agentMarker(
  targetDeliveries: Extract<ChatActionMarkerModel, { kind: "agent-message" }>["targetDeliveries"],
  status: Extract<ChatActionMarkerModel, { kind: "agent-message" }>["status"],
): Extract<ChatActionMarkerModel, { kind: "agent-message" }> {
  return {
    kind: "agent-message",
    direction: "outgoing",
    sourceAgentId: "chief",
    targetDeliveries,
    status,
    timestamp,
    messageId: "message-1",
    replyToMessageId: null,
    expectsReply: true,
  };
}

function routineMarker(
  status: Extract<ChatActionMarkerModel, { kind: "routine-run" }>["status"],
): Extract<ChatActionMarkerModel, { kind: "routine-run" }> {
  return {
    kind: "routine-run",
    sourceAgentId: "chief",
    routineId: "routine-1",
    runId: `run-${status}`,
    routineName: "Morning brief",
    status,
    timestamp,
  };
}

function watchRun(time: string): Extract<ChatActionMarkerModel, { kind: "routine-run" }> {
  return {
    kind: "routine-run",
    sourceAgentId: "research",
    routineId: "routine-watch",
    runId: `watch-${time}`,
    routineName: "Watchdog",
    status: "succeeded",
    timestamp: `2026-09-01T${time}:00.000Z`,
    previousTransitions: [{ status: "running", timestamp: `2026-09-01T${time}:00.000Z` }],
  };
}

function routineRunGroupMarker(times: string[]): Extract<ChatActionMarkerModel, { kind: "routine-run-group" }> {
  const runs = times.map((time) => ({ id: `watch-${time}`, marker: watchRun(time) }));
  return {
    kind: "routine-run-group",
    routineId: "routine-watch",
    routineName: "Watchdog",
    runs,
    timestamp: runs.at(-1)?.marker.timestamp ?? timestamp,
  };
}

function lifecycleMarker(
  action: Extract<ChatActionMarkerModel, { kind: "routine-lifecycle" }>["action"],
): Extract<ChatActionMarkerModel, { kind: "routine-lifecycle" }> {
  return {
    kind: "routine-lifecycle",
    action,
    sourceAgentId: "chief",
    routineId: "routine-1",
    routineName: "Morning brief",
    status: "completed",
    timestamp,
  };
}

function siteMarker(
  action: Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["action"],
  status: Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["status"],
): Extract<ChatActionMarkerModel, { kind: "hosted-site" }> {
  const hasPublishedSite = action !== "publish" || status === "succeeded";
  return {
    kind: "hosted-site",
    sourceAgentId: "chief",
    action,
    status,
    operationId: `${action}-${status}`,
    siteId: hasPublishedSite ? "site-1" : null,
    title: "Launch page",
    hostname: hasPublishedSite ? "launch-page-23456789ab.openbot.site" : null,
    url: hasPublishedSite ? "https://launch-page-23456789ab.openbot.site" : null,
    timestamp,
  };
}

function agent(id: string, name: string): AgentProfile {
  return {
    id,
    name,
    title: name,
    description: "",
    notifications: true,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
    time: "",
    preview: "",
  };
}

export const MessageDates: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Daily routine history
      </Heading>
      {[1, 0].map((daysAgo) => {
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        return (
          <ChatActionMarker
            marker={{ ...routineMarker("succeeded"), timestamp: date.toISOString() }}
            agents={agents}
            onSelectAgent={onSelectAgent}
            onOpenRoutine={onOpenRoutine}
          />
        );
      })}
    </main>
  ),
};

function SkillMarkers() {
  const [selected, setSelected] = createSignal<{ skillId: string } | null>(null);
  return (
    <>
      {(["created", "revised", "installed"] as const).map((action) => (
        <ChatActionMarker
          marker={{
            kind: "skill-lifecycle",
            action,
            skillId: "skill-release-notes",
            revision: 2,
            skillName: "Release notes",
            timestamp: "2026-09-13T12:00:00Z",
          }}
          agents={agents}
          onSelectAgent={onSelectAgent}
          onOpenSkill={setSelected}
        />
      ))}
      <AgentSkillsModal
        open={Boolean(selected())}
        selectionRequest={selected()}
        agentId="chief"
        agentName="Chief"
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        onCountChange={() => {}}
      />
    </>
  );
}
