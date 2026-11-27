/*
 * Billing, the connectors and the MCP connect dialogs on fake data, for
 * `scripts/trust-billing-settings-e2e.ts`. `?surface=` picks one:
 *
 * - `billing`: Settings > Billing on a computer: the license, the server plans and the hosted servers.
 * - `billing-dialog`: the same panel in the web client's dialog.
 * - `connectors`: Server settings > Connectors, with GitHub connected and Bitwarden not set up.
 * - `github-connect`: the GitHub connect dialog with the code to type.
 * - `bitwarden-host`: Bitwarden of a joined server, which asks for an API key.
 * - `mcp-key`, `mcp-local`, `mcp-sign-in`: the connect dialogs of an app from the marketplace.
 * - `chat-apps`: which apps an agent in a chat may read or write.
 * - `slack-connect`, `discord-connect`, `telegram-connect`: the connect dialog of a chat app; `&step=2`
 *   shows the step that adds the orchestrator.
 * - `marketplace-remove`: the dialog that removes an app the user added from the marketplace.
 *
 * `?theme=light` shows the light theme; the text is Spanish unless `?lang=en`. The calls the page
 * makes land in `document.body.dataset.harnessCalls`, one per line.
 */
import type { GitHubConnectorStatus, MessagingConnection } from "@openbot/contracts/ipc";
import type { McpKeyFlow, McpLocalFlow } from "@openbot/contracts/mcp-connect-flows";
import type { McpChatGrant, McpChatSnapshot } from "@openbot/contracts/team-protocol/mcp-chat-v1";
import { Button, Plug, Toaster } from "@openbot/ui";
import { BillingDialog } from "@openbot/ui/features/billing/BillingDialog";
import { BillingPanel } from "@openbot/ui/features/billing/BillingPanel";
import { createBillingStore } from "@openbot/ui/features/billing/billing-store";
import { LicenseSection } from "@openbot/ui/features/billing/LicenseSection";
import { createLicenseStore } from "@openbot/ui/features/billing/license-store";
import type { ConnectorDetail } from "@openbot/ui/features/connectors/ConnectorDetailPanel";
import { BitwardenConnectorPanel } from "@openbot/ui/features/settings/BitwardenConnectorPanel";
import { ChatAppsDialog } from "@openbot/ui/features/settings/ChatAppsDialog";
import { GitHubConnectorPanel } from "@openbot/ui/features/settings/GitHubConnectorPanel";
import { WizardDialog } from "@openbot/ui/features/settings/IntegrationLayout";
import { McpKeyDialog } from "@openbot/ui/features/settings/McpKeyDialog";
import { McpLocalDialog } from "@openbot/ui/features/settings/McpLocalDialog";
import { McpSignInDialog } from "@openbot/ui/features/settings/McpSignInDialog";
import { SettingsDialogShell, type SettingsPagePlacement } from "@openbot/ui/features/settings/SettingsDialogShell";
import { SlackConnectDialog } from "@openbot/ui/features/settings/SlackIntegrationPanel";
import { createSettingsHostedServersStore } from "@openbot/ui/features/settings/stores/hosted-servers-store";
import { TelegramConnectDialog } from "@openbot/ui/features/settings/TelegramIntegrationPanel";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { render } from "@solidjs/web";
import { createSignal, createStore, Match, Switch } from "solid-js";
import { ConnectorsPanel } from "../src/features/connectors/ConnectorsPanel";
import type { ConnectorController } from "../src/features/connectors/connector-controller";
import { createConnectorRegistry } from "../src/features/connectors/connector-registry";
import { MARKETPLACE_PLUGINS } from "../src/features/settings/marketplace-plugin-catalog";
import { SettingsPageFrame } from "../src/features/window/SettingsPageFrame";
import { StaticI18nProvider } from "../src/i18n-context";
import { STORY_SERVERS } from "../src/preview/fixtures";
import { createMockBilling, previewBillingServers } from "../src/preview/mock-billing";
import { createMockHostedServers } from "../src/preview/mock-hosted-servers";
import { createMockLicense } from "../src/preview/mock-license";
import { FIGMA, keyFlowFor, subjectFor } from "./mcp-connect-stage";
import "./settings-page-story.css";
import "../src/styles.css";

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "billing";
if (params.get("theme") === "light") document.documentElement.dataset.openbotColorScheme = "light";
else document.documentElement.dataset.openbotColorScheme = "dark";

