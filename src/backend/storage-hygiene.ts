// Storage hygiene: the service behind the workspace Storage view and the automatic cleanup rules.
//
// It owns the last scan report and plan, the cleanup that an owner or admin starts, the automatic
// rules (both off by default) and their timer, the last cleanup result and the audit file. The
// scan and the deletions run in the background host process through `StorageHygieneWorker`. An
// agent has no way in: only the IPC handlers and the admin Team API routes call this service.

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeStorageHygieneCleanupResult,
  STORAGE_HYGIENE_LIMITS,
  STORAGE_HYGIENE_RULE_CLASS,
  type StorageHygieneApplyInput,
  type StorageHygieneCleanupResult,
  type StorageHygieneSettings,
  type StorageHygieneState,
  type StorageHygieneStateInput,
  type StorageHygieneWebpTool,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema } from "effect";
import { causeHelpers } from "./effect-boundary";
import {
  STORAGE_HYGIENE_ENTRY_LIMIT,
  type StorageHygieneScanArea,
  type StorageHygieneScanResult,
  storageHygieneDisk,
} from "./storage-hygiene-scan";
import type { StorageHygieneWorker } from "./storage-hygiene-worker";

export class StorageHygieneFailure extends Schema.TaggedError<StorageHygieneFailure>()("StorageHygieneFailure", {
  cause: Schema.Defect(),
}) {}

const { io: hygieneIO } = causeHelpers(StorageHygieneFailure);

/** A scan or a cleanup runs. The Team API answers 409. */
export class StorageHygieneBusyError extends Error {}

export interface StorageHygieneAgent {
  id: string;
  workspacePath: string;
}

export interface StorageHygieneSources {
  /** `~/OpenBot/Shared`: each folder in it is one project area. */
  sharedRoot: string;
  agents: () => readonly StorageHygieneAgent[];
  /** A path on the disk that holds the data, for the gauge and the automatic rule. */
  diskPath: string;
  /** Where the scan cache, the last result and `audit.jsonl` live. */
  stateDirectory: string;
  settings: () => StorageHygieneSettings;
  worker: StorageHygieneWorker;
  /** A failure of a background scan or automatic cleanup, for the log. */
  onBackgroundFailure?: (error: unknown) => void;
}

/** A refresh scans again when the report is older than this. */
const REPORT_TTL_MS = 10 * 60_000;
const AUTOMATIC_INTERVAL_MS = 30 * 60_000;
const AUTOMATIC_FIRST_RUN_MS = 10 * 60_000;
const DAILY_MS = 24 * 3_600_000;
const CONVERT_LIMIT = 5_000;
const AUDIT_ROTATE_BYTES = 20 * 1_024 * 1_024;

export class StorageHygieneService {
  readonly #sources: StorageHygieneSources;
  #result: StorageHygieneScanResult | null = null;
  #scan: { startedAt: number; entries: number; promise: Promise<StorageHygieneScanResult> } | null = null;
  #cleanup: { startedAt: number; promise: Promise<void> } | null = null;
  #lastCleanup: StorageHygieneCleanupResult | null = null;
  #lastCleanupLoaded = false;
  #webpTool: { value: StorageHygieneWebpTool | null } | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastDaily = 0;
  #disposed = false;

  constructor(sources: StorageHygieneSources) {
    this.#sources = sources;
  }

  get #cachePath() {
    return join(this.#sources.stateDirectory, "scan-cache.json");
  }

  get #auditPath() {
    return join(this.#sources.stateDirectory, "audit.jsonl");
  }

  get #lastCleanupPath() {
    return join(this.#sources.stateDirectory, "last-cleanup.json");
  }

