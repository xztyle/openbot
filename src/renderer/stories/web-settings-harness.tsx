/*
 * The web client on a mock host whose admin routes answer, for `scripts/web-settings-e2e.ts`. The
 * script serves it at every address under `/app`, as the site does. It is the "Spaces workspace"
 * story with an administrable host: the settings show the server's sections (General, Members,
 * Workspace, Updates, Backups with a connected cloud drive) beside the account's own.
 *
 * The agent efficiency and learning routes answer too, so an agent's settings show the weekly
 * review, the settings history and the memory actions (`scripts/agent-settings-page-e2e.ts`).
 *
 * `?routines=1` also serves the event routines, the event checks and the schedule of the host, with a
 * routine for Chief, so its routines, its checks and the Schedule page show (`scripts/agent-flows-settings-e2e.ts`).
 *
 * `?role=member` signs in as a member, so the check sees what a member does not get.
 * `?theme=light` shows the light theme.
 * `?workspace=off` is a host without the workspace, so a channel opens in the older channel view with
 * its settings side panel (`scripts/channels-settings-e2e.ts`).
 */
import type { PerformanceReview } from "@openbot/contracts/agent-efficiency";
import type { SettingsCheckpoint } from "@openbot/contracts/agent-learning";
import { DEFAULT_WORKSPACE_SETTINGS, type Routine, type TeamRole } from "@openbot/contracts/ipc";
import {
  AGENT_BACKUP_MODELS_CAPABILITY,
  AGENT_BACKUP_MODELS_ROUTES,
} from "@openbot/contracts/team-protocol/agent-backup-models-v1";
import { AGENT_EFFICIENCY_ROUTES } from "@openbot/contracts/team-protocol/agent-efficiency-v1";
import { AGENT_LEARNING_ROUTES } from "@openbot/contracts/team-protocol/agent-learning-v1";
import { AGENT_MAILBOXES_ROUTES } from "@openbot/contracts/team-protocol/agent-mailboxes-v1";
import { CONNECTOR_ACCESS_ROUTES } from "@openbot/contracts/team-protocol/connector-access-v1";
import { EVENT_CHECK_API_ROUTES } from "@openbot/contracts/team-protocol/event-check-api-v1";
import { EVENT_CHECKS_CAPABILITY, EVENT_CHECKS_ROUTES } from "@openbot/contracts/team-protocol/event-checks-v1";
import { EVENTS_CAPABILITY, EVENTS_ROUTES } from "@openbot/contracts/team-protocol/events-v1";
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
const withoutWorkspace = params.get("workspace") === "off";
const routines = params.get("routines") === "1";
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

const REVIEW: PerformanceReview = {
  id: "review-chief-w47",
  agentId: "chief",
  periodStart: "2026-11-16T00:00:00Z",
  periodEnd: "2026-11-23T00:00:00Z",
  grade: "good",
  scorecard: {
    turns: 64,
    failedTurns: 2,
    ticketsDone: 9,
    ticketsReopened: 1,
    praise: 5,
    complaints: 1,
    costUsd: 4.2,
    smallModelShare: 0.4,
  },
  summary: "Cerró las tareas de la semana a tiempo. Dos informes llegaron sin las cifras de ventas.",
  proposal: { text: "Incluye siempre las cifras de ventas de la semana en el informe.", state: "pending" },
  reviewCostUsd: 0.03,
  createdAt: "2026-11-23T08:00:00Z",
};

const CHECKPOINTS: SettingsCheckpoint[] = [
  {
    id: "checkpoint-1",
    agentId: "chief",
    at: "2026-11-24T18:00:00Z",
    author: { kind: "owner" },
    changes: [{ field: "title", before: "Jefe", after: "Jefe de equipo" }],
  },
];

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-26T12:00:00Z");
const CONNECTIONS = {
  gateway: { listening: true, publicUrl: "https://connect.delynith.com" },
  tokens: [
    { id: "token-1", label: "Claude en mi celular", createdAt: NOW - 240 * HOUR, lastUsedAt: NOW - 3 * HOUR },
    { id: "token-2", label: "ChatGPT en la oficina", createdAt: NOW - 30 * HOUR, lastUsedAt: null },
  ],
  inboxes: [
    {
      routeId: "route-stripe",
      ownerKind: "agent",
      ownerId: "chief",
      ownerName: "Chief",
      routineName: "Ventas de Stripe",
      spaceId: "general",
      scheme: "stripe",
      hasSecret: true,
      lastEventAt: NOW - 2 * HOUR,
      lastStatus: 200,
    },
  ],
};
const MAILBOXES = {
  gateway: { listening: true, publicUrl: "https://connect.delynith.com" },
  inboxUrl: "https://connect.delynith.com/mail/in",
  workerUrl: "https://atelier-mail.delynith.workers.dev",
  hasSecret: true,
  lastMailAt: NOW - HOUR,
  lastStatus: 200,
  mailboxes: [
    {
      id: "mailbox-1",
      address: "ventas@aprendivo.com",
      displayName: "Lucía de Aprendivo",
      agentId: "chief",
      agentName: "Chief",
      spaceId: "general",
      mode: "reply",
      createdAt: NOW - 400 * HOUR,
      lastMailAt: NOW - HOUR,
      received: 128,
      sentToday: 6,
      ownerApprovesEverySend: false,
    },
  ],
};

