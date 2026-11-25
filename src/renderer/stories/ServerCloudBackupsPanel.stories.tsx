import {
  type CloudConnectInput,
  type CloudConnectResult,
  DEFAULT_CLOUD_PLAN,
  type HostCloudBackupsOverview,
} from "@openbot/contracts/team-protocol/host-cloud-backups-v1";
import { Toaster } from "@openbot/ui";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { type HostCloudBackupsCalls, ServerCloudBackupsPanel } from "../src/features/servers/ServerCloudBackupsPanel";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

declare global {
  interface Window {
    /** What the stubbed Proton backend of these stories was asked, for `scripts/web-cloud-backup-connect-e2e.ts`. */
    cloudBackupCalls?: string[];
  }
}

type Ready = Extract<HostCloudBackupsOverview, { available: true }>;

const EMPTY: Ready = {
  available: true,
  destinations: [],
  plan: DEFAULT_CLOUD_PLAN,
  running: null,
  lastBackup: null,
  lastSuccessAt: null,
  nextRunAt: null,
  lastTest: null,
  typical: null,
  sizes: [],
  warnings: [],
  restores: [],
};

const CONNECTED: Ready = {
  ...EMPTY,
  destinations: [
    {
      id: "proton",
      provider: "proton",
      account: "owner@proton.me",
      status: "ok",
      connectedAt: "2026-11-25T08:00:00Z",
      space: { usedBytes: 6.2 * GB, freeBytes: 493 * GB, totalBytes: 500 * GB, checkedAt: "2026-11-25T14:00:00Z" },
    },
  ],
  lastBackup: {
    startedAt: "2026-11-25T14:00:00Z",
    finishedAt: "2026-11-25T14:00:41Z",
    ok: true,
    seconds: 41,
    addedBytes: 24 * MB,
    totalBytes: 11.2 * GB,
    problem: null,
    detail: null,
  },
  lastSuccessAt: "2026-11-25T14:00:41Z",
  nextRunAt: "2026-11-25T15:00:00Z",
  lastTest: {
    startedAt: "2026-11-23T09:00:00Z",
    finishedAt: "2026-11-23T09:12:00Z",
    ok: true,
    seconds: 720,
    addedBytes: 0,
    totalBytes: 0,
    problem: null,
    detail: null,
  },
  typical: { seconds: 44, addedBytes: 21 * MB, runs: 24 },
  sizes: [
    { group: "database", bytes: 2.3 * GB },
    { group: "conversations", bytes: 1.9 * GB },
    { group: "agents", bytes: 1.1 * GB },
    { group: "settings", bytes: 0.4 * GB },
    { group: "motion", bytes: 0.2 * GB },
    { group: "work", bytes: 5.3 * GB },
  ],
};

/**
 * A stand-in for the host and Proton: `owner@proton.me` with the password `correct horse`, an
 * account that asks for the 2FA code `123456`. The first good sign-in makes new copies and answers
 * their password once.
 */
function stubCalls(start: Ready): HostCloudBackupsCalls {
  let overview: Ready = start;
  const record = (call: string) => {
    window.cloudBackupCalls = [...(window.cloudBackupCalls ?? []), call];
  };
  const connect = async (input: CloudConnectInput): Promise<CloudConnectResult> => {
    record(`connect:${input.twoFactorCode ? "code" : "no-code"}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (input.email !== "owner@proton.me" || input.password !== "correct horse")
      return { ok: false, problem: "credentials" };
    if (input.twoFactorCode !== "123456") return { ok: false, problem: "two-factor" };
    overview = { ...CONNECTED, warnings: ["password-not-saved"], lastBackup: null, lastSuccessAt: null, typical: null };
    return { ok: true, overview, repositoryPassword: "Abcde-Fghij-Kmnop-Qrstu-Vwxyz-23456" };
  };
  return {
    overview: async () => overview,
    connect,
    disconnect: async () => {
      record("disconnect");
      overview = EMPTY;
      return overview;
    },
    savePlan: async (plan) => {
      record(`plan:${plan.interval}`);
      overview = { ...overview, plan };
      return overview;
    },
    passwordSaved: async () => {
      record("password-saved");
      overview = {
        ...overview,
        warnings: overview.warnings.filter((w) => w !== "password-not-saved"),
      };
      return overview;
    },
    run: async (kind) => {
      record(`run:${kind}`);
      return overview;
    },
    snapshots: async () => ({
      ok: true,
      snapshots: [{ id: "7ee1041943923f17", time: "2026-11-25T14:00:00Z", bytes: 11.2 * GB, files: 182_000 }],
    }),
    restore: async (snapshot) => {
      record(`restore:${snapshot}`);
      return overview;
    },
    prepareRestore: async () => ({ backupId: "2026-11-25-1500" }),
  };
}

const meta = {
  title: "Servers/Cloud backups",
  render: (args: { overview: Ready; canManage: boolean }) => {
    // Made once: a JSX prop is read again on each access, and the stub keeps the story's state.
    const calls = stubCalls(args.overview);
    return (
      <div style={{ "max-width": "720px", padding: "16px" }}>
        <ServerCloudBackupsPanel serverId="atelier" canManage={args.canManage} actionsAvailable calls={calls} />
        <Toaster />
      </div>
    );
  },
} satisfies Meta<{ overview: Ready; canManage: boolean }>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotConnected: Story = { args: { overview: EMPTY, canManage: true } };
export const Connected: Story = { args: { overview: CONNECTED, canManage: true } };
export const SignInAgain: Story = {
  args: {
    canManage: true,
    overview: {
      ...CONNECTED,
      destinations: CONNECTED.destinations.map((drive) => ({ ...drive, status: "relogin" })),
      warnings: ["relogin", "stale"],
      lastBackup: {
        startedAt: "2026-11-25T13:00:00Z",
        finishedAt: "2026-11-25T13:00:05Z",
        ok: false,
        seconds: 5,
        addedBytes: 0,
        totalBytes: 0,
        problem: "relogin",
        detail: "401 POST https://drive-api.proton.me/auth/v4/refresh: Invalid refresh token (Code=10013)",
      },
    },
  },
};
export const AdminView: Story = { args: { overview: CONNECTED, canManage: false } };
