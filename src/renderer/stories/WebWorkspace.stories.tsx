import type { AgentProviderStatus, AgentStatus } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { PROVIDERS_ADMIN_ROUTES } from "@openbot/contracts/team-protocol/providers-v1";
import { PROVIDERS_RUNTIMES_V2_ROUTES } from "@openbot/contracts/team-protocol/providers-v2";
import { PROVIDERS_SIGN_IN_V3_ROUTES } from "@openbot/contracts/team-protocol/providers-v3";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { Toaster } from "@openbot/ui";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { WebHostIncompatibleError } from "../src/features/web-client/web-runtime";
import { createBenchWebRuntime } from "../src/preview/bench-web-runtime";
import { MOCK_HOSTED_SERVER_CATALOG } from "../src/preview/mock-hosted-servers";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { createMockWebRuntime, mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { MEDIA_FILES, seeds } from "./workspace/workspace-app-seeds";
import "../src/features/web-client/web-client.css";

const meta = {
  title: "Web/Workspace",
  component: WebWorkspace,
  parameters: { layout: "fullscreen" },
  args: {
    accountId: "preview-account",
    accountEmail: "you@example.com",
    accountName: "Preview User",
    accountFetch: fetch,
    onSessionCheck: async () => {},
    onLogout: async () => {},
    createRuntime: createMockWebRuntime,
    language: "system",
    onChangeLanguage: () => {},
  },
  render: (args) => (
    <div class="web-app">
      <Toaster />
      <WebWorkspace {...args} />
    </div>
  ),
} satisfies Meta<typeof WebWorkspace>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {};

/** The Slack-style workspace with channels, a thread, a DM and a channel of 2,000 messages. */
const slackRuntime: WebRuntimeFactory = (_accountId, events) =>
  mockWebRuntimeFor(
    createMockOpenBot({ channels: seeds(WEB_PREVIEW_MEMBER_ID), channelMemberId: WEB_PREVIEW_MEMBER_ID }),
    events,
  );

export const SlackWorkspace: Story = { args: { createRuntime: slackRuntime } };

/**
 * Agents at work: Chief in #general and Research in the pricing thread, each with Stop. Research
 * posts a progress reply every 2 s, so the thread shows how it keeps the reader's place.
 */
const agentWorkingRuntime: WebRuntimeFactory = (_accountId, events) =>
  mockWebRuntimeFor(
    createMockOpenBot({
      channels: seeds(WEB_PREVIEW_MEMBER_ID, { working: true }),
      channelMemberId: WEB_PREVIEW_MEMBER_ID,
    }),
    events,
  );

export const AgentWorking: Story = { args: { createRuntime: agentWorkingRuntime } };

/** The workspace with spaces: Trading holds Research and #cakemaker. Check it at phone width too. */
const spacesRuntime: WebRuntimeFactory = (_accountId, events) =>
  mockWebRuntimeFor(
    createMockOpenBot({
      channels: seeds(WEB_PREVIEW_MEMBER_ID),
      channelMemberId: WEB_PREVIEW_MEMBER_ID,
      spaces: [
        {
          space: { id: "trading", name: "Trading", icon: "📈", hue: 215 },
          agentIds: ["research"],
          channelIds: ["cakemaker"],
        },
        { space: { id: "piks", name: "Piks", icon: null, hue: 150 } },
      ],
    }),
    events,
  );

export const SpacesWorkspace: Story = { args: { createRuntime: spacesRuntime } };

/** An image of `width` by `height`: a gradient with a caption, as an ad mockup or a screenshot. */
async function drawImage(width: number, height: number, hue: number, caption: string, type: string) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No canvas.");
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${hue} 70% 62%)`);
  gradient.addColorStop(1, `hsl(${hue + 40} 60% 30%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgb(255 255 255 / 0.9)";
  context.fillRect(width * 0.08, height * 0.72, width * 0.84, height * 0.18);
  context.fillStyle = "#222";
  context.font = `600 ${Math.round(width / 18)}px sans-serif`;
  context.fillText(caption, width * 0.12, height * 0.83);
  const blob = await canvas.convertToBlob({ type, quality: 0.85 });
  return new Uint8Array(await blob.arrayBuffer());
}

