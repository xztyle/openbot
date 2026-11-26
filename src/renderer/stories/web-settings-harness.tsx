/*
 * The web client on a mock host whose admin routes answer, for `scripts/web-settings-e2e.ts`. The
 * script serves it at every address under `/app`, as the site does. It is the "Spaces workspace"
 * story with an administrable host: the settings show the server's sections (General, Members,
 * Workspace, Updates, Backups with a connected cloud drive) beside the account's own.
 *
 * `?role=member` signs in as a member, so the check sees what a member does not get.
 * `?theme=light` shows the light theme.
 */
import { DEFAULT_WORKSPACE_SETTINGS, type TeamRole } from "@openbot/contracts/ipc";
import { FORK_HOST_CAPABILITY } from "@openbot/contracts/team-protocol/fork-host-v1";
import { HOST_ADMIN_CAPABILITY } from "@openbot/contracts/team-protocol/host-admin-v1";
import { HOST_BACKUPS_ROUTES, type HostBackupsOverview } from "@openbot/contracts/team-protocol/host-backups-v1";
import { HOST_CLOUD_BACKUPS_ROUTES } from "@openbot/contracts/team-protocol/host-cloud-backups-v1";
import { WORKSPACE_ROUTES } from "@openbot/contracts/team-protocol/workspace-v1";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import type { WebAdminRuntime } from "../src/features/web-client/web-runtime";
import { StaticI18nProvider } from "../src/i18n-context";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { CLOUD_CONNECTED, type CloudReady, GB, MB } from "./cloud-backups-fixtures";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

declare global {
  interface Window {
    /** The admin routes the client asked for, in order, for the check. */
    settingsHarnessCalls?: string[];
  }
}

const params = new URLSearchParams(window.location.search);
const roleParam = params.get("role");
const role: TeamRole = roleParam === "member" || roleParam === "admin" ? roleParam : "owner";
if (params.get("theme") === "light") document.documentElement.dataset.openbotColorScheme = "light";

const BACKUPS: HostBackupsOverview = {
  available: true,
  backups: [
    {
      id: "backup-20261125-030000",
      createdAt: "2026-11-25T03:00:00Z",
      reason: "nightly",
      status: "ok",
      bytes: 9.8 * GB,
      newBytes: 120 * MB,
      schema: 47,
      seconds: 38,
      components: [
        { name: "core", status: "ok" },
        { name: "motion-files", status: "ok" },
      ],
      offsite: null,
    },
  ],
  running: null,
  lastRestore: null,
  nightly: "03:00",
  retention: { daily: 7, weekly: 4 },
  disk: { freeBytes: 310 * GB, totalBytes: 467 * GB },
  offsite: false,
};

/** The fixture's sizes are fractions of a gigabyte; the wire carries whole bytes. */
function wholeNumbers<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "number" ? Math.round(item) : item)));
}

/** The host's admin routes that the settings pages read. A route this fixture lacks is refused. */
function adminRuntime(mock: ReturnType<typeof createMockOpenBot>): WebAdminRuntime {
  let cloud: CloudReady = wholeNumbers(CLOUD_CONNECTED);
  window.settingsHarnessCalls = [];
  const request: WebAdminRuntime["request"] = async (_method, path, decode, body) => {
    window.settingsHarnessCalls?.push(path);
    switch (path) {
      case HOST_CLOUD_BACKUPS_ROUTES.overview:
        return decode(cloud);
      case HOST_CLOUD_BACKUPS_ROUTES.plan: {
        const plan = body && typeof body === "object" && "plan" in body ? body.plan : null;
        if (plan && typeof plan === "object") cloud = { ...cloud, plan: { ...cloud.plan, ...plan } };
        return decode(cloud);
      }
      case HOST_CLOUD_BACKUPS_ROUTES.snapshots:
        return decode(
          wholeNumbers({
            ok: true,
            snapshots: [
              { id: "7ee1041943923f17", time: "2026-11-25T14:00:41Z", bytes: 11.2 * GB, files: 48210, groups: [] },
            ],
          }),
        );
      case HOST_CLOUD_BACKUPS_ROUTES.folders: {
        const path =
          body && typeof body === "object" && "path" in body && typeof body.path === "string" ? body.path : "";
        return decode({
          ok: true,
          path,
          folders: path ? ["Delynith", "Oficina"] : ["Atelier Backups", "Documentos", "Fotos"],
          hasCopies: false,
        });
      }
      case HOST_CLOUD_BACKUPS_ROUTES.browse:
        return decode(
          wholeNumbers({
            ok: true,
            entries: [
              { name: "agents", path: "/agents", dir: true, bytes: 0 },
              { name: "settings", path: "/settings", dir: true, bytes: 0 },
              { name: "openbot.db", path: "/openbot.db", dir: false, bytes: 2.3 * GB },
            ],
          }),
        );
      case HOST_BACKUPS_ROUTES.overview:
        return decode(wholeNumbers(BACKUPS));
      case HOST_BACKUPS_ROUTES.check:
        return decode({
          ok: true,
          problems: [],
          warnings: ["La copia es de ayer: el trabajo de hoy se reemplaza."],
          backup: { id: "backup-20261125-030000", createdAt: "2026-11-25T03:00:00Z", schema: 47 },
          current: { schema: 47 },
          restore: ["core", "motion-files"],
          counts: [
            { table: "messages", now: 18420, backup: 18102 },
            { table: "tickets", now: 312, backup: 309 },
          ],
          confirm: "backup-20261125-030000",
        });
      case WORKSPACE_ROUTES.settings:
        return decode(DEFAULT_WORKSPACE_SETTINGS);
      default:
        throw new Error(`Not in this fixture: ${path}`);
    }
  };
  return { request, team: mock.api.host };
}

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    channels: seeds(WEB_PREVIEW_MEMBER_ID),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    spaces: [
      {
        space: { id: "trading", name: "Trading", slug: "market-trading", icon: null, hue: 215 },
        agentIds: ["research"],
        channelIds: ["cakemaker"],
      },
    ],
  });
  return mockWebRuntimeFor(mock, events, {
    role,
    admin: adminRuntime(mock),
    capabilities: [FORK_HOST_CAPABILITY, HOST_ADMIN_CAPABILITY],
  });
};

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale={params.get("lang") === "en" ? "en" : "es"}>
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
            appearance={params.get("theme") === "light" ? "light" : "dark"}
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
