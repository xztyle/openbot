import type { HostBackupsOverview, HostRestoreCheck } from "@openbot/contracts/team-protocol/host-backups-v1";
import { Toaster } from "@openbot/ui";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { type HostBackupsCalls, ServerBackupsPanel } from "../src/features/servers/ServerBackupsPanel";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const READY: HostBackupsOverview = {
  available: true,
  nightly: "03:30",
  retention: { daily: 7, weekly: 4 },
  disk: { freeBytes: 55 * GB, totalBytes: 467 * GB },
  offsite: false,
  running: null,
  lastRestore: null,
  backups: [
    {
      id: "2026-11-21-0330",
      createdAt: "2026-11-21T03:30:00Z",
      reason: "nightly",
      status: "partial",
      bytes: 38 * GB,
      newBytes: 640 * MB,
      schema: 55,
      seconds: 412,
      components: [
        { name: "core", status: "ok" },
        { name: "space:cakemaker", status: "skipped", reason: "needs 63 GB, 54 GB free (min 20 GB kept)" },
        { name: "space:piks", status: "skipped", reason: "needs 19 GB, 54 GB free (min 20 GB kept)" },
      ],
      offsite: null,
    },
    {
      id: "2026-11-20-1412",
      createdAt: "2026-11-20T14:12:00Z",
      reason: "manual",
      status: "ok",
      bytes: 37 * GB,
      newBytes: 410 * MB,
      schema: 55,
      seconds: 380,
      components: [{ name: "core", status: "ok" }],
      offsite: null,
    },
    {
      id: "2026-11-20-0330",
      createdAt: "2026-11-20T03:30:00Z",
      reason: "nightly",
      status: "failed",
      bytes: 0,
      newBytes: 0,
      schema: null,
      seconds: 12,
      error: "Only 18 GB free on the backup disk.",
      components: [],
      offsite: null,
    },
  ],
};

const CHECK: HostRestoreCheck = {
  ok: true,
  problems: [],
  warnings: ["Space folders stay as they are now (restore them with the Spaces option)."],
  backup: { id: "2026-11-20-1412", createdAt: "2026-11-20T14:12:00Z", schema: 55 },
  current: { schema: 55 },
  restore: ["database", "motion", "core", "workspace:Agents", "workspace:Shared"],
  counts: [
    { table: "projection_agents", now: 72, backup: 71 },
    { table: "projection_thread_messages", now: 48_210, backup: 47_258 },
  ],
  confirm: "2026-11-20-1412",
};

function calls(overview: HostBackupsOverview): HostBackupsCalls {
  return {
    overview: async () => overview,
    create: async () => overview,
    check: async () => CHECK,
    restore: async () => ({ started: true }),
  };
}

const meta = {
  title: "Servers/Backups",
  render: (args: { overview: HostBackupsOverview; canRestore: boolean }) => (
    <div style={{ "max-width": "720px", padding: "24px" }}>
      <ServerBackupsPanel
        serverId="atelier"
        hostName="Atelier"
        actionsAvailable
        canRestore={args.canRestore}
        calls={calls(args.overview)}
      />
      <Toaster />
    </div>
  ),
} satisfies Meta<{ overview: HostBackupsOverview; canRestore: boolean }>;

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = { args: { overview: READY, canRestore: true } };
export const Restoring: Story = {
  args: {
    canRestore: true,
    overview: {
      ...READY,
      running: { kind: "restore", id: "2026-11-20-1412", phase: "files", startedAt: "2026-11-21T09:00:00Z" },
      lastRestore: {
        id: "2026-11-20-1412",
        status: "running",
        startedAt: "2026-11-21T09:00:00Z",
        safetyBackup: "2026-11-21-0900",
        steps: [{ at: "2026-11-21T09:01:00Z", text: "Restoring settings, keys, vault and provider accounts." }],
      },
    },
  },
};
export const NotSetUp: Story = {
  args: { canRestore: true, overview: { available: false, reason: "Backups are not set up on this server." } },
};