/** A one-page PDF with one line of text. */
const SAMPLE_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 66>>stream
BT /F1 28 Tf 72 760 Td (Brief de campana: Cena Navidena) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** The bytes the host would send for a file of the media seeds, after the delay of a slow connection. */
async function mediaFile(id: string, variant: "inline" | "full") {
  await new Promise((resolve) => setTimeout(resolve, variant === "inline" ? 900 : 1_600));
  const inline = variant === "inline";
  if (id === MEDIA_FILES.a1.id)
    return {
      name: MEDIA_FILES.a1.name,
      mimeType: "image/webp",
      base64: base64(await drawImage(1080, 1080, 24, "Pavo al horno", "image/webp")),
    };
  if (id === MEDIA_FILES.a3.id)
    return {
      name: MEDIA_FILES.a3.name,
      mimeType: "image/png",
      base64: base64(await drawImage(1080, 1350, 200, "¿Qué cubre?", "image/png")),
    };
  if (id === MEDIA_FILES.phone.id)
    return inline
      ? {
          name: "preview.jpg",
          mimeType: "image/jpeg",
          base64: base64(await drawImage(473, 1024, 280, "Landing", "image/jpeg")),
        }
      : {
          name: MEDIA_FILES.phone.name,
          mimeType: "image/png",
          base64: base64(await drawImage(1170, 2532, 280, "Landing", "image/png")),
        };
  if (id === MEDIA_FILES.brief.id)
    return { name: MEDIA_FILES.brief.name, mimeType: "application/pdf", base64: btoa(SAMPLE_PDF) };
  return {
    name: MEDIA_FILES.budget.name,
    mimeType: "text/csv",
    base64: btoa("partida,importe\nanuncio A1,49\nanuncio A3,49\ntotal,98\n"),
  };
}

/** #general with images and files, read through the host connection as the browser client reads them. */
const mediaRuntime: WebRuntimeFactory = (_accountId, events) => ({
  ...mockWebRuntimeFor(
    createMockOpenBot({
      channels: seeds(WEB_PREVIEW_MEMBER_ID, { media: true }),
      channelMemberId: WEB_PREVIEW_MEMBER_ID,
    }),
    events,
  ),
  download: (id) => mediaFile(id, "full"),
  attachmentPreview: (id) => mediaFile(id, "inline"),
});

/** Images show inline, in a grid, and open in the viewer; a PDF and a CSV open in the file viewer. */
export const ChannelMedia: Story = { args: { createRuntime: mediaRuntime } };

export const ChannelMediaPhone: Story = {
  args: { createRuntime: mediaRuntime },
  globals: { viewport: { value: "mobile2", isRotated: false } },
};

/** The spaces workspace on a phone, as Slack's app: bottom tabs, Home with shortcuts, DMs, Activity and More. */
export const PhoneShell: Story = {
  args: { createRuntime: spacesRuntime },
  globals: { viewport: { value: "mobile2", isRotated: false } },
};

/** A long conversation. `bun run perf:web` streams replies into it and counts the host requests. */
export const LongConversation: Story = {
  args: { createRuntime: createBenchWebRuntime },
};

const noHostRuntime: WebRuntimeFactory = (...args) => ({
  ...createMockWebRuntime(...args),
  listHosts: async () => [],
});

const failedHostsRuntime: WebRuntimeFactory = (...args) => ({
  ...createMockWebRuntime(...args),
  listHosts: async () => {
    throw new Error("Host directory unavailable.");
  },
});

const disconnectedRuntime: WebRuntimeFactory = (...args) => ({
  ...createMockWebRuntime(...args),
  connect: async () => {
    throw new Error("The browser connection is closed.");
  },
});

const incompatibleRuntime: WebRuntimeFactory = (...args) => ({
  ...createMockWebRuntime(...args),
  connect: async () => {
    throw new WebHostIncompatibleError(
      { appVersion: "0.40.0", protocol: { minimum: 1, maximum: 2 }, capabilities: [] },
      "host_update_required",
    );
  },
});

export const NoHost: Story = {
  args: { accountEmail: "you@example.com", createRuntime: noHostRuntime },
};

export const HostsFailed: Story = {
  args: { accountEmail: "you@example.com", createRuntime: failedHostsRuntime },
};

export const Disconnected: Story = {
  args: { accountEmail: "you@example.com", createRuntime: disconnectedRuntime },
};

export const Incompatible: Story = {
  args: { accountEmail: "you@example.com", createRuntime: incompatibleRuntime },
};

const NEW_SERVER_ID = "cloud-server";

/**
 * A server the user just bought or set up, next to the preview computer: no agents, and no provider
 * signed in on the host. The host serves the provider routes, so an owner sees the provider step
 * before the agent form. Claude signs in with a pasted code; any code connects it.
 */
