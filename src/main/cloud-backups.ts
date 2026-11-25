import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  CLOUD_GROUPS,
  CLOUD_PROBLEMS,
  type CloudBrowseResult,
  type CloudConnectInput,
  type CloudConnectResult,
  type CloudDestination,
  type CloudFolderList,
  type CloudGroup,
  type CloudPlan,
  type CloudProblem,
  type CloudRun,
  type CloudSnapshotsResult,
  type CloudWarning,
  cloudGroupsOf,
  cloudPlanOf,
  DEFAULT_CLOUD_PLAN,
  type HostCloudBackupsOverview,
  hostCloudBackupsOverviewOf,
} from "@openbot/contracts/team-protocol/host-cloud-backups-v1";
import type { AppTranslate } from "@openbot/i18n";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import type { SecretCipher } from "./provider-credential-store";

/**
 * Copies of the host to a cloud drive (Server settings > Backups > "Copia en la nube"). The host's
 * backup broker does the work with restic over rclone, as root and at low priority; this process holds
 * every secret (the drive sign-in, rclone's session and the repository password) in its encrypted
 * store, sends them with each call, keeps the refreshed session the broker hands back, decides when a
 * copy is due, and tells the owner when something needs them. Nothing here imports Electron: the
 * cipher, the broker and the owner's push come in as options.
 */

/** The broker's socket API, as `HostBackups.request`. */
export interface CloudBroker {
  available(): boolean;
  request(method: "GET" | "POST", path: string, body?: DynamicRecord, timeoutMs?: number): Promise<unknown>;
}

export interface CloudBackupsOptions {
  broker: CloudBroker;
  /** The folder of the settings file and the encrypted secrets file (the app's user data). */
  directory: string;
  cipher: SecretCipher;
  /** A deploy holds new work: no copy starts. */
  isDraining: () => boolean;
  /** An urgent push to the owner, in the language of each of their devices. */
  alertOwner: (text: (t: AppTranslate) => { title: string; body: string }) => void;
  log: (message: string) => void;
  /** The server's name, for the default folder "Atelier Backups/<name>". */
  serverName?: () => string;
  now?: () => number;
}

/** What the owner reads for each problem. */
export const CLOUD_PROBLEM_TEXT = {
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

const SETTINGS_FILE = "openbot-cloud-backups-v1.json";
const SECRETS_FILE = "openbot-cloud-backups-secrets-v1.json";
const TICK_MS = 60_000;
const WEEK_MS = 7 * 24 * 3_600_000;
const INTERVAL_MS = { "15m": 15 * 60_000, "1h": 3_600_000, "6h": 6 * 3_600_000, daily: 24 * 3_600_000 } as const;
/** A drive with less free space than this share of its size, or than 5 GB, is nearly full. */
const NEARLY_FULL_SHARE = 0.1;
const NEARLY_FULL_BYTES = 5 * 1024 ** 3;
const SIGN_IN_PROBLEMS: ReadonlySet<CloudProblem> = new Set([
  "relogin",
  "two-factor",
  "credentials",
  "mailbox-password",
]);

interface DestinationSecrets {
  email: string;
  password: string;
  mailboxPassword?: string;
  tokens: Record<string, string>;
}

interface Settings {
  destinations: CloudDestination[];
  plan: CloudPlan;
  /** When the owner said they saved the repository password; null while it waits. */
  passwordSavedAt: string | null;
  passwordShown: boolean;
  lastAttemptAt: string | null;
  lastTestAttemptAt: string | null;
  pendingJob: { job: string; kind: "backup" | "test" | "restore" | "move"; at?: string } | null;
  /** The problem the owner was last told about, so an hourly failure pushes once, not each hour. */
  alerted: { problem: string; at: string } | null;
  staleAlertedFor: string | null;
  fullAlertedAt: string | null;
}

const EMPTY: Settings = {
  destinations: [],
  plan: DEFAULT_CLOUD_PLAN,
  passwordSavedAt: null,
  passwordShown: false,
  lastAttemptAt: null,
  lastTestAttemptAt: null,
  pendingJob: null,
  alerted: null,
  staleAlertedFor: null,
  fullAlertedAt: null,
};

export class CloudBackupError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const record = (value: unknown): DynamicRecord => (isDynamicRecord(value) ? value : {});
const text = (value: unknown, limit = 600): string => (typeof value === "string" ? value.slice(0, limit) : "");
const problemOf = (value: unknown): CloudProblem => CLOUD_PROBLEMS.find((problem) => problem === value) ?? "other";
const stringMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

/** A drive folder as the broker takes it: a relative path with no empty or `..` part. */
function cleanFolder(value: string | undefined): string {
  return (value ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 400);
}

/** A long random password in groups of five, easy to copy into a password manager. */
export function newRepositoryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(30);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length] ?? "x");
  return Array.from({ length: 6 }, (_, index) => chars.slice(index * 5, index * 5 + 5).join("")).join("-");
}