  /** The state of the scan and the cleanup; `refresh` and `force` start a scan in the background. */
  state(input: StorageHygieneStateInput): Effect.Effect<StorageHygieneState, StorageHygieneFailure> {
    return hygieneIO(async () => {
      await Promise.all([this.#loadLastCleanup(), this.#detectWebpTool()]);
      const report = this.#result?.report ?? null;
      const old = !report || Date.now() - report.scannedAt > REPORT_TTL_MS;
      if (!this.#scan && !this.#cleanup && (input.force || (input.refresh && old)))
        this.#startScan(Boolean(input.force)).catch((error) => this.#sources.onBackgroundFailure?.(error));
      return this.#snapshot();
    });
  }

  /** Starts the cleanup of planned items. The answer comes at once; the state shows the run. */
  apply(input: StorageHygieneApplyInput, actor?: string): Effect.Effect<StorageHygieneState, StorageHygieneFailure> {
    return hygieneIO(async () => {
      if (this.#scan || this.#cleanup) throw new StorageHygieneBusyError(sourceText("error.storage.hygieneBusy"));
      const result = this.#result;
      if (!result) throw new StorageHygieneBusyError(sourceText("error.storage.hygieneNoReport"));
      const wanted = new Set(input.itemIds);
      const items = result.plan.filter((item) => wanted.has(item.id));
      const unplanned = wanted.size - items.length;
      void this.#runCleanup("manual", actor, async () => {
        const settings = this.#sources.settings();
        const outcome = await this.#sources.worker.apply({
          items,
          now: Date.now(),
          recentMinutes: settings.recentMinutes,
          staleIdleHours: settings.staleIdleHours,
          minimumIdleHours: null,
          trigger: "manual",
          ...(actor ? { actor } : {}),
          auditPath: this.#auditPath,
        });
        return { ...outcome, unplanned, converted: 0, convertedSavedBytes: 0 };
      });
      return this.#snapshot();
    });
  }

