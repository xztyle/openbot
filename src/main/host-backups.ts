import { existsSync } from "node:fs";
import { request } from "node:http";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  type HostBackupsOverview,
  type HostRestoreCheck,
  hostBackupsOverviewOf,
  hostRestoreCheckOf,
} from "@openbot/contracts/team-protocol/host-backups-v1";

/**
 * The host's backup broker (`scripts/backup-broker/backupd.py` in the private release scripts) runs
 * as root outside the container and answers on a unix socket mounted at this path. It accepts only
 * this process: it checks the caller's pid, so an agent in the container cannot use it.
 */
const text = (value: unknown, limit = 500): string => (typeof value === "string" ? value.slice(0, limit) : "");

export const HOST_BACKUP_SOCKET = process.env.OPENBOT_BACKUP_SOCKET ?? "/opt/backupctl/backupd.sock";

export class HostBackupError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One call to the broker. A missing socket means the broker is not set up on this host. */
export class HostBackups {
  constructor(readonly socketPath: string = HOST_BACKUP_SOCKET) {}

  available(): boolean {
    return existsSync(this.socketPath);
  }

  async overview(): Promise<HostBackupsOverview> {
    if (!this.available())
      return { available: false, reason: "Backups are not set up on this server (scripts/backup-broker)." };
    return hostBackupsOverviewOf(await this.#call("GET", "/v1/overview"));
  }

  async create(): Promise<HostBackupsOverview> {
    await this.#call("POST", "/v1/backups", {});
    return this.overview();
  }

  async check(id: string, spaces: boolean): Promise<HostRestoreCheck> {
    return hostRestoreCheckOf(
      await this.#call("POST", `/v1/backups/${encodeURIComponent(id)}/check`, { spaces }, 120_000),
    );
  }

  async restore(id: string, confirm: string, spaces: boolean): Promise<{ started: boolean }> {
    const answer = await this.#call(
      "POST",
      `/v1/backups/${encodeURIComponent(id)}/restore`,
      { confirm, spaces },
      120_000,
    );
    return { started: isDynamicRecord(answer) && answer.started === true };
  }

  /** One raw call to the broker, for the cloud copies (`cloud-backups.ts`). */
  request(method: "GET" | "POST", path: string, body?: DynamicRecord, timeoutMs = 30_000): Promise<unknown> {
    return this.#call(method, path, body, timeoutMs);
  }

  #call(method: "GET" | "POST", path: string, body?: DynamicRecord, timeoutMs = 30_000): Promise<unknown> {
    if (!this.available()) return Promise.reject(new HostBackupError("Backups are not set up on this server.", 404));
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const call = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4 << 20) call.destroy(new HostBackupError("The backup service answered too much.", 502));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              return reject(new HostBackupError("The backup service gave an unreadable answer.", 502));
            }
            const status = response.statusCode ?? 500;
            if (status >= 400) {
              const message = isDynamicRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "";
              return reject(new HostBackupError(text(message) || "The backup service refused.", status));
            }
            resolve(parsed);
          });
        },
      );
      call.on("timeout", () => call.destroy(new HostBackupError("The backup service did not answer in time.", 504)));
      call.on("error", (error) =>
        reject(error instanceof HostBackupError ? error : new HostBackupError(error.message, 502)),
      );
      call.end(payload);
    });
  }
}