/** The instant of a wall-clock time in a time zone, on the day of `at` there. */
function zonedInstant(at: number, time: string, timeZone: string, dayOffset = 0): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  const [hour, minute] = time.split(":").map(Number);
  const wanted = Date.UTC(part("year"), part("month") - 1, part("day") + dayOffset, hour ?? 0, minute ?? 0);
  // The zone's offset at that moment: the wall time there minus the same digits read as UTC.
  const shown = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  const offset = shown - Math.floor(at / 60_000) * 60_000;
  return wanted - offset;
}

/** The start of the run slot that `at` is in, for the plan. */
export function slotStart(plan: CloudPlan, at: number): number {
  if (plan.interval !== "daily") {
    const size = INTERVAL_MS[plan.interval];
    return Math.floor(at / size) * size;
  }
  let timeZone = plan.timezone;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    timeZone = "UTC";
  }
  const today = zonedInstant(at, plan.dailyTime, timeZone);
  return today <= at ? today : zonedInstant(at, plan.dailyTime, timeZone, -1);
}

export class CloudBackups {
  readonly #options: CloudBackupsOptions;
  #settings: Settings;
  #secrets: { destinations: Record<string, DestinationSecrets>; repository: string | null };
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<void> | null = null;

  constructor(options: CloudBackupsOptions) {
    this.#options = options;
    this.#settings = this.#readSettings();
    this.#secrets = this.#readSecrets();
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  available(): boolean {
    return this.#options.broker.available();
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), TICK_MS);
    this.#timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  // ---- storage ----------------------------------------------------------------------------------

  #path(name: string): string {
    return join(this.#options.directory, name);
  }