  /** Starts the timer of the automatic rules. Each run does nothing while both rules are off. */
  start(): void {
    if (this.#timer || this.#disposed) return;
    const tick = (delay: number) => {
      this.#timer = setTimeout(() => {
        this.runAutomaticRules()
          .catch((error) => this.#sources.onBackgroundFailure?.(error))
          .finally(() => {
            if (!this.#disposed) tick(AUTOMATIC_INTERVAL_MS);
          });
      }, delay);
      this.#timer.unref?.();
    };
    tick(AUTOMATIC_FIRST_RUN_MS);
  }

  /**
   * One run of the automatic rules: when the disk is fuller than the limit, remove regenerable
   * caches idle for the set hours; once a day, convert and delete old evidence media as set.
   */
  async runAutomaticRules(): Promise<void> {
    const settings = this.#sources.settings();
    if (this.#disposed || this.#scan || this.#cleanup) return;
    if (!settings.autoPrune && !settings.evidenceConvert && !settings.evidenceDelete) return;
    const disk = await storageHygieneDisk(this.#sources.diskPath);
    const usedPercent =
      disk.totalBytes && disk.freeBytes !== null ? ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100 : 0;
    const prune = settings.autoPrune && usedPercent > settings.autoPruneDiskPercent;
    const daily = (settings.evidenceConvert || settings.evidenceDelete) && Date.now() - this.#lastDaily > DAILY_MS;
    if (!prune && !daily) return;
    if (daily) this.#lastDaily = Date.now();
    const result = await this.#startScan(false);
    const idleBefore = Date.now() - settings.autoPruneIdleHours * 3_600_000;
    const items = result.plan.filter(
      (item) =>
        (prune && STORAGE_HYGIENE_RULE_CLASS[item.rule] === "regenerable" && item.modifiedAt < idleBefore) ||
        (daily && settings.evidenceDelete && item.rule === "evidence-media"),
    );
    const tool = daily && settings.evidenceConvert ? await this.#detectWebpTool() : null;
    if (!items.length && !(tool && result.convertible.length)) return;
    await this.#runCleanup("automatic", undefined, async () => {
      const now = Date.now();
      const outcome = items.length
        ? await this.#sources.worker.apply({
            items,
            now,
            recentMinutes: settings.recentMinutes,
            staleIdleHours: settings.staleIdleHours,
            minimumIdleHours: prune ? settings.autoPruneIdleHours : null,
            trigger: "automatic",
            auditPath: this.#auditPath,
          })
        : { freedBytes: 0, deleted: 0, skipped: [] };
      const converted =
        tool && result.convertible.length
          ? await this.#sources.worker.convert({
              convertible: result.convertible,
              tool,
              now,
              recentMinutes: settings.recentMinutes,
              limit: CONVERT_LIMIT,
              trigger: "automatic",
              auditPath: this.#auditPath,
            })
          : { converted: 0, savedBytes: 0 };
      return { ...outcome, unplanned: 0, converted: converted.converted, convertedSavedBytes: converted.savedBytes };
    });
  }

  dispose(): Effect.Effect<void> {
    return Effect.promise(async () => {
      this.#disposed = true;
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      this.#sources.worker.dispose();
    });
  }

  #snapshot(): StorageHygieneState {
    return {
      scan: this.#scan
        ? { running: true, startedAt: this.#scan.startedAt, entries: this.#scan.entries }
        : { running: false },
      cleanup: this.#cleanup ? { running: true, startedAt: this.#cleanup.startedAt } : { running: false },
      report: this.#result?.report ?? null,
      lastCleanup: this.#lastCleanup,
      webpTool: this.#webpTool?.value ?? null,
    };
  }

  async #areas(): Promise<StorageHygieneScanArea[]> {
    const areas: StorageHygieneScanArea[] = [];
    const shared = await readdir(this.#sources.sharedRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of shared)
      if (entry.isDirectory())
        areas.push({ kind: "project", name: entry.name, root: join(this.#sources.sharedRoot, entry.name) });
    for (const agent of this.#sources.agents())
      areas.push({ kind: "agent", name: agent.id, agentId: agent.id, root: agent.workspacePath });
    return areas.slice(0, STORAGE_HYGIENE_LIMITS.areas);
  }

  #startScan(force: boolean): Promise<StorageHygieneScanResult> {
    if (this.#scan) return this.#scan.promise;
    const startedAt = Date.now();
    const promise = (async () => {
      const settings = this.#sources.settings();
      await mkdir(this.#sources.stateDirectory, { recursive: true, mode: 0o700 });
      const [areas] = await Promise.all([this.#areas(), this.#detectWebpTool()]);
      const result = await this.#sources.worker.scan(
        {
          areas,
          diskPath: this.#sources.diskPath,
          now: Date.now(),
          staleIdleHours: settings.staleIdleHours,
          evidenceDeleteAfterDays: settings.evidenceDeleteAfterDays,
          evidenceConvertAfterDays: settings.evidenceConvert ? settings.evidenceConvertAfterDays : null,
          force,
          cachePath: this.#cachePath,
          entryLimit: STORAGE_HYGIENE_ENTRY_LIMIT,
        },
        (entries) => {
          if (this.#scan) this.#scan.entries = entries;
        },
      );
      this.#result = result;
      return result;
    })();
    this.#scan = { startedAt, entries: 0, promise };
    return promise.finally(() => {
      this.#scan = null;
    });
  }

  async #detectWebpTool(): Promise<StorageHygieneWebpTool | null> {
    if (this.#webpTool) return this.#webpTool.value;
    const value = await this.#sources.worker.webpTool().catch(() => null);
    this.#webpTool = { value };
    return value;
  }

  #runCleanup(
    trigger: "manual" | "automatic",
    actor: string | undefined,
    work: () => Promise<{
      freedBytes: number;
      deleted: number;
      skipped: StorageHygieneCleanupResult["skipped"];
      unplanned: number;
      converted: number;
      convertedSavedBytes: number;
    }>,
  ): Promise<void> {
    const startedAt = Date.now();
    const promise = (async () => {
      await this.#rotateAudit();
      try {
        const outcome = await work();
        const result: StorageHygieneCleanupResult = {
          startedAt,
          finishedAt: Date.now(),
          trigger,
          ...(actor ? { actor: actor.slice(0, STORAGE_HYGIENE_LIMITS.actor) } : {}),
          freedBytes: outcome.freedBytes,
          deleted: outcome.deleted,
          skipped: outcome.skipped.slice(0, STORAGE_HYGIENE_LIMITS.skipped).map((skip) => ({
            ...skip,
            path: skip.path.slice(0, STORAGE_HYGIENE_LIMITS.path),
          })),
          skippedCount: outcome.skipped.length + outcome.unplanned,
          converted: outcome.converted,
          convertedSavedBytes: outcome.convertedSavedBytes,
        };
        this.#lastCleanup = result;
        await writeFile(this.#lastCleanupPath, JSON.stringify(result), { mode: 0o600 }).catch(() => undefined);
      } finally {
        this.#cleanup = null;
      }
      // The numbers after the cleanup: the folders that changed are measured again.
      await this.#startScan(false);
    })();
    this.#cleanup = { startedAt, promise };
    promise.catch((error) => this.#sources.onBackgroundFailure?.(error));
    return promise;
  }

  async #loadLastCleanup(): Promise<void> {
    if (this.#lastCleanupLoaded) return;
    this.#lastCleanupLoaded = true;
    try {
      this.#lastCleanup ??= decodeStorageHygieneCleanupResult(
        JSON.parse(await readFile(this.#lastCleanupPath, "utf8")),
      );
    } catch {
      // No cleanup ran yet, or the file is damaged: the view shows none.
    }
  }

  async #rotateAudit(): Promise<void> {
    const size = await stat(this.#auditPath).then(
      (info) => info.size,
      () => 0,
    );
    if (size > AUDIT_ROTATE_BYTES) await rename(this.#auditPath, `${this.#auditPath}.1`).catch(() => undefined);
  }
}