/** The fixture's sizes are fractions of a gigabyte; the wire carries whole bytes. */
function wholeNumbers<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "number" ? Math.round(item) : item)));
}

/** The host's admin routes that the settings pages read. A route this fixture lacks is refused. */
function adminRuntime(mock: ReturnType<typeof createMockOpenBot>): WebAdminRuntime {
  let cloud: CloudReady = wholeNumbers(CLOUD_CONNECTED);
  window.settingsHarnessCalls = [];
  // The input of an event or check route is the call's own input (`eventBody` in team-admin-requests.ts).
  // A copy of the body, read as the mock call takes it.
  const input = () => JSON.parse(JSON.stringify(body ?? null));
  let body: unknown;
  // Chief moves to a smaller model when a usage limit holds it, and asks first.
  let backupModels: unknown = { automatic: false, order: [{ provider: "codex", model: "gpt-5.6-terra" }] };
  const request: WebAdminRuntime["request"] = async (_method, path, decode, sent) => {
    window.settingsHarnessCalls?.push(path);
    body = sent;
    if (routines) {
      const runs = /^\/v1\/agents\/([^/]+)\/routines(?:\/([^/]+)\/runs)?/u.exec(path);
      if (runs?.[1] && !runs[2]) return decode(await mock.api.agent.listRoutines(decodeURIComponent(runs[1])));
      if (runs?.[1] && runs[2]) return decode([]);
      const events = mock.api.events;
      const checks = mock.api.eventChecks;
      if (path === EVENT_CHECK_API_ROUTES.environment) return decode(await checks.environment(input()));
      if (path === EVENT_CHECK_API_ROUTES.setEnvironment) return decode(await checks.setEnvironment(input()));
      if (path === EVENT_CHECK_API_ROUTES.test) return decode(await checks.test(input()));
      // A host with `event-check-api-v1` takes the other check calls at its own prefix.
      switch (path.replace("/v1/event-check-api/", "/v1/event-checks/")) {
        case AGENT_BACKUP_MODELS_ROUTES.settings:
          return decode({ backupModels, usageLimitReturn: null });
        case AGENT_BACKUP_MODELS_ROUTES.update: {
          const next = input().backupModels;
          backupModels = next ?? null;
          return decode({ backupModels, usageLimitReturn: null });
        }
        case EVENTS_ROUTES.status:
          return decode(await events.getStatus(SERVER));
        case EVENTS_ROUTES.listRoutines:
          return decode(await events.listRoutines(input(), SERVER));
        case EVENTS_ROUTES.saveRoutine:
          return decode(await events.saveRoutine(input(), SERVER));
        case EVENTS_ROUTES.deleteRoutine:
          await events.deleteRoutine(input(), SERVER);
          return decode(null);
        case EVENTS_ROUTES.testRoutine:
          await events.testRoutine(input(), SERVER);
          return decode(null);
        case EVENTS_ROUTES.listActivity:
          return decode(await events.listActivity(input(), SERVER));
        case EVENT_CHECKS_ROUTES.list:
          return decode(await checks.list(input()));
        case EVENT_CHECKS_ROUTES.save:
          return decode(await checks.save(input()));
        case EVENT_CHECKS_ROUTES.remove:
          await checks.remove(input());
          return decode(null);
        case EVENT_CHECKS_ROUTES.history:
          return decode(await checks.history(input()));
        case EVENT_CHECKS_ROUTES.checkNow:
          return decode(await checks.checkNow(input()));
        case EVENT_CHECKS_ROUTES.accounts:
          return decode(await checks.accounts(input()));
        case EVENT_CHECKS_ROUTES.tools:
          return decode(await checks.tools(input()));
      }
    }
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
      case AGENT_EFFICIENCY_ROUTES.reviews:
        return decode({ reviews: [REVIEW] });
      case AGENT_EFFICIENCY_ROUTES.runReview:
        return decode({ review: REVIEW });
      case AGENT_EFFICIENCY_ROUTES.sleep: {
        const sleeping = body && typeof body === "object" && "sleeping" in body && body.sleeping === true;
        return decode({ changedAgentIds: ["chief"], sleepingAgentIds: sleeping ? ["chief"] : [] });
      }
      case AGENT_LEARNING_ROUTES.history:
        return decode({ checkpoints: CHECKPOINTS });
      case AGENT_LEARNING_ROUTES.dream:
        return decode({ items: [] });
      case AGENT_LEARNING_ROUTES.forgetConversation: {
        const confirm = body && typeof body === "object" && "confirm" in body && body.confirm === true;
        return decode({
          memories: [{ id: "memory-1", text: "La panadería abre a las 8 los domingos." }],
          facts: [],
          forgotten: confirm ? 1 : 0,
        });
      }
      // The chat app links, webhooks and mailboxes under Keys and passwords.
      case CONNECTOR_ACCESS_ROUTES.state:
        return decode(CONNECTIONS);
      case AGENT_MAILBOXES_ROUTES.state:
        return decode(MAILBOXES);
      default:
        throw new Error(`Not in this fixture: ${path}`);
    }
  };
  return { request, team: mock.api.host };
}

