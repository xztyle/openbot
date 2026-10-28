import type { Channel, ChannelMessage } from "@openbot/contracts/ipc";
import type { MockChannelSeed } from "../../src/preview/mock-channels";

/** The sample workspace of the workspace stories: #general with a thread, a private channel of 2,000 messages, a DM. */
/** The member id the preview writes as. `seeds` sets it. */
let READER = "local";
const START = Date.parse("2026-10-27T09:00:00Z");

function channel(input: Partial<Channel> & Pick<Channel, "id" | "name">): Channel {
  return {
    title: "",
    instructions: "",
    members: [],
    leadAgentId: null,
    archived: false,
    revision: 1,
    createdAt: new Date(START - 86_400_000 * 3).toISOString(),
    kind: "channel",
    visibility: "public",
    humanMemberIds: [READER],
    createdBy: { kind: "member", id: READER },
    ...input,
  };
}

const sequences = new Map<string, number>();
let serial = 0;
function message(
  channelId: string,
  minutes: number,
  author: { kind: "member" | "agent"; id: string; name: string },
  text: string,
  extra: Partial<ChannelMessage> & { itemType?: string; turnId?: string } = {},
): ChannelMessage {
  const sequence = (sequences.get(channelId) ?? 0) + 1;
  sequences.set(channelId, sequence);
  serial += 1;
  const { itemType, turnId, ...rest } = extra;
  return {
    id: `${channelId}-m${serial}`,
    channelId,
    sequence,
    author,
    taskId: null,
    superseded: false,
    message: {
      id: `${channelId}-c${serial}`,
      author: author.kind === "member" ? "user" : "assistant",
      text,
      createdAt: new Date(START + minutes * 60_000).toISOString(),
      status: "completed",
      ...(itemType ? { itemType } : {}),
      ...(turnId ? { turnId } : {}),
    },
    ...rest,
  };
}

const ana = { kind: "member" as const, id: "ana", name: "Ana" };
const chief = { kind: "agent" as const, id: "chief", name: "Chief" };
const research = { kind: "agent" as const, id: "research", name: "Research" };

/** `reader` is the member id the preview writes as: `local` on the desktop, `preview` on the web. */
export function seeds(reader = "local"): MockChannelSeed[] {
  READER = reader;
  const you = { kind: "member" as const, id: READER, name: "You" };
  sequences.clear();
  serial = 0;
  const general = channel({
    id: "general",
    name: "general",
    topic: "Launch week: cakemaker v2 ships Friday",
    description: "Everything about the cakemaker launch.",
    members: [
      { agentId: "chief", answerMode: "always" },
      { agentId: "research", answerMode: "mention", focus: "market research" },
    ],
    humanMemberIds: [READER, "ana"],
  });
  const rootId = "general-root";
  const messages: ChannelMessage[] = [
    message("general", 0, ana, "Morning! Who looks at the pricing page today?"),
    message("general", 2, you, "I will. @[Chief](agent:chief) can you draft the launch checklist?"),
    message("general", 3, chief, "Reading the launch notes and the open issues.", {
      itemType: "commentary",
      turnId: "t1",
    }),
    message("general", 4, chief, "Checking the release branch for blockers.", { itemType: "commentary", turnId: "t1" }),
    message(
      "general",
      5,
      chief,
      "Here is the **launch checklist**:\n\n1. Freeze the release branch\n2. Run the bench\n3. Publish the site\n\nThe preview is live at https://cakemaker-web.delynith.com",
      {
        turnId: "t1",
        reactions: [
          {
            emoji: "🎉",
            actors: [
              { kind: "member", id: "ana" },
              { kind: "member", id: READER },
            ],
          },
        ],
      },
    ),
    {
      ...message("general", 40, ana, "Can @[Research](agent:research) compare our prices with the two main rivals?"),
      id: rootId,
      threadSummary: {
        replyCount: 2,
        lastReplyAt: new Date(START + 55 * 60_000).toISOString(),
        participantIds: ["research", READER],
      },
    },
    message("general", 41, you, "@channel standup in 5 minutes", { mentions: [{ kind: "channel" }] }),
    message("general", 60 * 26, ana, "Thanks all, the site looks great 🚀"),
  ];
  const replies: ChannelMessage[] = [
    message("general", 50, research, "Started: I compare the plans of both rivals.", { threadRootId: rootId }),
    message("general", 55, you, "Great, add the yearly prices too.", { threadRootId: rootId }),
  ];
  const cakemaker = channel({
    id: "cakemaker",
    name: "cakemaker",
    visibility: "private",
    members: [{ agentId: "chief", answerMode: "mention" }],
  });
  const many: ChannelMessage[] = Array.from({ length: 2_000 }, (_, index) =>
    message(
      "cakemaker",
      index * 3,
      index % 3 === 0 ? chief : index % 3 === 1 ? ana : you,
      `Build log line ${index + 1}`,
    ),
  );
  const dm = channel({
    id: "dm-ana",
    name: "dm-ana",
    kind: "dm",
    visibility: "private",
    humanMemberIds: [READER, "ana"],
  });
  return [
    { channel: general, messages: [...messages, ...replies] },
    { channel: cakemaker, messages: many },
    { channel: channel({ id: "random", name: "random", humanMemberIds: ["ana"] }), messages: [] },
    { channel: dm, messages: [message("dm-ana", 70, ana, "Lunch at 12?")] },
  ];
}