const newServerRuntime: WebRuntimeFactory = (accountId, events, accountFetch) => {
  const base = createMockWebRuntime(accountId, events, accountFetch);
  const team = createMockOpenBot();
  let status: AgentStatus = {
    phase: "blocked",
    cliVersion: null,
    auth: { kind: "unknown" },
    providers: [
      { id: "codex", state: "sign-in-required", version: "0.149.1", message: null },
      { id: "claude", state: "sign-in-required", version: "2.1.263", message: null },
      { id: "grok", state: "sign-in-required", version: "1.0.22", message: null },
    ],
    capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
    message: null,
    fullAccess: true,
  };
  const setClaude = (row: AgentProviderStatus) => {
    status = {
      ...status,
      providers: (status.providers ?? []).map((current) => (current.id === "claude" ? row : current)),
    };
  };
  const ready = (version: string) => ({ phase: "ready", progress: 100, message: null, version });
  const none = { phase: "not-downloaded", progress: null, message: null, version: null };
  const answers: Record<string, (body: unknown) => unknown> = {
    [PROVIDERS_RUNTIMES_V2_ROUTES.runtimesStatus]: () => ({
      revision: 1,
      providers: {
        codex: ready("0.149.1"),
        claude: ready("2.1.263"),
        grok: ready("1.0.22"),
        opencode: none,
        antigravity: none,
      },
      toolRuntimes: { bun: none },
    }),
    [PROVIDERS_ADMIN_ROUTES.customList]: () => [],
    [PROVIDERS_ADMIN_ROUTES.apiKeyState]: () => ({ status: "missing" }),
    [PROVIDERS_SIGN_IN_V3_ROUTES.codeLoginStart]: () => ({
      kind: "paste",
      verificationUrl: "https://claude.com/cai/oauth/authorize?code=true",
      expiresAt: Date.now() + 600_000,
    }),
    // The host checks the code for a moment, then Claude is signed in.
    [PROVIDERS_SIGN_IN_V3_ROUTES.codeLoginSubmit]: () => {
      const claude = { id: "claude", version: "2.1.263", message: null } as const;
      setClaude({ ...claude, state: "sign-in-required", connectionState: "connecting" });
      window.setTimeout(() => {
        status = { ...status, phase: "ready" };
        setClaude({ ...claude, state: "available", email: "you@example.com" });
        events.event(NEW_SERVER_ID, { type: "status", status });
      }, 1500);
      return {};
    },
    [PROVIDERS_SIGN_IN_V3_ROUTES.codeLoginCancel]: () => ({}),
    [TEAM_API_ROUTES.agents.status]: () => status,
  };
  const request: TeamApiRequest = async (_method, path, decode, body) => {
    const answer = answers[path];
    if (!answer) throw new Error(`No preview answer for ${path}.`);
    return decode(answer(body));
  };
  let connected = NEW_SERVER_ID;
  const onNewServer = () => connected === NEW_SERVER_ID;
  return {
    ...base,
    listHosts: async () => {
      const [computer] = await base.listHosts();
      return computer ? [{ ...computer, hostId: NEW_SERVER_ID, name: "Cloud server" }, computer] : [];
    },
    connect: async (host) => {
      connected = host.hostId;
      const capabilities = await base.connect(host);
      events.connection({ hostId: host.hostId, state: "online", message: null });
      return onNewServer() ? [...capabilities, "providers-v1", "providers-v2", "providers-v3"] : capabilities;
    },
    listAgents: async () => (onNewServer() ? [] : base.listAgents()),
    status: async () => (onNewServer() ? status : base.status()),
    admin: { request, team: team.api.host },
    dispose: async () => {
      team.dispose();
      await base.dispose();
    },
  };
};

export const NewServer: Story = {
  args: { createRuntime: newServerRuntime },
};

/** The account server's hosted server list, with the server that Checkout paid for already running. */
const checkoutFetch: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = url.endsWith("/hosting/plans")
    ? MOCK_HOSTED_SERVER_CATALOG
    : url.endsWith("/hosting/servers")
      ? {
          available: true,
          servers: [
            {
              serverId: NEW_SERVER_ID,
              name: "Cloud server",
              size: "default",
              plan: "standard",
              interval: "month",
              currency: "eur",
              state: "running",
              error: null,
              createdAt: "2026-09-29T09:30:00.000Z",
              updatedAt: "2026-09-29T09:34:00.000Z",
            },
          ],
        }
      : null;
  return body ? Response.json(body) : fetch(input);
};

/** The return from Stripe Checkout: the add server dialog opens on the new server's setup. */
export const CheckoutReturn: Story = {
  args: {
    createRuntime: newServerRuntime,
    accountFetch: checkoutFetch,
    hostingReturn: { serverId: NEW_SERVER_ID, paid: true },
  },
};

/** A hosted server that stopped because nobody used it. A key press or a click wakes it. */
const sleepingRuntime: WebRuntimeFactory = (...args) => ({
  ...createMockWebRuntime(...args),
  connect: async () => {
    throw new Error("The host is not available.");
  },
});

const sleepingFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/preview-host/status"))
    return Response.json({ serverId: "preview-host", state: "stopped", error: null, sleeping: true });
  if (url.endsWith("/preview-host/wake"))
    return Response.json({
      serverId: "preview-host",
      name: "Preview computer",
      size: "small",
      plan: "starter",
      interval: "month",
      currency: "eur",
      state: "waking",
      error: null,
      createdAt: "2026-09-29T09:30:00.000Z",
      updatedAt: "2026-09-29T09:34:00.000Z",
    });
  return fetch(input, init);
};

export const HostedServerAsleep: Story = {
  args: { createRuntime: sleepingRuntime, accountFetch: sleepingFetch },
};
