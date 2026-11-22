/*
 * The web client on a mock host for `scripts/web-visual-sweep-e2e.ts`: the unread and working seeds,
 * two loop decisions and an attention list, as `web-client-today-harness.tsx` has them, in the look
 * that browser storage names before the page starts:
 * - `visual.theme`: craft, modern or riso;
 * - `visual.appearance`: light, dark or system;
 * - `visual.long`: "1" gives an agent, a channel and a message names and numbers far longer than usual;
 * - `visual.empty`: "1" gives a workspace without channels.
 */
import type { AppAppearance } from "@openbot/contracts/app-appearance";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { syncColorScheme } from "../src/color-scheme";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { StaticI18nProvider } from "../src/i18n-context";
import { STORY_AGENT_SUMMARIES } from "../src/preview/fixtures";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const THEME = (["craft", "modern", "riso"] as const).find((theme) => theme === stored("visual.theme")) ?? "craft";
const APPEARANCE: AppAppearance =
  (["light", "dark", "system"] as const).find((value) => value === stored("visual.appearance")) ?? "light";
const LONG = stored("visual.long") === "1";
const EMPTY = stored("visual.empty") === "1";
const NOW = Date.now();
const LONG_NAME = "Quarterly International Marketing Operations Coordinator";
const LONG_WORD = "https://example.com/a/very/long/link/without/any/break/".repeat(3);

function channelSeeds() {
  const list = seeds(WEB_PREVIEW_MEMBER_ID, { unread: true, working: true });
  if (!LONG) return list;
  return list.map((seed) => {
    if (seed.channel.id !== "general") return seed;
    const last = seed.messages.at(-1);
    const messages = last
      ? [
          ...seed.messages,
          {
            ...last,
            id: "general-long",
            sequence: last.sequence + 1,
            message: {
              ...last.message,
              id: "general-long-c",
              text: `Revenue so far: $1,234,567,890.12 across 98,765 orders. ${LONG_WORD}`,
            },
          },
        ]
      : seed.messages;
    return {
      ...seed,
      channel: {
        ...seed.channel,
        topic: `${seed.channel.topic ?? ""} — and everything else that the whole team needs to read before Friday`,
      },
      messages,
    };
  });
}

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    workspaceAppearance: { theme: THEME, faces: "portrait", skin: "1" },
    ...(LONG
      ? { agents: STORY_AGENT_SUMMARIES.map((agent) => (agent.id === "sales" ? { ...agent, name: LONG_NAME } : agent)) }
      : {}),
    ...(EMPTY ? { setupState: { completed: false, preferredProvider: null, preferredModel: null } } : {}),
    channels: EMPTY ? [] : channelSeeds(),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    loopDecisions: EMPTY
      ? []
      : [
          {
            id: "decision-ads",
            spaceId: "trading",
            loopId: "loop-ads",
            itemId: "item-ads",
            kind: "money",
            subject: "experiment",
            title: LONG ? `Run the spring ad test for ${LONG_NAME} in every market` : "Run the spring ad test",
            detail: "Two ad sets for the course, 5 days.",
            amountUsd: LONG ? 1_234_567 : 40,
            requestedBy: "research",
            status: "pending",
            createdAt: NOW - 3_600_000,
          },
          {
            id: "decision-question",
            spaceId: "trading",
            loopId: "loop-ads",
            itemId: "item-hook",
            kind: "decision",
            subject: "question",
            title: "Which hook do we open the video with?",
            requestedBy: "research",
            status: "pending",
            createdAt: NOW - 7_200_000,
          },
        ],
    spaces: [
      {
        space: {
          id: "trading",
          name: LONG ? "Trading and Market Research Worldwide" : "Trading",
          slug: "market-trading",
          icon: null,
          hue: 215,
        },
        agentIds: ["research"],
        channelIds: ["cakemaker"],
      },
      { space: { id: "piks", name: "Piks", icon: null, hue: 150 } },
    ],
  });
  for (const item of [
    { messageId: "general-root", state: "saved" },
    { messageId: "general-m5", state: "done" },
  ] as const)
    void mock.api.agent.workspaceSetSaved?.({ operationId: crypto.randomUUID(), channelId: "general", ...item });
  if (!EMPTY)
    setTimeout(
      () =>
        mock.emitAgentEvent({
          type: "agent-attention-changed",
          items: [
            {
              kind: "approval",
              requestId: "approval-pay",
              agentId: "chief",
              threadId: "thread-chief",
              turnId: "turn-chief",
              createdAt: new Date(NOW - 600_000).toISOString(),
              summary: "Pay $19 for the domain atelier-course.com",
            },
            {
              kind: "browser-takeover",
              requestId: "takeover-google",
              agentId: "sales",
              threadId: "thread-sales",
              turnId: "turn-sales",
              createdAt: new Date(NOW - 1_800_000).toISOString(),
              summary: "Create a Google Account",
              origin: "accounts.google.com",
            },
          ],
        }),
      800,
    );
  return mockWebRuntimeFor(mock, events);
};

syncColorScheme(() => APPEARANCE);
const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <div class="web-app">
          <Toaster />
          <WebWorkspace
            accountId="preview-account"
            accountEmail="you@example.com"
            accountName={LONG ? `Alexandra ${LONG_NAME}` : "Preview User"}
            accountFetch={fetch}
            onSessionCheck={async () => {}}
            onLogout={async () => {}}
            createRuntime={runtime}
            language="system"
            onChangeLanguage={() => {}}
            appearance={APPEARANCE}
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
