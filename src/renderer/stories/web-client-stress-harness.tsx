/*
 * The web client on a large mock host, for `scripts/web-perf-stress-e2e.ts`: the workspace seeds plus
 * `?channels=<n>` more channels (default 150) of 40 messages each, one of them (#big) with
 * `?history=<n>` messages (default 3,000), and `?agents=<n>` more agents (default 40). The script
 * drives it through `globalThis.openbotStress`:
 * - `stream(channelId, flushes, gapMs)` streams an agent reply into a channel as the host does: each
 *   flush sends the growing message (`channel-message`) and then `channels-changed`.
 * - `drop(holdMs)` reports the host offline and holds the next connect for `holdMs`.
 * - `?latency=<ms>` delays each host call, as a phone's link does.
 * - `calls` counts every call of the runtime and its channel port, by name; `resetCalls()` clears it.
 */
import type { ChannelMessage, ClientAgentSummary } from "@openbot/contracts/ipc";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import type { WebWorkspaceRuntime } from "../src/features/web-client/web-runtime";
import { StaticI18nProvider } from "../src/i18n-context";
import { STORY_AGENT_SUMMARIES } from "../src/preview/fixtures";
import type { MockChannelSeed } from "../src/preview/mock-channels";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

function numberParam(name: string, fallback: number): number {
  const value = Number(new URLSearchParams(location.search).get(name));
  return Number.isInteger(value) && value >= 0 && new URLSearchParams(location.search).has(name) ? value : fallback;
}
const CHANNELS = numberParam("channels", 150);
const HISTORY = numberParam("history", 3_000);
const AGENTS = numberParam("agents", 40);
/** `?latency=<ms>`: each call of the host waits this long first, as a read over a phone's link does. */
const LATENCY = numberParam("latency", 0);
const START = Date.parse("2026-11-01T08:00:00Z");

declare global {
  interface Window {
    openbotStress?: {
      stream(channelId: string, flushes: number, gapMs: number): Promise<void>;
      drop(holdMs: number): void;
      calls: Record<string, number>;
      resetCalls(): void;
    };
  }
}

const you = { kind: "member" as const, id: WEB_PREVIEW_MEMBER_ID, name: "You" };
const chief = { kind: "agent" as const, id: "chief", name: "Chief" };

function history(channelId: string, count: number): MockChannelSeed["messages"] {
  return Array.from({ length: count }, (_, index): ChannelMessage => {
    const author = index % 2 === 0 ? chief : you;
    return {
      id: `${channelId}-s${index}`,
      channelId,
      sequence: index + 1,
      author,
      taskId: null,
      superseded: false,
      message: {
        id: `${channelId}-sc${index}`,
        author: author.kind === "member" ? "user" : "assistant",
        text: `Message ${index} in ${channelId}: the numbers for week ${index % 52} are in the sheet.`,
        createdAt: new Date(START + index * 13 * 60_000).toISOString(),
        status: "completed",
      },
    };
  });
}

function extraChannels(base: MockChannelSeed): MockChannelSeed[] {
  return Array.from({ length: CHANNELS }, (_, index) => {
    const id = index === 0 ? "big" : `load-${index}`;
    const count = index === 0 ? HISTORY : 40;
    return {
      channel: { ...base.channel, id, name: id, topic: `Load channel ${index}`, description: "", revision: 1 },
      messages: history(id, count),
      readThrough: count - (index % 3),
    };
  });
}

function extraAgents(): ClientAgentSummary[] {
  const template = STORY_AGENT_SUMMARIES[0];
  if (!template) return [];
  return Array.from({ length: AGENTS }, (_, index) => ({
    ...structuredClone(template),
    id: `load-agent-${index}`,
    name: `Load agent ${index}`,
    title: `Worker ${index}`,
  }));
}

/** Counts each call of the object's functions under `prefix.name`. */
function counted<T extends object>(target: T, prefix: string, calls: Record<string, number>): T {
  const wrapped = { ...target };
  for (const [key, value] of Object.entries(target)) {
    if (typeof value !== "function") continue;
    Object.assign(wrapped, {
      [key]: (...args: unknown[]) => {
        calls[`${prefix}${key}`] = (calls[`${prefix}${key}`] ?? 0) + 1;
        if (!LATENCY) return value.apply(target, args);
        return new Promise((done) => setTimeout(done, LATENCY)).then(() => value.apply(target, args));
      },
    });
  }
  return wrapped;
}

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const base = seeds(WEB_PREVIEW_MEMBER_ID, { unread: true });
  const general = base[0];
  if (!general) throw new Error("The workspace seeds have no #general.");
  const mock = createMockOpenBot({
    channels: [...base, ...extraChannels(general)],
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    agents: [...structuredClone(STORY_AGENT_SUMMARIES), ...extraAgents()],
  });
  const web = mockWebRuntimeFor(mock, events);
  const calls: Record<string, number> = {};
  let hold = 0;
  let revision = 1_000;

  async function stream(channelId: string, flushes: number, gapMs: number): Promise<void> {
    const id = `stream-${channelId}-${Date.now()}`;
    let text = "";
    for (let index = 0; index < flushes; index++) {
      text += `word${index} `;
      revision += 1;
      mock.emitAgentEvent({
        type: "channel-message",
        channelId,
        revision,
        message: {
          id,
          channelId,
          sequence: 100_000,
          author: chief,
          taskId: null,
          superseded: false,
          message: {
            id: `${id}-c`,
            author: "assistant",
            text,
            createdAt: new Date().toISOString(),
            status: index === flushes - 1 ? "completed" : "streaming",
          },
        },
      });
      mock.emitAgentEvent({ type: "channels-changed", channelId, revision });
      await new Promise((done) => setTimeout(done, gapMs));
    }
  }

  window.openbotStress = {
    stream,
    drop(holdMs) {
      hold = holdMs;
      events.connection({ hostId: "preview-host", state: "offline", message: null });
    },
    calls,
    resetCalls() {
      for (const key of Object.keys(calls)) delete calls[key];
    },
  };
  const result: WebWorkspaceRuntime = {
    ...web,
    ...(web.channels ? { channels: counted(web.channels, "channels.", calls) } : {}),
    connect: async (host) => {
      const wait = hold;
      hold = 0;
      if (wait) await new Promise((done) => setTimeout(done, wait));
      return web.connect(host);
    },
  };
  return counted(result, "", calls);
};

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
            accountName="Preview User"
            accountFetch={fetch}
            onSessionCheck={async () => {}}
            onLogout={async () => {}}
            createRuntime={runtime}
            language="system"
            onChangeLanguage={() => {}}
            appearance="dark"
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