  #readSettings(): Settings {
    try {
      const value = record(JSON.parse(readFileSync(this.#path(SETTINGS_FILE), "utf8")));
      const decoded = hostCloudBackupsOverviewOf({ available: true, destinations: value.destinations });
      const at = (field: unknown): string | null => (typeof field === "string" ? field.slice(0, 64) : null);
      const pending = record(value.pendingJob);
      const alerted = record(value.alerted);
      const pendingKind =
        pending.kind === "test" || pending.kind === "restore" || pending.kind === "move" ? pending.kind : "backup";
      return {
        destinations: decoded.available ? decoded.destinations : [],
        plan: cloudPlanOf(value.plan),
        passwordSavedAt: at(value.passwordSavedAt),
        passwordShown: value.passwordShown === true,
        lastAttemptAt: at(value.lastAttemptAt),
        lastTestAttemptAt: at(value.lastTestAttemptAt),
        pendingJob:
          typeof pending.job === "string" ? { job: pending.job, kind: pendingKind, at: text(pending.at, 64) } : null,
        alerted: typeof alerted.problem === "string" ? { problem: alerted.problem, at: text(alerted.at, 64) } : null,
        staleAlertedFor: at(value.staleAlertedFor),
        fullAlertedAt: at(value.fullAlertedAt),
      };
    } catch {
      return { ...EMPTY };
    }
  }

  #saveSettings(): void {
    writeAtomically(this.#path(SETTINGS_FILE), `${JSON.stringify(this.#settings, null, 2)}\n`);
  }

  #readSecrets(): { destinations: Record<string, DestinationSecrets>; repository: string | null } {
    try {
      const envelope = record(JSON.parse(readFileSync(this.#path(SECRETS_FILE), "utf8")));
      if (envelope.version !== 1 || typeof envelope.sealed !== "string") throw new Error("unreadable");
      const value = record(JSON.parse(this.#options.cipher.decrypt(Buffer.from(envelope.sealed, "base64"))));
      const destinations: Record<string, DestinationSecrets> = {};
      for (const [id, raw] of Object.entries(record(value.destinations))) {
        const row = record(raw);
        destinations[id] = {
          email: text(row.email, 320),
          password: text(row.password, 1024),
          ...(typeof row.mailboxPassword === "string" ? { mailboxPassword: row.mailboxPassword } : {}),
          tokens: stringMap(row.tokens),
        };
      }
      const secrets = { destinations, repository: typeof value.repository === "string" ? value.repository : null };
      this.#register(secrets);
      return secrets;
    } catch {
      return { destinations: {}, repository: null };
    }
  }

  #register(secrets: { destinations: Record<string, DestinationSecrets>; repository: string | null }): void {
    if (secrets.repository) registerSecretValue(secrets.repository);
    for (const row of Object.values(secrets.destinations)) {
      for (const value of [row.password, row.mailboxPassword, ...Object.values(row.tokens)])
        if (value && value.length >= 4) registerSecretValue(value);
    }
  }

  #saveSecrets(): void {
    this.#register(this.#secrets);
    const sealed = this.#options.cipher.encrypt(JSON.stringify(this.#secrets)).toString("base64");
    writeAtomically(this.#path(SECRETS_FILE), `${JSON.stringify({ version: 1, sealed })}\n`, 0o600);
  }

  // ---- broker -----------------------------------------------------------------------------------

  async #status(): Promise<DynamicRecord> {
    return record(await this.#options.broker.request("GET", "/v1/cloud/status"));
  }

  #destinationBody(destination: CloudDestination): DynamicRecord {
    const secrets = this.#secrets.destinations[destination.id];
    if (!secrets) throw new CloudBackupError(sourceText("error.host.cloudSignInMissing"), 409);
    return {
      provider: destination.provider,
      email: secrets.email,
      password: secrets.password,
      ...(secrets.mailboxPassword ? { mailboxPassword: secrets.mailboxPassword } : {}),
      tokens: secrets.tokens,
      folder: destination.folder || this.#defaultFolder(),
    };
  }

  #defaultFolder(): string {
    const name = (this.#options.serverName?.() ?? "")
      .replace(/[/\\\n\r]/gu, " ")
      .trim()
      .slice(0, 80);
    return name ? `Atelier Backups/${name}` : "Atelier Backups";
  }

  #keepTokens(destinationId: string, tokens: unknown): void {
    const next = stringMap(tokens);
    const secrets = this.#secrets.destinations[destinationId];
    if (!secrets || Object.keys(next).length === 0) return;
    if (JSON.stringify(next) === JSON.stringify(secrets.tokens)) return;
    secrets.tokens = next;
    this.#saveSecrets();
  }

  #active(): CloudDestination | null {
    return this.#settings.destinations[0] ?? null;
  }

  // ---- owner and admin actions ------------------------------------------------------------------

  async connect(input: CloudConnectInput): Promise<CloudConnectResult> {
    if (!this.available()) return { ok: false, problem: "unavailable" };
    if (input.provider !== "proton") throw new CloudBackupError(sourceText("error.host.cloudProviderSoon"), 400);
    const email = input.email.trim();
    if (!email || !input.password) return { ok: false, problem: "credentials" };
    for (const value of [input.password, input.mailboxPassword, input.repositoryPassword])
      if (value && value.length >= 4) registerSecretValue(value);
    const given = input.repositoryPassword?.trim();
    const repository = given || this.#secrets.repository || newRepositoryPassword();
    const fresh = !given && !this.#secrets.repository;
    const folder = cleanFolder(input.folder) || this.#active()?.folder || this.#defaultFolder();
    const destination = {
      provider: "proton",
      folder,
      email,
      password: input.password,
      ...(input.mailboxPassword ? { mailboxPassword: input.mailboxPassword } : {}),
      ...(input.twoFactorCode?.trim() ? { twoFactorCode: input.twoFactorCode.trim() } : {}),
    };
    const answer = record(
      await this.#options.broker.request(
        "POST",
        "/v1/cloud/login",
        { destination, repositoryPassword: repository },
        180_000,
      ),
    );
    if (answer.ok !== true) {
      const problem = problemOf(answer.problem);
      this.#options.log(`Cloud copies: the Proton sign-in failed (${problem}).`);
      return { ok: false, problem };
    }
    const id = "proton";
    this.#secrets.destinations[id] = {
      email,
      password: input.password,
      ...(input.mailboxPassword ? { mailboxPassword: input.mailboxPassword } : {}),
      tokens: stringMap(answer.tokens),
    };
    this.#secrets.repository = repository;
    this.#saveSecrets();
    const about = record(answer.about);
    this.#settings.destinations = [
      {
        id,
        provider: "proton",
        account: email,
        status: "ok",
        connectedAt: new Date(this.#now()).toISOString(),
        folder,
        space:
          typeof about.usedBytes === "number"
            ? {
                usedBytes: about.usedBytes,
                freeBytes: typeof about.freeBytes === "number" ? about.freeBytes : null,
                totalBytes: typeof about.totalBytes === "number" ? about.totalBytes : null,
                checkedAt: text(about.checkedAt, 64),
              }
            : null,
      },
    ];
    const created = answer.created === true;
    if (created && fresh) {
      this.#settings.passwordSavedAt = null;
      this.#settings.passwordShown = true;
    } else if (!this.#settings.passwordSavedAt) this.#settings.passwordSavedAt = new Date(this.#now()).toISOString();
    this.#settings.alerted = null;
    this.#saveSettings();
    this.#options.log(`Cloud copies: Proton Drive connected (${created ? "new" : "existing"} copies).`);
    void this.#options.broker
      .request("POST", "/v1/cloud/measure", { largeFileMb: this.#settings.plan.largeFileMb })
      .catch(() => undefined);
    const overview = await this.overview();
    return created && fresh ? { ok: true, overview, repositoryPassword: repository } : { ok: true, overview };
  }

  async disconnect(id: string): Promise<HostCloudBackupsOverview> {
    this.#settings.destinations = this.#settings.destinations.filter((row) => row.id !== id);
    delete this.#secrets.destinations[id];
    // The repository password stays: without it the copies already on the drive can't be read.
    this.#saveSecrets();
    this.#settings.pendingJob = null;
    this.#saveSettings();
    return this.overview();
  }

  async setPlan(plan: CloudPlan): Promise<HostCloudBackupsOverview> {
    this.#settings.plan = cloudPlanOf(plan);
    this.#settings.staleAlertedFor = null;
    this.#saveSettings();
    return this.overview();
  }

  async passwordSaved(): Promise<HostCloudBackupsOverview> {
    this.#settings.passwordSavedAt = new Date(this.#now()).toISOString();
    this.#saveSettings();
    return this.overview();
  }

  async runNow(kind: "backup" | "test"): Promise<HostCloudBackupsOverview> {
    const destination = this.#active();
    if (!destination) throw new CloudBackupError(sourceText("error.host.cloudNotConnected"), 409);
    if (this.#options.isDraining()) throw new CloudBackupError(sourceText("error.host.cloudUpdating"), 409);
    await this.#start(destination, kind);
    return this.overview();
  }

  async snapshots(): Promise<CloudSnapshotsResult> {
    const destination = this.#active();
    if (!destination) return { ok: false, problem: "other", snapshots: [] };
    // A running job holds the drive session; a second sign-in with the same refresh token would end it.
    if (this.#settings.pendingJob) return { ok: false, problem: "busy", snapshots: [] };
    const answer = record(
      await this.#options.broker.request(
        "POST",
        "/v1/cloud/snapshots",
        { destination: this.#destinationBody(destination), repositoryPassword: this.#secrets.repository ?? "" },
        300_000,
      ),
    );
    this.#keepTokens(destination.id, answer.tokens);
    const snapshots = (Array.isArray(answer.snapshots) ? answer.snapshots : []).filter(isDynamicRecord).map((row) => ({
      id: text(row.id, 64),
      time: text(row.time, 64),
      bytes: typeof row.bytes === "number" ? row.bytes : 0,
      files: typeof row.files === "number" ? row.files : 0,
      groups: cloudGroupsOf(row.groups),
    }));
    if (answer.ok !== true) {
      const problem = problemOf(answer.problem);
      this.#afterProblem(destination, problem);
      return { ok: false, problem, snapshots };
    }
    return { ok: true, snapshots };
  }

  /** A whole copy, its chosen groups, or chosen files and folders, into its own folder on the server. */
  async restore(
    snapshot: string,
    confirm: string,
    pick: { groups?: CloudGroup[]; paths?: string[] } = {},
  ): Promise<HostCloudBackupsOverview> {
    if (!/^[0-9a-f]{8,64}$/u.test(snapshot) || confirm !== snapshot)
      throw new CloudBackupError(sourceText("error.host.cloudConfirm"), 400);
    const destination = this.#active();
    if (!destination) throw new CloudBackupError(sourceText("error.host.cloudNotConnected"), 409);
    await this.#start(destination, "restore", {
      snapshot,
      ...(pick.groups?.length ? { groups: pick.groups } : {}),
      ...(pick.paths?.length ? { paths: pick.paths.slice(0, 200) } : {}),
    });
    return this.overview();
  }

  /** One folder of a copy, to pick a file or folder to restore. */
  async browse(snapshot: string, path: string): Promise<CloudBrowseResult> {
    const destination = this.#active();
    if (!destination) return { ok: false, entries: [], problem: "other" };
    if (this.#settings.pendingJob) return { ok: false, entries: [], problem: "busy" };
    const answer = record(
      await this.#options.broker.request(
        "POST",
        "/v1/cloud/ls",
        {
          destination: this.#destinationBody(destination),
          repositoryPassword: this.#secrets.repository ?? "",
          snapshot,
          path,
        },
        600_000,
      ),
    );
    this.#keepTokens(destination.id, answer.tokens);
    const entries = (Array.isArray(answer.entries) ? answer.entries : []).filter(isDynamicRecord).map((row) => ({
      name: text(row.name, 255),
      path: text(row.path, 4096),
      dir: row.dir === true,
      bytes: typeof row.bytes === "number" ? row.bytes : 0,
    }));
    return answer.ok === true ? { ok: true, entries } : { ok: false, entries, problem: problemOf(answer.problem) };
  }

  /** The subfolders of a drive folder, to choose where the copies go; `create` makes it first. */
  async folders(path: string, create: boolean): Promise<CloudFolderList> {
    const destination = this.#active();
    const clean = cleanFolder(path);
    if (!destination) return { ok: false, path: clean, folders: [], hasCopies: false, problem: "other" };
    if (this.#settings.pendingJob) return { ok: false, path: clean, folders: [], hasCopies: false, problem: "busy" };
    const answer = record(
      await this.#options.broker.request(
        "POST",
        "/v1/cloud/folders",
        { destination: this.#destinationBody(destination), path: clean, create },
        180_000,
      ),
    );
    this.#keepTokens(destination.id, answer.tokens);
    return {
      ok: answer.ok === true,
      path: clean,
      folders: (Array.isArray(answer.folders) ? answer.folders : []).map((item) => text(item, 255)).filter(Boolean),
      hasCopies: answer.hasCopies === true,
      ...(answer.ok === true ? {} : { problem: problemOf(answer.problem) }),
    };
  }

  /**
   * Another folder for the copies. `move` moves the copies there (a job; the folder changes when it
   * ends). `use` uses that folder from now on: its copies if it has some (their password: the one
   * kept, or `repositoryPassword`), or new ones; the copies in the old folder stay where they are.
   */
  async changeFolder(folder: string, mode: "move" | "use", repositoryPassword?: string): Promise<CloudConnectResult> {
    const destination = this.#active();
    const clean = cleanFolder(folder);
    if (!destination) throw new CloudBackupError(sourceText("error.host.cloudNotConnected"), 409);
    if (!clean) return { ok: false, problem: "other" };
    if (mode === "move") {
      await this.#start(destination, "move", { to: clean });
      return { ok: true, overview: await this.overview() };
    }
    if (this.#settings.pendingJob) return { ok: false, problem: "busy" };
    if (repositoryPassword && repositoryPassword.length >= 4) registerSecretValue(repositoryPassword);
    const answer = record(
      await this.#options.broker.request(
        "POST",
        "/v1/cloud/login",
        {
          destination: { ...this.#destinationBody(destination), folder: clean },
          repositoryPassword: repositoryPassword?.trim() || this.#secrets.repository || "",
        },
        180_000,
      ),
    );
    this.#keepTokens(destination.id, answer.tokens);
    if (answer.ok !== true) return { ok: false, problem: problemOf(answer.problem) };
    if (repositoryPassword?.trim()) {
      this.#secrets.repository = repositoryPassword.trim();
      this.#saveSecrets();
    }
    destination.folder = clean;
    this.#saveSettings();
    this.#options.log("Cloud copies: the drive folder changed.");
    return { ok: true, overview: await this.overview() };
  }

  /**
   * Puts a downloaded copy back on this server: it becomes a local backup, and the broker's restore
   * takes a safety backup of now, holds new work, stops the host, restores and starts it again.
   */
  async apply(restoreId: string, confirm: string): Promise<{ started: boolean; backupId: string }> {
    if (!restoreId || confirm !== restoreId) throw new CloudBackupError(sourceText("error.host.cloudConfirm"), 400);
    if (this.#settings.pendingJob) throw new CloudBackupError(sourceText("error.host.cloudBusy"), 409);
    const { backupId } = await this.prepareRestore(restoreId);
    if (!backupId) throw new CloudBackupError(sourceText("error.host.cloudStartFailed"), 502);
    const answer = record(
      await this.#options.broker.request(
        "POST",
        `/v1/backups/${encodeURIComponent(backupId)}/restore`,
        { confirm: backupId, spaces: true },
        120_000,
      ),
    );
    this.#options.log("Cloud copies: a downloaded copy is being put back.");
    return { started: answer.started === true, backupId };
  }

  async prepareRestore(restoreId: string): Promise<{ backupId: string }> {
    const answer = record(
      await this.#options.broker.request("POST", "/v1/cloud/import", { restore: restoreId }, 3_600_000),
    );
    return { backupId: text(answer.backupId, 128) };
  }

  async #start(destination: CloudDestination, kind: "backup" | "test" | "restore" | "move", extra: DynamicRecord = {}) {
    // One job at a time: a run that comes while another goes is refused, never queued. A job that
    // never reported back for six hours no longer holds the next one.
    const pending = this.#settings.pendingJob;
    if (pending && this.#now() - (Date.parse(pending.at ?? "") || 0) < 6 * 3_600_000)
      throw new CloudBackupError(sourceText("error.host.cloudBusy"), 409);
    const answer = record(
      await this.#options.broker.request(
        "POST",
        `/v1/cloud/${kind}`,
        {
          destination: this.#destinationBody(destination),
          repositoryPassword: this.#secrets.repository ?? "",
          plan: this.#settings.plan,
          ...extra,
        },
        60_000,
      ),
    );
    const job = text(answer.job, 128);
    if (!job) throw new CloudBackupError(sourceText("error.host.cloudStartFailed"), 502);
    const at = new Date(this.#now()).toISOString();
    this.#settings.pendingJob = { job, kind, at };
    if (kind === "backup") this.#settings.lastAttemptAt = at;
    if (kind === "test") this.#settings.lastTestAttemptAt = at;
    this.#saveSettings();
    this.#options.log(`Cloud copies: ${kind} started.`);
  }

  // ---- schedule ---------------------------------------------------------------------------------

  /** One pass of the schedule: collect a finished job, start a due one, and warn the owner. */
  tick(): Promise<void> {
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.#tick()
      .catch((error: unknown) => this.#options.log(`Cloud copies: the schedule check failed (${String(error)}).`))
      .finally(() => {
        this.#ticking = null;
      });
    return this.#ticking;
  }

  async #tick(): Promise<void> {
    if (!this.available()) return;
    const destination = this.#active();
    if (!destination) return;
    const status = await this.#status();
    await this.#collect(destination, status);
    const plan = this.#settings.plan;
    const now = this.#now();
    this.#warnStale(status, now);
    this.#warnFull(destination, now);
    if (!plan.enabled || destination.status !== "ok" || this.#options.isDraining()) return;
    if (this.#settings.pendingJob) return;
    const due = !this.#settings.lastAttemptAt || Date.parse(this.#settings.lastAttemptAt) < slotStart(plan, now);
    if (due) {
      if (status.busy === true) {
        // The previous copy (or a local backup or restore) still runs: this slot is skipped, never queued.
        this.#settings.lastAttemptAt = new Date(now).toISOString();
        this.#saveSettings();
        this.#options.log("Cloud copies: a run was due while another job ran; it was skipped.");
        return;
      }
      await this.#start(destination, "backup");
      return;
    }
    const lastTest = this.#settings.lastTestAttemptAt ? Date.parse(this.#settings.lastTestAttemptAt) : 0;
    if (status.busy !== true && status.lastSuccess && now - lastTest >= WEEK_MS) await this.#start(destination, "test");
  }

  async #collect(destination: CloudDestination, status: DynamicRecord): Promise<void> {
    const pending = this.#settings.pendingJob;
    if (!pending || isDynamicRecord(status.running)) return;
    const entry =
      pending.kind === "backup"
        ? record(status.lastBackup)
        : pending.kind === "test"
          ? record(status.lastTest)
          : pending.kind === "move"
            ? record(status.lastMove)
            : record(
                (Array.isArray(status.restores) ? status.restores : [])
                  .filter(isDynamicRecord)
                  .find((row) => row.id === pending.job),
              );
    if (entry.job !== pending.job && entry.id !== pending.job) {
      // Not started or not finished yet. A job that never reports (the broker restarted) is dropped
      // after a day, so the schedule goes on.
      const started = Date.parse(pending.at ?? "");
      if (!Number.isFinite(started) || this.#now() - started > 24 * 3_600_000) {
        this.#settings.pendingJob = null;
        this.#saveSettings();
      }
      return;
    }
    // The session tokens that rclone refreshed during the job: Proton turns a used refresh token
    // invalid, so the next job must send these.
    const collected = record(await this.#options.broker.request("POST", "/v1/cloud/collect", { job: pending.job }));
    this.#keepTokens(destination.id, collected.tokens);
    this.#settings.pendingJob = null;
    this.#saveSettings();
    const ok = entry.ok === true || entry.status === "ok";
    if (ok && pending.kind === "move" && typeof entry.folder === "string") {
      destination.folder = entry.folder;
      this.#saveSettings();
    }
    if (ok) {
      if (destination.status !== "ok" || this.#settings.alerted) {
        destination.status = "ok";
        this.#settings.alerted = null;
        this.#saveSettings();
      }
      return;
    }
    const problem = problemOf(entry.problem);
    this.#options.log(`Cloud copies: the ${pending.kind} failed (${problem}).`);
    this.#afterProblem(destination, problem, pending.kind);
  }

  #afterProblem(
    destination: CloudDestination,
    problem: CloudProblem,
    kind: "backup" | "test" | "restore" | "move" = "backup",
  ) {
    if (problem === "busy") return;
    if (SIGN_IN_PROBLEMS.has(problem)) {
      if (destination.status !== "relogin") {
        destination.status = "relogin";
        this.#saveSettings();
        this.#options.alertOwner((t) => ({
          title: t("backups.cloud.push.reloginTitle"),
          body: t("backups.cloud.push.reloginBody"),
        }));
      }
      return;
    }
    const key = `${kind}:${problem}`;
    if (this.#settings.alerted?.problem === key) return;
    this.#settings.alerted = { problem: key, at: new Date(this.#now()).toISOString() };
    this.#saveSettings();
    this.#options.alertOwner((t) => ({
      title: kind === "test" ? t("backups.cloud.push.testFailedTitle") : t("backups.cloud.push.failedTitle"),
      body: t(CLOUD_PROBLEM_TEXT[problem]),
    }));
  }

  #warnStale(status: DynamicRecord, now: number): void {
    if (!this.#settings.plan.enabled) return;
    const last = text(record(status.lastSuccess).finishedAt, 64);
    const since = last ? Date.parse(last) : Date.parse(this.#active()?.connectedAt ?? "");
    if (!Number.isFinite(since)) return;
    const limit = 2 * INTERVAL_MS[this.#settings.plan.interval] + 15 * 60_000;
    if (now - since < limit) return;
    const episode = last || "never";
    if (this.#settings.staleAlertedFor === episode) return;
    this.#settings.staleAlertedFor = episode;
    this.#saveSettings();
    this.#options.alertOwner((t) => ({
      title: t("backups.cloud.push.staleTitle"),
      body: t("backups.cloud.push.staleBody"),
    }));
  }

  #warnFull(destination: CloudDestination, now: number): void {
    if (!this.#nearlyFull(destination)) return;
    const last = this.#settings.fullAlertedAt ? Date.parse(this.#settings.fullAlertedAt) : 0;
    if (now - last < 24 * 3_600_000) return;
    this.#settings.fullAlertedAt = new Date(now).toISOString();
    this.#saveSettings();
    this.#options.alertOwner((t) => ({
      title: t("backups.cloud.push.fullTitle"),
      body: t("backups.cloud.push.fullBody"),
    }));
  }

  #nearlyFull(destination: CloudDestination): boolean {
    const space = destination.space;
    if (!space || space.freeBytes === null) return false;
    const total = space.totalBytes ?? space.usedBytes + space.freeBytes;
    return space.freeBytes < NEARLY_FULL_BYTES || (total > 0 && space.freeBytes < total * NEARLY_FULL_SHARE);
  }

  // ---- overview ---------------------------------------------------------------------------------

  async overview(): Promise<HostCloudBackupsOverview> {
    if (!this.available()) return { available: false };
    let status: DynamicRecord = {};
    try {
      status = await this.#status();
    } catch (error) {
      this.#options.log(`Cloud copies: the broker did not answer (${String(error)}).`);
    }
    const destination = this.#active();
    const about = record(status.about);
    if (destination && typeof about.usedBytes === "number" && text(about.checkedAt) !== destination.space?.checkedAt) {
      destination.space = {
        usedBytes: about.usedBytes,
        freeBytes: typeof about.freeBytes === "number" ? about.freeBytes : null,
        totalBytes: typeof about.totalBytes === "number" ? about.totalBytes : null,
        checkedAt: text(about.checkedAt, 64),
      };
      this.#saveSettings();
    }
    const runOf = (value: unknown): CloudRun | null => {
      if (!isDynamicRecord(value)) return null;
      return {
        startedAt: text(value.startedAt, 64),
        finishedAt: text(value.finishedAt, 64),
        ok: value.ok === true,
        seconds: Math.round(typeof value.seconds === "number" ? value.seconds : 0),
        addedBytes: typeof value.addedBytes === "number" ? value.addedBytes : 0,
        totalBytes: typeof value.totalBytes === "number" ? value.totalBytes : 0,
        problem: value.ok === true ? null : problemOf(value.problem),
        detail: typeof value.detail === "string" ? value.detail.slice(0, 600) : null,
      };
    };
    const running = record(status.running);
    const kind = text(running.kind);
    const history = (Array.isArray(status.history) ? status.history : [])
      .filter(isDynamicRecord)
      .filter((row) => row.ok === true)
      .slice(-24);
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted.length ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0;
    };
    const sizes = record(record(status.sizes).bytes);
    const plan = this.#settings.plan;
    const now = this.#now();
    const nextRunAt =
      destination && plan.enabled && destination.status === "ok"
        ? new Date(
            Math.max(
              now,
              this.#settings.lastAttemptAt && Date.parse(this.#settings.lastAttemptAt) >= slotStart(plan, now)
                ? slotStart(plan, now) +
                    (plan.interval === "daily"
                      ? slotStart(plan, now + INTERVAL_MS.daily + 3_600_000) - slotStart(plan, now)
                      : INTERVAL_MS[plan.interval])
                : now,
            ),
          ).toISOString()
        : null;
    const lastSuccessAt = text(record(status.lastSuccess).finishedAt, 64) || null;
    const lastTest = runOf(status.lastTest);
    const warnings: CloudWarning[] = [];
    if (destination && this.#nearlyFull(destination)) warnings.push("drive-nearly-full");
    if (destination?.status === "relogin") warnings.push("relogin");
    if (this.#settings.passwordShown && !this.#settings.passwordSavedAt) warnings.push("password-not-saved");
    if (lastTest && !lastTest.ok) warnings.push("test-failed");
    if (destination && plan.enabled) {
      const since = lastSuccessAt ? Date.parse(lastSuccessAt) : Date.parse(destination.connectedAt);
      if (Number.isFinite(since) && now - since > 2 * INTERVAL_MS[plan.interval] + 15 * 60_000) warnings.push("stale");
    }
    return {
      available: true,
      destinations: this.#settings.destinations,
      plan,
      running: kind.startsWith("cloud-")
        ? {
            kind:
              kind === "cloud-test"
                ? "test"
                : kind === "cloud-restore"
                  ? "restore"
                  : kind === "cloud-move"
                    ? "move"
                    : "backup",
            startedAt: text(running.startedAt, 64),
            phase: text(running.phase, 64),
          }
        : null,
      lastBackup: runOf(status.lastBackup),
      lastSuccessAt,
      nextRunAt,
      lastTest,
      typical: history.length
        ? {
            seconds: Math.round(median(history.map((row) => (typeof row.seconds === "number" ? row.seconds : 0)))),
            addedBytes: median(history.map((row) => (typeof row.addedBytes === "number" ? row.addedBytes : 0))),
            runs: history.length,
          }
        : null,
      sizes: CLOUD_GROUPS.filter((group: CloudGroup) => typeof sizes[group] === "number").map((group) => ({
        group,
        bytes: Number(sizes[group]),
      })),
      warnings,
      restores: (Array.isArray(status.restores) ? status.restores : [])
        .filter(isDynamicRecord)
        .slice(-20)
        .map((row) => ({
          id: text(row.id, 128),
          snapshot: text(row.snapshot, 64),
          status: row.status === "ok" ? ("ok" as const) : ("failed" as const),
          finishedAt: text(row.finishedAt, 64),
          bytes: typeof row.bytes === "number" ? row.bytes : 0,
          preparedAs: typeof row.importedAs === "string" ? row.importedAs : null,
          partial: row.partial === true,
        })),
    };
  }
}

function writeAtomically(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { mode });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
