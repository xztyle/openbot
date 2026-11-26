/**
 * The operator's backfill of human views for one Motion workspace (`POST /v1/motion/human-backfill`
 * of the control socket): it reads the Motion links that agents sent the owner in the last `days`
 * from the owners' chats, then lets `MotionHumanViews.backfill` write the human versions of
 * Reportes of those days, Decisiones, Manual del CSO, Inicio, Equipo and the linked dossiers. It runs
 * in the background, one object at a time; the report file under userData shows the progress and,
 * at the end, every object with its outcome and the facts a version still misses. With `regenerate`, it
 * writes every version the host generated before again under the current rules ("*": every workspace).
 */
import { writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { isString } from "@openbot/contracts/runtime-values";
import type { HumanOutcome, MotionHumanViews } from "./motion-human-views";

const DAYS_DEFAULT = 7;
const DAYS_MAX = 90;
const LINK_ROWS = 20_000;

export interface HumanBackfillReport {
  workspaceName: string;
  days: number;
  /** Every generated version written again under the current rules. */
  regenerate: boolean;
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  selected: number;
  done: number;
  counts: Partial<Record<HumanOutcome["status"], number>>;
  outcomes: HumanOutcome[];
  error: string | null;
  file: string;
}

export interface HumanBackfillOptions {
  human: MotionHumanViews;
  database: () => DatabaseSync;
  /** The agents' own chats with the owner. */
  ownerThreads: () => readonly string[];
  reportDirectory: string;
  log: (message: string) => void;
}

/** The texts with Motion links that agents wrote in the owner's chats since `sinceIso`. */
export function ownerLinkTexts(database: DatabaseSync, threads: readonly string[], sinceIso: string): string[] {
  if (threads.length === 0) return [];
  const placeholders = threads.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT json_extract(message_json, '$.text') AS text FROM projection_thread_messages
       WHERE thread_id IN (${placeholders}) AND author = 'assistant' AND created_at >= ?
         AND (json_extract(message_json, '$.text') LIKE '%/p/%' OR json_extract(message_json, '$.text') GLOB '*[A-Z]-[0-9]*')
       ORDER BY created_at DESC LIMIT ${LINK_ROWS}`,
    )
    .all(...threads, sinceIso);
  return rows.flatMap((row) => (isString(row.text) ? [row.text] : []));
}

export function createHumanBackfill(options: HumanBackfillOptions) {
  let report: HumanBackfillReport | null = null;
  const write = async () => {
    if (report)
      await writeFile(report.file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
  };
  return {
    status: (): HumanBackfillReport | null => report,
    start(input: { workspaceName: string; days?: number | undefined; regenerate?: boolean }): HumanBackfillReport {
      if (report?.state === "running") return report;
      const days = Math.min(Math.max(Math.round(input.days ?? DAYS_DEFAULT), 1), DAYS_MAX);
      const startedAt = new Date().toISOString();
      const file = `${options.reportDirectory}/motion-human-backfill-${startedAt.replace(/[:.]/gu, "-")}.json`;
      const current: HumanBackfillReport = {
        workspaceName: input.workspaceName,
        days,
        regenerate: input.regenerate === true,
        state: "running",
        startedAt,
        finishedAt: null,
        selected: 0,
        done: 0,
        counts: {},
        outcomes: [],
        error: null,
        file,
      };
      report = current;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      void (async () => {
        try {
          const seedLinks = input.regenerate ? [] : ownerLinkTexts(options.database(), options.ownerThreads(), since);
          options.log(`Human views backfill of ${input.workspaceName}: ${seedLinks.length} owner messages with links.`);
          const result = await options.human.backfill({
            workspaceName: input.workspaceName,
            days,
            seedLinks,
            regenerate: input.regenerate === true,
            progress: (outcome, done, total) => {
              current.selected = total;
              current.done = done;
              current.outcomes.push(outcome);
              current.counts[outcome.status] = (current.counts[outcome.status] ?? 0) + 1;
              void write();
            },
          });
          current.selected = result.selected;
          current.state = "done";
        } catch (error) {
          current.state = "failed";
          current.error = error instanceof Error ? error.message.slice(0, 300) : "failed";
        }
        current.finishedAt = new Date().toISOString();
        options.log(`Human views backfill of ${input.workspaceName} ${current.state}: ${current.done} objects.`);
        await write();
      })();
      void write();
      return current;
    },
  };
}
