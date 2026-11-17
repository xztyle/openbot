// Optional connection-report-v1 rpc operation, behind `fork-host-v1`.
//
// What it carries, recorded here because freezing it makes it permanent: after a client connects
// again, it tells the host why its last connection ended, so the host log shows each recovery that
// only the client saw, such as a path that stopped delivering data while both ends read it as
// connected. The payload has only fixed words and numbers: a reason from `CONNECTION_REPORT_REASONS`
// or a fixed failure reference, counts, a duration and the candidate types of the path. It has no
// ID, address, name or text. The host answers with status 204. A host that does not know the
// operation answers with an `unsupported_operation` error, which the client ignores.
import { isDynamicRecord, isNumber, isString } from "../runtime-values";

/** The rpc `operation` of the report. Each other request uses `http.request`. */
export const CONNECTION_REPORT_OPERATION = "connection.report";

/** The checks of the client that can find a dead connection that the browser still reads as connected. */
export const CONNECTION_REPORT_REASONS = [
  /** Nothing arrived for a while, and the compatibility probe got no answer. */
  "heartbeat-timeout",
  /** A read got no answer, and the probe that followed got no answer either. */
  "read-timeout",
  /** A probe of the consumer, such as on a return to the tab, got no answer. */
  "probe-timeout",
  /** A turn sent no event, and a read showed that the host had progressed: the event stream was lost. */
  "event-stall",
] as const;

export type ConnectionReportReason = (typeof CONNECTION_REPORT_REASONS)[number];

export interface ConnectionReport {
  /** A reason above, or a fixed failure reference such as `webrtc/ice/failed`. */
  reason: string;
  /** The recoveries for this reason since the page or app started. */
  count: number;
  /** All recoveries since the page or app started. */
  total: number;
  /** The time from the end of the old connection to this report. */
  offlineMs: number;
  /** The candidate types of the old path, such as `relay/udp -> host/udp`, or null. */
  route: string | null;
}

const REASON = /^[a-z0-9][a-z0-9_./-]{0,59}$/u;
const ROUTE = /^[a-z]{1,8}\/[a-z]{1,8} -> [a-z]{1,8}\/[a-z]{1,8}$/u;
const COUNT_LIMIT = 1_000_000;
const OFFLINE_LIMIT_MS = 7 * 24 * 60 * 60_000;

function count(value: unknown, limit: number): number | null {
  return isNumber(value) && Number.isInteger(value) && value >= 0 && value <= limit ? value : null;
}

/** The payload of the operation. Null when a field is not one of the fixed forms. */
export function decodeConnectionReport(value: unknown): ConnectionReport | null {
  if (!isDynamicRecord(value) || !isString(value.reason) || !REASON.test(value.reason)) return null;
  const reportCount = count(value.count, COUNT_LIMIT);
  const total = count(value.total, COUNT_LIMIT);
  const offlineMs = count(value.offlineMs, OFFLINE_LIMIT_MS);
  if (reportCount === null || total === null || offlineMs === null) return null;
  const route =
    value.route === null ? null : isString(value.route) && ROUTE.test(value.route) ? value.route : undefined;
  if (route === undefined) return null;
  return { reason: value.reason, count: reportCount, total, offlineMs, route };
}

/** The reason of a failure for the report: a check above, or a fixed reference, or `other`. */
export function connectionReportReason(reason: string | null | undefined): string {
  return reason && REASON.test(reason) ? reason : "other";
}