/** The preview host's id, which the desktop events calls of the mock take. */
const SERVER = "preview-host";

/** Chief's routine on the Schedule page, from the released routine route. */
const SCHEDULED: Routine = {
  id: "routine-resumen",
  agentId: "chief",
  name: "Resumen de la mañana",
  instruction: "Resume los pedidos nuevos y lo que falta por entregar hoy.",
  active: true,
  timezone: "Europe/Madrid",
  trigger: {
    id: "trigger-resumen",
    routineId: "routine-resumen",
    schedule: { kind: "weekdays", time: "08:00" },
    nextRunAt: "2026-11-27T07:00:00.000Z",
    createdAt: "2026-11-20T09:00:00.000Z",
    updatedAt: "2026-11-20T09:00:00.000Z",
  },
  createdAt: "2026-11-20T09:00:00.000Z",
  updatedAt: "2026-11-20T09:00:00.000Z",
};

/** Chief's routines and its check, as the events and check routes answer them. */
function seedRoutines(mock: ReturnType<typeof createMockOpenBot>): void {
  const owner = { kind: "agent", id: "chief" } as const;
  void mock.api.events.saveRoutine(
    {
      owner,
      name: SCHEDULED.name,
      instruction: SCHEDULED.instruction,
      active: true,
      timezone: SCHEDULED.timezone,
      trigger: { kind: "schedule", schedule: { kind: "weekdays", time: "08:00" } },
    },
    SERVER,
  );
  void mock.api.events.saveRoutine(
    {
      owner,
      name: "Revisión semanal",
      instruction: "Revisa el trabajo abierto y prepara las prioridades de la semana.",
      active: false,
      timezone: SCHEDULED.timezone,
      trigger: { kind: "schedule", schedule: { kind: "weekly", weekday: 5, time: "16:00" } },
    },
    SERVER,
  );
  void mock.api.eventChecks.save({
    agentId: "chief",
    name: "Pedidos nuevos",
    instruction: "Lee cada pedido nuevo y avísame si falta algún dato.",
    active: true,
    timezone: SCHEDULED.timezone,
    schedule: { kind: "interval", amount: 5, unit: "minutes", anchorAt: "2026-11-20T08:00:00.000Z" },
    selfEvents: { mode: "exclude", connectionId: "preview-linear", actorPointer: "/creator/id", accountActorIds: [] },
    source: {
      kind: "mcp",
      connectionId: "preview-linear",
      toolName: "list_issues",
      argumentsJson: "{}",
      cursorArgument: "cursor",
      nextCursorPointer: "/cursor",
    },
    selection: { itemsPointer: "/issues", idPointer: "/id", revisionPointer: "/updatedAt" },
  });
}

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    ...(routines ? { routines: { chief: [SCHEDULED] } } : {}),
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
  if (routines) seedRoutines(mock);
  return mockWebRuntimeFor(mock, events, {
    role,
    admin: adminRuntime(mock),
    // The fork host capability is the workspace's own, so a host without the workspace has neither.
    capabilities: [
      ...(withoutWorkspace ? [] : [FORK_HOST_CAPABILITY]),
      HOST_ADMIN_CAPABILITY,
      ...(routines ? [EVENTS_CAPABILITY, EVENT_CHECKS_CAPABILITY, AGENT_BACKUP_MODELS_CAPABILITY] : []),
    ],
    withoutWorkspace,
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
