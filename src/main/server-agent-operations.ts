/**
 * Operator routes of the control socket that reach agents, for a server without a person at the UI:
 *
 * - `POST /v1/agents/<agentId>/message` sends `text` to the agent's own chat as the signed-in owner,
 *   through the same `sendMessage` as the app: the same queue, turn start and steer rules. With
 *   `system` set, the text goes as a note from OpenBot: the chat shows a marker, not the owner's message.
 * - `POST /v1/resume-interrupted` tells each agent whose last delivery a restart cut off to continue,
 *   as a note from OpenBot. The server also does this by itself once after each start
 *   (`resumeAfterRestart`), so the route is for a dry run or for the deliveries of an earlier restart.
 * - `POST /v1/drain` holds every queue and waits until no turn runs, `timeout` seconds at most
 *   (default 600, up to 1800), so a deploy restarts the server between turns. It answers `drained`
 *   and the turns that still run. `POST /v1/drain/cancel` ends the hold; it also ends by itself five
 *   minutes after the wait, for a deploy that did not restart.
 * - `POST /v1/restart-notice` tells every device that the server restarts now (`state=restarting`,
 *   the default) or that it does not (`state=none`), so they ask again every few seconds instead of
 *   backing off to a two-minute wait. A deploy sends it before it stops the container. The drain sends
 *   `waiting` while it waits for turns. A notice that no restart follows ends after five minutes.
 *
 * - `POST /v1/guardrails/failover` changes the failover part of the guardrails policy through the same
 *   save as the Trust page: a JSON body with any of `enabled`, `thresholdPercent` and `tiers`. It
 *   answers the failover policy that applies now.
 *
 * A body is JSON or form fields. Every action is logged without the text. The resume route keeps the
 * deliveries it handled in a small file, so a second call, or a call after another restart, does not
 * send the note again.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { type GuardrailPolicy, normalizeGuardrailPolicy } from "@openbot/contracts/guardrails";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { QueuedMessageReceipt, SendMessageInput, SystemNoticeKind } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { HostRestartState } from "@openbot/contracts/team-protocol/host-update-v1";
import { Effect, Result } from "effect";

/** The reason that boot recovery writes on a delivery that the previous run left unfinished. */
export const RESTART_INTERRUPTION_REASON = "OpenBot restarted before this delivery reached a confirmed terminal state.";
export const RESUME_NOTE = "Atelier restarted during your last turn; continue where you left off.";
/** The newest handled deliveries that the marker file keeps. */
const MARKER_LIMIT = 500;

export interface ControlAnswer {
  status: number;
  lines: Record<string, string | number | null>;
}

export interface ServerAgentOperationsDependencies {
  /**
   * The deliveries that boot recovery of this process ended as interrupted. A call after a second
   * restart names the first one's deliveries itself (`deliveryIds`), as the deploy records them.
   */
  restartInterrupted: () => ReadonlySet<string>;
  /** The open `openbot.db` connection. */
  database: () => DatabaseSync;
  /** The agents of this server. */
  agentIds: () => readonly string[];
  /**
   * `AgentService.sendMessage` with the signed-in owner as the sender, or with `notice`, as a note
   * from OpenBot that the chat shows as a marker.
   */
  send: (
    input: SendMessageInput,
    notice?: SystemNoticeKind,
  ) => Effect.Effect<QueuedMessageReceipt, { readonly cause: unknown }>;
  /** The JSON file of handled deliveries. */
  markerFile: string;
  log: (message: string) => void;
  /** Holds new turns and waits for the running ones, as `AgentService.drainForDeploy`. */
  drain?: (timeoutMs: number) => Promise<readonly { turnId: string; agentId: string }[]>;
  /** Ends the hold of `drain`. */
  endDrain?: () => void;
  /** `HostService.announceRestart`: the `host-restart` event to every connected device. */
  announceRestart?: (state: HostRestartState) => void;
  /** An urgent push to the owner's devices, for an operator alert such as a failed check after a deploy. */
  alertOwner?: (title: string, body: string) => void;
  /** Starts the upload benchmark of the cloud copies (`POST /v1/cloud-backups/bench`); operator only. */
  cloudBench?: () => Promise<string>;
  /** The guardrails policy now, and its save (`GuardrailsService.savePolicy`). */
  guardrailsPolicy?: () => GuardrailPolicy;
  saveGuardrailsPolicy?: (policy: GuardrailPolicy) => Promise<void>;
}

