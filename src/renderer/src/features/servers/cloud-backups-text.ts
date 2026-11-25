import type { CloudGroup, CloudProblem } from "@openbot/contracts/team-protocol/host-cloud-backups-v1";

/** What the owner reads for each problem of a cloud copy. */
export const PROBLEM_TEXT = {
  "two-factor": "backups.cloud.problem.twoFactor",
  "mailbox-password": "backups.cloud.problem.mailboxPassword",
  credentials: "backups.cloud.problem.credentials",
  verification: "backups.cloud.problem.verification",
  "rate-limited": "backups.cloud.problem.rateLimited",
  relogin: "backups.cloud.problem.relogin",
  "repository-password": "backups.cloud.problem.repositoryPassword",
  "drive-full": "backups.cloud.problem.driveFull",
  network: "backups.cloud.problem.network",
  busy: "backups.cloud.problem.busy",
  "restore-test": "backups.cloud.problem.restoreTest",
  unavailable: "backups.cloud.problem.unavailable",
  other: "backups.cloud.problem.other",
} as const satisfies Record<CloudProblem, string>;

/** Each group of a cloud copy: its name, and what it holds. */
export const GROUP_TEXT = {
  database: ["backups.cloud.group.database", "backups.cloud.group.databaseHint"],
  conversations: ["backups.cloud.group.conversations", "backups.cloud.group.conversationsHint"],
  agents: ["backups.cloud.group.agents", "backups.cloud.group.agentsHint"],
  settings: ["backups.cloud.group.settings", "backups.cloud.group.settingsHint"],
  motion: ["backups.cloud.group.motion", "backups.cloud.group.motionHint"],
  work: ["backups.cloud.group.work", "backups.cloud.group.workHint"],
} as const satisfies Record<CloudGroup, readonly [string, string]>;
