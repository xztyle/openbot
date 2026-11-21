/**
 * The events that the Motion board sends about its tickets (Motion's `docs/agent-events.md`): the
 * request check and the shape this host reads. Motion signs `<timestamp>.<body>` with HMAC-SHA256 and
 * the shared secret, in `x-motion-signature: sha256=<hex>`, with `x-motion-timestamp` in seconds.
 * Everything here is data from outside the host: no field is ever read as an instruction.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

/** A request older or newer than this is a replay, whatever its signature. */
export const MOTION_EVENT_MAX_SKEW_MS = 5 * 60_000;
/** The largest event body this host reads. */
export const MOTION_EVENT_BODY_LIMIT = 64 * 1024;

export const MOTION_EVENT_TYPES = [
  "issue.assigned",
  "issue.unassigned",
  "issue.status_changed",
  "comment.mentioned",
  "issue.due_soon",
  "issue.overdue",
  "issue.waiting_on_person",
] as const;
export type MotionEventType = (typeof MOTION_EVENT_TYPES)[number];

export interface MotionPerson {
  id: string;
  name: string;
  kind: "person" | "agent";
  /** The agent's key on this host (its agent id), for an agent. */
  agentKey: string | null;
  role: string | null;
}

export interface MotionIssue {
  id: string;
  key: string;
  title: string;
  url: string;
  statusName: string | null;
  statusCategory: "todo" | "in_progress" | "done" | null;
  due: string | null;
  assignees: MotionPerson[];
}

export interface MotionEvent {
  id: string;
  type: MotionEventType;
  at: number;
  workspaceName: string;
  issue: MotionIssue;
  actor: MotionPerson | null;
  recipients: MotionPerson[];
  /** `issue.status_changed`: the status before. */
  from: string | null;
  /** `issue.due_soon`: the warning window, and the minutes left. */
  hoursBefore: number | null;
  minutesLeft: number | null;
  /** `issue.overdue`: whole days past the due time. */
  daysOverdue: number | null;
  /** `comment.mentioned`: the comment text (at most 600 characters). */
  comment: string | null;
}

/** Why a request is refused. Safe to log: it names no secret and no body. */
export type MotionEventRefusal = "signature" | "stale" | "body";

/** Checks the timestamp and the signature of a request in constant time. */
export function verifyMotionSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  body: Buffer,
  nowMs = Date.now(),
): MotionEventRefusal | null {
  if (!timestamp || !/^\d{1,12}$/u.test(timestamp)) return "stale";
  if (Math.abs(nowMs - Number(timestamp) * 1000) > MOTION_EVENT_MAX_SKEW_MS) return "stale";
  const match = /^sha256=([0-9a-f]{64})$/iu.exec(signature ?? "");
  if (!match?.[1]) return "signature";
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? null : "signature";
}

/** The signature header Motion sends, for the end-to-end script and tests. */
export function signMotionEvent(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function text(value: unknown, limit: number): string | null {
  return isString(value) ? value.slice(0, limit) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function person(value: unknown): MotionPerson | null {
  if (!isDynamicRecord(value) || !isString(value.id)) return null;
  return {
    id: value.id.slice(0, 64),
    name: text(value.name, 120) ?? "",
    kind: value.kind === "agent" ? "agent" : "person",
    agentKey: text(value.agent_key, 128),
    role: text(value.role, 16),
  };
}

function people(value: unknown): MotionPerson[] {
  return Array.isArray(value) ? value.slice(0, 50).flatMap((entry) => person(entry) ?? []) : [];
}

function category(value: unknown): MotionIssue["statusCategory"] {
  return value === "todo" || value === "in_progress" || value === "done" ? value : null;
}

function issue(value: unknown): MotionIssue | null {
  if (!isDynamicRecord(value) || !isString(value.id) || !isString(value.url)) return null;
  if (!/^https?:\/\//u.test(value.url)) return null;
  const status = isDynamicRecord(value.status) ? value.status : {};
  return {
    id: value.id.slice(0, 64),
    key: text(value.key, 64) ?? "",
    title: text(value.title, 240) ?? "",
    url: value.url.slice(0, 2_000),
    statusName: text(status.name, 80),
    statusCategory: category(status.category),
    due: text(value.due, 32),
    assignees: people(value.assignees),
  };
}

/** The event of a verified body, or null when it is not one this host knows. */
export function decodeMotionEvent(value: unknown): MotionEvent | null {
  if (!isDynamicRecord(value) || !isString(value.id) || value.id.length > 200) return null;
  const type = MOTION_EVENT_TYPES.find((candidate) => candidate === value.type);
  const decoded = issue(value.issue);
  if (!type || !decoded) return null;
  const workspace = isDynamicRecord(value.workspace) ? value.workspace : {};
  const comment = isDynamicRecord(value.comment) ? value.comment : {};
  return {
    id: value.id,
    type,
    at: count(value.at) ?? Date.now(),
    workspaceName: text(workspace.name, 120) ?? "",
    issue: decoded,
    actor: person(value.actor),
    recipients: people(value.recipients),
    from: text(value.from, 80),
    hoursBefore: count(value.hours_before),
    minutesLeft: count(value.minutes_left),
    daysOverdue: count(value.days_overdue),
    comment: text(comment.body, 600),
  };
}