/** A restart notice that no restart followed ends after this long. */
const RESTART_NOTICE_MS = 5 * 60_000;

/** The default and the longest wait of `POST /v1/drain`. */
const DRAIN_DEFAULT_SECONDS = 600;
const DRAIN_MAX_SECONDS = 1_800;

/** The longest title and body of `POST /v1/owner-alert`, as a push shows them. */
const OWNER_ALERT_TITLE_LIMIT = 120;
const OWNER_ALERT_BODY_LIMIT = 600;

interface InterruptedDelivery {
  deliveryId: string;
  agentId: string;
  turnId: string | null;
  createdAt: string;
}

export type ResumeOutcome =
  | "resumed"
  | "would_resume"
  | "already_resumed"
  | "newer_work"
  | "turn_not_interrupted"
  | "unknown_agent"
  | "failed";

export function createServerAgentOperations(dependencies: ServerAgentOperationsDependencies) {
  /** One resume pass at a time, so two calls cannot both send the note for one delivery. */
  let resuming: Promise<ControlAnswer> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Sends a restart notice; a notice other than `none` ends by itself if no restart follows. */
  function announce(state: HostRestartState): void {
    const { announceRestart } = dependencies;
    if (!announceRestart) return;
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
    announceRestart(state);
    if (state === "none") return;
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined;
      announceRestart("none");
    }, RESTART_NOTICE_MS);
    noticeTimer.unref?.();
  }

  async function route(method: string | undefined, path: string, rawBody: string): Promise<ControlAnswer | null> {
    const message = path.match(/^\/v1\/agents\/([^/]+)\/message$/u);
    if (message?.[1] !== undefined) {
      if (method !== "POST") return failure(405, "method_not_allowed");
      return sendOperatorMessage(decodeURIComponent(message[1]), readFields(rawBody));
    }
    if (path === "/v1/drain" || path === "/v1/drain/cancel") {
      if (method !== "POST") return failure(405, "method_not_allowed");
      const { drain, endDrain } = dependencies;
      if (!drain || !endDrain) return failure(404, "not_found");
      if (path === "/v1/drain/cancel") {
        endDrain();
        announce("none");
        dependencies.log("Deploy drain cancelled.");
        return { status: 200, lines: { drain: "cancelled" } };
      }
      const requested = Number(readFields(rawBody).timeout ?? DRAIN_DEFAULT_SECONDS);
      const seconds = Number.isFinite(requested)
        ? Math.min(DRAIN_MAX_SECONDS, Math.max(0, requested))
        : DRAIN_DEFAULT_SECONDS;
      const startedAt = Date.now();
      announce("waiting");
      const running = await drain(seconds * 1_000);
      const waited = Math.round((Date.now() - startedAt) / 1_000);
      dependencies.log(`Deploy drain: ${running.length} turns still run after ${waited} s.`);
      return {
        status: 200,
        lines: {
          drained: running.length === 0 ? "yes" : "no",
          running: running.length,
          waited_seconds: waited,
          ...Object.fromEntries(
            running.slice(0, 20).map((turn, index) => [`turn${index + 1}`, `${turn.agentId} ${turn.turnId}`]),
          ),
        },
      };
    }
    if (path === "/v1/restart-notice") {
      if (method !== "POST") return failure(405, "method_not_allowed");
      if (!dependencies.announceRestart) return failure(404, "not_found");
      const state = readFields(rawBody).state ?? "restarting";
      if (state !== "restarting" && state !== "none") return failure(400, "invalid_state");
      announce(state);
      dependencies.log(`Restart notice sent: ${state}.`);
      return { status: 200, lines: { restart_notice: state } };
    }
    if (path === "/v1/cloud-backups/bench") {
      if (method !== "POST") return failure(405, "method_not_allowed");
      if (!dependencies.cloudBench) return failure(404, "not_found");
      try {
        return { status: 200, lines: { bench: await dependencies.cloudBench() } };
      } catch (error) {
        return failure(409, error instanceof Error ? error.message.slice(0, 200) : "not_started");
      }
    }
    if (path === "/v1/owner-alert") {
      if (method !== "POST") return failure(405, "method_not_allowed");
      if (!dependencies.alertOwner) return failure(404, "not_found");
      const fields = readFields(rawBody);
      const title = fields.title?.trim().slice(0, OWNER_ALERT_TITLE_LIMIT);
      const body = fields.text?.trim().slice(0, OWNER_ALERT_BODY_LIMIT);
      if (!title || !body) return failure(400, "title_and_text_required");
      dependencies.alertOwner(title, body);
      dependencies.log(`Owner alert sent: ${title}`);
      return { status: 200, lines: { alert: "sent" } };
    }
    if (path === "/v1/guardrails/failover") {
      if (method !== "POST") return failure(405, "method_not_allowed");
      return saveFailoverPolicy(rawBody);
    }
    if (path === "/v1/resume-interrupted") {
      if (method !== "POST") return failure(405, "method_not_allowed");
      if (resuming) return failure(409, "resume_running");
      const run = resumeInterrupted(readFields(rawBody));
      resuming = run;
      try {
        return await run;
      } finally {
        resuming = null;
      }
    }
    return null;
  }

  async function saveFailoverPolicy(rawBody: string): Promise<ControlAnswer> {
    const { guardrailsPolicy, saveGuardrailsPolicy } = dependencies;
    if (!guardrailsPolicy || !saveGuardrailsPolicy) return failure(404, "not_found");
    let body: unknown = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return failure(400, "json_required");
    }
    if (!isDynamicRecord(body)) return failure(400, "json_required");
    const current = guardrailsPolicy();
    // The same normalization as a saved file or a Trust page save: an invalid value keeps the default.
    const next = normalizeGuardrailPolicy({
      ...current,
      failover: {
        ...current.failover,
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.thresholdPercent === undefined ? {} : { thresholdPercent: body.thresholdPercent }),
        ...(body.tiers === undefined ? {} : { tiers: body.tiers }),
      },
    });
    if (!next) return failure(400, "invalid_policy");
    await saveGuardrailsPolicy(next);
    dependencies.log("The guardrails failover policy changed.");
    return {
      status: 200,
      lines: {
        enabled: String(next.failover.enabled),
        threshold_percent: next.failover.thresholdPercent,
        tiers: next.failover.tiers.join(","),
      },
    };
  }

  async function sendOperatorMessage(agentId: string, fields: Fields): Promise<ControlAnswer> {
    const text = fields.text?.trim() ?? "";
    if (!text) return failure(400, "text_required");
    if (text.length > INPUT_LIMITS.messageText) return failure(413, "text_too_long");
    if (!dependencies.agentIds().includes(agentId)) return failure(404, "unknown_agent");
    const clientMessageId = fields.clientMessageId;
    const receipt = await Effect.runPromise(
      dependencies
        .send(
          { agentId, text, ...(clientMessageId ? { clientMessageId } : {}) },
          fields.system ? "operator-note" : undefined,
        )
        .pipe(Effect.result),
    );
    if (Result.isFailure(receipt)) {
      dependencies.log(`Operator message to ${agentId} failed.`);
      return failure(400, "send_failed", errorMessage(receipt.failure.cause));
    }
    const delivery = receipt.success.deliveries.find((candidate) => candidate.recipientAgentId === agentId);
    dependencies.log(
      `Operator ${fields.system ? "note" : "message"} sent to ${agentId}: delivery ${delivery?.id ?? "none"}, ${delivery?.status ?? "unknown"}.`,
    );
    return {
      status: 200,
      lines: {
        agent: agentId,
        message_id: receipt.success.messageId,
        delivery_id: delivery?.id ?? null,
        delivery_status: delivery?.status ?? null,
        position: delivery?.position ?? null,
      },
    };
  }

  async function resumeInterrupted(fields: Fields): Promise<ControlAnswer> {
    const database = dependencies.database();
    const scope = fields.deliveryIds.length > 0 ? new Set(fields.deliveryIds) : dependencies.restartInterrupted();
    const interrupted = readInterruptedDeliveries(database).filter((delivery) => scope.has(delivery.deliveryId));
    // The newest cut-off delivery of each agent is the one its chat ended on.
    const latest = new Map<string, InterruptedDelivery>();
    for (const delivery of interrupted) {
      const known = latest.get(delivery.agentId);
      if (!known || delivery.createdAt > known.createdAt) latest.set(delivery.agentId, delivery);
    }
    const handled = await readMarker(dependencies.markerFile);
    const agents = new Set(dependencies.agentIds());
    const text = fields.text?.trim() || RESUME_NOTE;
    const lines: ControlAnswer["lines"] = {};
    const counts: Record<ResumeOutcome, number> = {
      resumed: 0,
      would_resume: 0,
      already_resumed: 0,
      newer_work: 0,
      turn_not_interrupted: 0,
      unknown_agent: 0,
      failed: 0,
    };
    let index = 0;
    for (const delivery of [...latest.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      let outcome: ResumeOutcome = resumeBlock(database, delivery, agents, handled) ?? "would_resume";
      if (outcome === "would_resume" && !fields.dryRun) {
        const sent = await Effect.runPromise(
          dependencies
            .send(
              { agentId: delivery.agentId, text, clientMessageId: `restart-resume:${delivery.deliveryId}` },
              "restart-resume",
            )
            .pipe(Effect.result),
        );
        if (Result.isFailure(sent)) outcome = "failed";
        else {
          outcome = "resumed";
          handled.push(delivery.deliveryId);
          await writeMarker(dependencies.markerFile, handled);
        }
      }
      counts[outcome] += 1;
      index += 1;
      lines[`agent${index}`] = `${delivery.agentId} delivery=${delivery.deliveryId} result=${outcome}`;
      dependencies.log(`Restart resume: ${delivery.agentId}, delivery ${delivery.deliveryId}: ${outcome}.`);
    }
    return {
      status: 200,
      lines: {
        ...(fields.dryRun ? { dry_run: "yes" } : {}),
        scope: fields.deliveryIds.length > 0 ? "listed" : "this-restart",
        found: latest.size,
        ...Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0)),
        ...lines,
      },
    };
  }

  /**
   * The resume of `POST /v1/resume-interrupted` for the deliveries that this start's boot recovery
   * ended, run once by the server itself, so no operator has to send it. The marker file keeps a
   * second run, or the route afterwards, from sending the note again.
   */
  async function resumeAfterRestart(): Promise<void> {
    if (dependencies.restartInterrupted().size === 0) return;
    if (resuming) return;
    const run = resumeInterrupted(readFields(""));
    resuming = run;
    try {
      const answer = await run;
      dependencies.log(`Restart resume ran by itself: ${answer.lines.resumed ?? 0} of ${answer.lines.found ?? 0}.`);
    } finally {
      resuming = null;
    }
  }

  return { route, resumeAfterRestart };
}