const calls: string[] = [];
function record(call: string): void {
  calls.push(call);
  document.body.dataset.harnessCalls = calls.join("\n");
}
const noop = (name: string) => () => record(name);

const DAY = 24 * 60 * 60_000;

/** A settings page as the window shows it, with one section's content, open on a phone too. */
function Page(props: { title: string; shell: "app" | "server"; children: JSX.Element }) {
  const [page, setPage] = createSignal<SettingsPagePlacement>();
  return (
    <div class="settings-page-story">
      <SettingsPageFrame
        heading={<h1 class="settings-page-title">{props.title}</h1>}
        section="harness"
        onMounts={setPage}
        onEscape={() => undefined}
      />
      <SettingsDialogShell
        open
        page={page()}
        class={props.shell === "app" ? "app-settings-modal-shell" : "server-settings-modal-shell"}
        title={props.title}
        description=""
        sidebar={null}
        contentKey="harness"
      >
        <div class="settings-modal-tab-panel" data-selected="">
          {props.children}
        </div>
      </SettingsDialogShell>
    </div>
  );
}

function billingStores() {
  const plans = previewBillingServers();
  const billingCalls = createMockBilling(plans);
  const billing = createBillingStore(
    () => ({
      ...billingCalls,
      openPortal: async (request) => {
        record(`portal:${request.flow}`);
        return billingCalls.openPortal(request);
      },
    }),
    () => true,
  );
  const hostedApi = createMockHostedServers(plans);
  const hostedServers = createSettingsHostedServersStore(
    {
      open: true,
      hostedServersApi: {
        ...hostedApi,
        lifecycle: async (input) => {
          record(`lifecycle:${input.action}:${input.timing}`);
          return hostedApi.lifecycle(input);
        },
      },
    },
    () => true,
  );
  const license = createLicenseStore(
    () =>
      createMockLicense({
        license: {
          subscriptionId: "sub_harness_license",
          users: 10,
          currency: "eur",
          amount: 9_000,
          status: "active",
          currentPeriodEnd: Date.now() + 30 * DAY,
          cancelAtPeriodEnd: false,
        },
        used: 4,
      }),
    () => true,
  );
  const licenseSection = () => (
    <LicenseSection store={license} onManagePayment={noop("license:payment")} onContactUs={noop("license:contact")} />
  );
  return { billing, hostedServers, licenseSection };
}

function BillingSettings() {
  const { billing, hostedServers, licenseSection } = billingStores();
  return (
    <Page title="Facturación" shell="app">
      <BillingPanel
        store={billing}
        available
        hostedServers={hostedServers}
        onAddServer={noop("add-server")}
        license={licenseSection()}
      />
    </Page>
  );
}

function BillingWebDialog() {
  const { billing, hostedServers, licenseSection } = billingStores();
  const [open, setOpen] = createSignal(true);
  return (
    <main class="web-app">
      <Button type="button" onClick={() => setOpen(true)}>
        Facturación
      </Button>
      <BillingDialog
        open={open()}
        onOpenChange={setOpen}
        store={billing}
        hostedServers={hostedServers}
        license={licenseSection()}
      />
    </main>
  );
}

const GITHUB_CONNECTED: GitHubConnectorStatus = {
  available: true,
  state: "connected",
  login: "panaderia-luna",
  avatarUrl: null,
  userCode: null,
  verificationUri: null,
  error: null,
};

/** A controller over fixed props. Its actions record the call. */
function controller(detail: ConnectorDetail): ConnectorController {
  return {
    id: detail.id,
    ready: () => true,
    available: () => true,
    busy: () => false,
    detail,
    connect: undefined,
    reload: () => undefined,
    watch: () => () => undefined,
  };
}

