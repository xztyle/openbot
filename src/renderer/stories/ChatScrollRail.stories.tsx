import { Bubble, BubbleContent, Message, MessageContent } from "@openbot/ui";
import {
  ChatScrollRail,
  createChatScrollRail,
  type UnloadedHistory,
} from "@openbot/ui/features/conversation/ChatScrollRail";
import { dayMarkerLabel } from "@openbot/ui/features/conversation/chat-day-markers";
import { createChatFlow } from "@openbot/ui/features/conversation/createChatFlow";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

interface StoryRow {
  id: string;
  own: boolean;
  text: string;
  createdAt: string;
}

// The rail labels its days against the real clock, so the fixture days end today.
const NOW = new Date();
NOW.setHours(16, 0, 0, 0);

const TOPICS = [
  "the release checklist and who signs off on each step",
  "why the migration test failed on the older schema fixture",
  "the pricing page copy and the annual plan discount",
  "a flaky upload test that waits on elapsed time",
  "how the team channel routes a task to the lead agent",
  "the onboarding flow for a second provider account",
];

/** Messages over several days, with a message from the reader on every third row, so the segments differ. */
function storyRows(days: number[], start = 0): StoryRow[] {
  const rows: StoryRow[] = [];
  days.forEach((count, dayIndex) => {
    const day = new Date(NOW);
    day.setDate(NOW.getDate() - (days.length - 1 - dayIndex));
    for (let index = 0; index < count; index += 1) {
      const at = new Date(day);
      at.setHours(9, index * 4, 0, 0);
      const own = index % 3 === 0;
      const topic = TOPICS[dayIndex % TOPICS.length];
      rows.push({
        id: `rail-${start + rows.length}`,
        own,
        text: own
          ? `Can you look at ${topic}?`
          : `I checked ${topic}. Here is what I found in step ${index + 1}, and what I would change next.`,
        createdAt: at.toISOString(),
      });
    }
  });
  return rows;
}

/** A transcript with the same scroll container, flow of rows and section rule as the chats. */
function RailTranscript(props: { rows: StoryRow[]; unloaded?: UnloadedHistory }) {
  const { t, format } = useText();
  const flow = createChatFlow({ following: () => false });
  const rail = createChatScrollRail({
    rows: () => props.rows,
    question: (row) => (row.own ? row.text : undefined),
    unloaded: () => props.unloaded,
    flow,
    onLoadOlder: () => {},
    onJump: () => {},
  });

  return (
    <div style={{ display: "flex", height: "100vh", "flex-direction": "column" }}>
      <div
        ref={(element) => {
          flow.setScrollElement(element);
          rail.ref(element);
          requestAnimationFrame(() => {
            element.scrollTop = element.scrollHeight;
          });
        }}
        class="conversation-scroll"
        role="log"
      >
        <ChatScrollRail {...rail.props} />
        <div ref={(element) => flow.setListElement(element)} class="virtual-chat-list">
          <For each={props.rows}>
            {(item, index) => {
              const row = () => item;
              const marker = () => {
                const current = row();
                if (!current) return null;
                return dayMarkerLabel(props.rows[index() - 1]?.createdAt, current.createdAt, {
                  now: NOW,
                  t,
                  format,
                });
              };
              return (
                <div data-index={index()} data-row-key={item.id} class="virtual-chat-row chat-flow-row">
                  <Show when={marker()}>
                    {(label) => (
                      <div class="time-marker">
                        <span>{label()}</span>
                      </div>
                    )}
                  </Show>
                  <Message align={row()?.own ? "end" : "start"}>
                    <MessageContent>
                      <Bubble align={row()?.own ? "end" : "start"} variant={row()?.own ? "secondary" : "muted"}>
                        <BubbleContent>{row()?.text}</BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Conversation/Chat scroll rail",
  component: RailTranscript,
  args: { rows: storyRows([18, 40, 12, 30, 26, 24]) },
} satisfies Meta<typeof RailTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 150 messages over six days, 52 of them from the reader: the list is virtualized, so most have no rendered row. */
export const SeveralDays: Story = {};

/** Fewer than 100 messages: every row renders. */
export const ShortHistory: Story = {
  args: { rows: storyRows([10, 22, 16]) },
};

/**
 * Two days are loaded and 600 older messages are not, back to five days ago: the top segment stands
 * for them at the loaded rows' height, so the rail shows the whole chat.
 */
export const OlderHistoryNotLoaded: Story = {
  args: {
    rows: storyRows([30, 30]),
    unloaded: { count: 600, oldestAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString() },
  },
};

/** More messages from the reader than the rail holds, so its list scrolls and keeps the current one in view. */
export const ManyMessages: Story = {
  args: { rows: storyRows(Array.from({ length: 40 }, (_, index) => 2 + (index % 4))) },
};

/** One message from the reader and a long reply: no rail, because there is no other place to go to. */
export const OneMessage: Story = {
  args: { rows: storyRows([1]).concat(storyRows([30], 1).filter((row) => !row.own)) },
};