/** Why a cut-off delivery is not resumed, or null when it is. */
function resumeBlock(
  database: DatabaseSync,
  delivery: InterruptedDelivery,
  agents: ReadonlySet<string>,
  handled: readonly string[],
): Exclude<ResumeOutcome, "resumed" | "would_resume" | "failed"> | null {
  if (handled.includes(delivery.deliveryId)) return "already_resumed";
  if (!agents.has(delivery.agentId)) return "unknown_agent";
  // The agent worked after the restart: a later message reached it, so its chat did not end here.
  const newer = database
    .prepare("SELECT 1 FROM projection_deliveries WHERE recipient_agent_id = ? AND created_at > ? LIMIT 1")
    .get(delivery.agentId, delivery.createdAt);
  if (newer !== undefined) return "newer_work";
  if (delivery.turnId !== null) {
    // The thread of the cut-off turn ends with that turn, and recovery did not find it completed.
    const latest = database
      .prepare(
        `SELECT status FROM projection_turns
         WHERE thread_id = (SELECT thread_id FROM projection_turns WHERE turn_id = ?)
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(delivery.turnId);
    if (!isDynamicRecord(latest) || latest.status !== "interrupted") return "turn_not_interrupted";
  }
  return null;
}

/**
 * The deliveries that boot recovery ended as interrupted by a restart, in an agent's own chat: a
 * message of a channel, a task or an external chat runs in another thread and is not resumed here.
 */
function readInterruptedDeliveries(database: DatabaseSync): InterruptedDelivery[] {
  const rows = database
    .prepare(
      `SELECT d.delivery_id, d.recipient_agent_id, d.turn_id, d.created_at
       FROM projection_deliveries d
       JOIN projection_mailbox_messages m ON m.message_id = d.message_id
       WHERE d.status = 'interrupted' AND d.error = ?
         AND json_extract(m.message_json, '$.channelId') IS NULL
         AND json_extract(m.message_json, '$.taskId') IS NULL
         AND json_extract(m.message_json, '$.messaging') IS NULL`,
    )
    .all(RESTART_INTERRUPTION_REASON);
  return rows.flatMap((row) =>
    isDynamicRecord(row) && isString(row.delivery_id) && isString(row.recipient_agent_id) && isString(row.created_at)
      ? [
          {
            deliveryId: row.delivery_id,
            agentId: row.recipient_agent_id,
            turnId: isString(row.turn_id) ? row.turn_id : null,
            createdAt: row.created_at,
          },
        ]
      : [],
  );
}

interface Fields {
  text: string | undefined;
  /** The wait of `POST /v1/drain`, in seconds. */
  timeout: string | undefined;
  clientMessageId: string | undefined;
  deliveryIds: string[];
  dryRun: boolean;
  /** The operator message goes as a note from OpenBot, not as the owner. */
  system: boolean;
  /** The state of `POST /v1/restart-notice`. */
  state: string | undefined;
  /** The title of `POST /v1/owner-alert`; its body is `text`. */
  title: string | undefined;
}

/** A JSON object, or form fields (`delivery` may repeat). */
function readFields(rawBody: string): Fields {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith("{")) {
    let value = null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = null;
    }
    const record = isDynamicRecord(value) ? value : {};
    const ids = Array.isArray(record.deliveryIds) ? record.deliveryIds.filter(isString) : [];
    return {
      text: isString(record.text) ? record.text : undefined,
      timeout: typeof record.timeout === "number" || isString(record.timeout) ? String(record.timeout) : undefined,
      clientMessageId: isString(record.clientMessageId) ? record.clientMessageId : undefined,
      deliveryIds: ids,
      dryRun: record.dryRun === true,
      system: record.system === true,
      state: isString(record.state) ? record.state : undefined,
      title: isString(record.title) ? record.title : undefined,
    };
  }
  const form = new URLSearchParams(trimmed);
  return {
    text: form.get("text") ?? undefined,
    timeout: form.get("timeout") ?? undefined,
    clientMessageId: form.get("client_message_id") ?? undefined,
    deliveryIds: form.getAll("delivery").flatMap((value) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    dryRun: form.get("dry_run") === "1" || form.get("dry_run") === "yes",
    system: form.get("system") === "1" || form.get("system") === "yes" || form.get("system") === "true",
    state: form.get("state") ?? undefined,
    title: form.get("title") ?? undefined,
  };
}

async function readMarker(file: string): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return isDynamicRecord(value) && Array.isArray(value.resumed) ? value.resumed.filter(isString) : [];
  } catch {
    return [];
  }
}

async function writeMarker(file: string, handled: string[]): Promise<void> {
  const kept = handled.slice(-MARKER_LIMIT);
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify({ resumed: kept }), { mode: 0o600 });
  await rename(temporary, file);
}

function failure(status: number, error: string, message: string | null = null): ControlAnswer {
  return { status, lines: { error, message } };
}

function errorMessage(cause: unknown): string | null {
  return cause instanceof Error ? cause.message : null;
}