function Connectors() {
  const [github, setGithub] = createStore({ status: GITHUB_CONNECTED, busy: false });
  const github_detail: ConnectorDetail = {
    id: "github",
    props: {
      get status() {
        return github.status;
      },
      get busy() {
        return github.busy;
      },
      repositories: {
        repositories: [
          { fullName: "panaderia-luna/tienda-web", private: false },
          { fullName: "panaderia-luna/recetas", private: true },
          { fullName: "panaderia-luna/pedidos", private: true },
        ],
        total: 3,
      },
      repositoriesError: null,
      onConnect: noop("github:connect"),
      onCancel: noop("github:cancel"),
      onDisconnect: () => {
        record("github:disconnect");
        setGithub((draft) => {
          draft.status = { ...GITHUB_CONNECTED, state: "disconnected", login: null };
        });
      },
      onOpenVerification: noop("github:verify"),
      onOpenInstall: noop("github:install"),
    },
  };
  const bitwarden: ConnectorDetail = {
    id: "bitwarden",
    props: {
      status: { connected: false, connecting: false, serverUrl: null, error: null },
      busy: false,
      onConnect: noop("bitwarden:connect"),
      onDisconnect: noop("bitwarden:disconnect"),
    },
  };
  const set = { github: controller(github_detail), bitwarden: controller(bitwarden) };
  const local = STORY_SERVERS.find((server) => server.kind === "local");
  const registry = createConnectorRegistry(() => local, { computer: set, server: set });
  return (
    <Page title="Conectores" shell="server">
      <ConnectorsPanel connectors={registry} />
    </Page>
  );
}

function GitHubConnect() {
  return (
    <Page title="Conectores" shell="server">
      <GitHubConnectorPanel
        status={{
          ...GITHUB_CONNECTED,
          state: "pending",
          login: null,
          userCode: "WDJB-MJHT",
          verificationUri: "https://github.com/login/device",
        }}
        busy={false}
        repositories={null}
        repositoriesError={null}
        onConnect={noop("github:connect")}
        onCancel={noop("github:cancel")}
        onDisconnect={noop("github:disconnect")}
        onOpenVerification={noop("github:verify")}
        onOpenInstall={noop("github:install")}
      />
    </Page>
  );
}

function BitwardenHost() {
  return (
    <Page title="Conectores" shell="server">
      <BitwardenConnectorPanel
        hostName="Oficina"
        status={{ connected: false, connecting: false, serverUrl: null, error: null }}
        busy={false}
        onConnect={noop("bitwarden:connect")}
        onConnectHost={(input) => record(`bitwarden:host:${input.serverUrl}`)}
        onDisconnect={noop("bitwarden:disconnect")}
      />
    </Page>
  );
}

function figmaLocal(): McpLocalFlow {
  const app = MARKETPLACE_PLUGINS.find((plugin) => plugin.slug === "figma")?.apps[0];
  const flow = app?.server.auth?.find((one): one is McpLocalFlow => one.kind === "local");
  if (!flow) throw new Error("The catalog must carry the Figma plugin with a local flow.");
  return flow;
}

function McpDialog(props: { kind: "key" | "local" | "sign-in" }) {
  const [open, setOpen] = createSignal(true);
  const subject = subjectFor(FIGMA);
  const base = {
    get open() {
      return open();
    },
    subject,
    onTest: async (config: { headers: { value: string }[] }) => {
      record(`mcp:test:${config.headers[0]?.value ?? ""}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { toolCount: 0, error: "Figma no aceptó la clave." };
    },
    onConnected: () => {
      record("mcp:connected");
      setOpen(false);
    },
    onCancel: () => {
      record("mcp:cancel");
      setOpen(false);
    },
  };
  const flow: McpKeyFlow = keyFlowFor(FIGMA);
  return (
    <main class="web-app">
      <Button type="button" onClick={() => setOpen(true)}>
        Figma
      </Button>
      <Switch>
        <Match when={props.kind === "key"}>
          <McpKeyDialog {...base} flow={flow} onOpenUrl={(url) => record(`open:${url}`)} />
        </Match>
        <Match when={props.kind === "local"}>
          <McpLocalDialog {...base} flow={figmaLocal()} onOpenUrl={(url) => record(`open:${url}`)} />
        </Match>
        <Match when={props.kind === "sign-in"}>
          <McpSignInDialog {...base} />
        </Match>
      </Switch>
    </main>
  );
}

function ChatApps() {
  const [open, setOpen] = createSignal(true);
  const [snapshot, setSnapshot] = createStore<McpChatSnapshot>({
    grants: [{ connectionId: "figma", mode: "read" }],
    connections: [
      { id: "figma", name: "Figma" },
      { id: "linear", name: "Linear" },
    ],
  });
  const mode = (id: string, value: McpChatGrant["mode"] | "off") => {
    record(`chat:${id}:${value}`);
    setSnapshot((draft) => {
      draft.grants = [
        ...draft.grants.filter((grant) => grant.connectionId !== id),
        ...(value === "off" ? [] : [{ connectionId: id, mode: value }]),
      ];
    });
  };
  return (
    <main class="web-app">
      <Button type="button" onClick={() => setOpen(true)}>
        Apps
      </Button>
      <ChatAppsDialog
        open={open()}
        busy={false}
        loading={false}
        loaded
        error={null}
        snapshot={snapshot}
        onMode={mode}
        onSave={() => {
          record("chat:save");
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </main>
  );
}

/** A chat app connection that is connected and waits for its orchestrator (`&step=2`). */
function messagingConnection(platform: "slack" | "discord" | "telegram"): MessagingConnection {
  return {
    workspaceId: platform === "telegram" ? "-1001234567890" : "T0HARNESS",
    platform,
    enabled: true,
    state: "connected",
    workspaceName: platform === "telegram" ? "Equipo Acme" : "Acme",
    botUserId: "U0HARNESS",
    missingScopes: [],
    retryAt: null,
    credentials: "saved",
    orchestratorAgentId: null,
  };
}

function ChatAppConnect(props: { platform: "slack" | "discord" | "telegram" }) {
  const second = params.get("step") === "2";
  const agents = [{ id: "agent-chief" }];
  const note = (call: string) => {
    document.body.dataset.harnessCalls = `${document.body.dataset.harnessCalls ?? ""}${call}\n`;
  };
  return props.platform === "telegram" ? (
    <TelegramConnectDialog
      open
      connections={second ? [messagingConnection("telegram")] : []}
      agents={agents}
      busy={false}
      onConnectChat={async () => {
        note("telegram-connect");
        return true;
      }}
      onAddOrchestrator={() => note("telegram-orchestrator")}
      onClose={() => note("close")}
    />
  ) : (
    <SlackConnectDialog
      platform={props.platform}
      open
      connection={second ? messagingConnection(props.platform) : null}
      agents={agents}
      busy={false}
      onConnectWorkspace={() => note(`${props.platform}-connect`)}
      onAddOrchestrator={() => note(`${props.platform}-orchestrator`)}
      onClose={() => note("close")}
    />
  );
}

/** The same dialog as the Remove of an app the user added (`MarketplaceAppPage`). */
function MarketplaceRemove() {
  const { t } = useText();
  return (
    <WizardDialog
      open
      closeLabel={t("common.close")}
      onClose={() => undefined}
      logo={<Plug aria-hidden="true" />}
      link="broken"
      title={t("marketplace.app.remove.confirmTitle", { name: "Inventario" })}
      description={t("marketplace.app.remove.description")}
      footer={
        <>
          <Button type="button" variant="outline">
            {t("marketplace.app.remove.keep")}
          </Button>
          <Button type="button" variant="destructive">
            {t("marketplace.app.remove.action")}
          </Button>
        </>
      }
    />
  );
}

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale={params.get("lang") === "en" ? "en" : "es"}>
        <Toaster />
        <Switch>
          <Match when={surface === "billing"}>
            <BillingSettings />
          </Match>
          <Match when={surface === "billing-dialog"}>
            <BillingWebDialog />
          </Match>
          <Match when={surface === "connectors"}>
            <Connectors />
          </Match>
          <Match when={surface === "github-connect"}>
            <GitHubConnect />
          </Match>
          <Match when={surface === "bitwarden-host"}>
            <BitwardenHost />
          </Match>
          <Match when={surface === "mcp-key"}>
            <McpDialog kind="key" />
          </Match>
          <Match when={surface === "mcp-local"}>
            <McpDialog kind="local" />
          </Match>
          <Match when={surface === "mcp-sign-in"}>
            <McpDialog kind="sign-in" />
          </Match>
          <Match when={surface === "chat-apps"}>
            <ChatApps />
          </Match>
          <Match when={surface === "slack-connect"}>
            <ChatAppConnect platform="slack" />
          </Match>
          <Match when={surface === "discord-connect"}>
            <ChatAppConnect platform="discord" />
          </Match>
          <Match when={surface === "telegram-connect"}>
            <ChatAppConnect platform="telegram" />
          </Match>
          <Match when={surface === "marketplace-remove"}>
            <MarketplaceRemove />
          </Match>
        </Switch>
      </StaticI18nProvider>
    ),
    root,
  );
