/**
 * The human view of Motion content (the owner's view switch): for each object that is for the owner,
 * Atelier writes a full rewrite of the agent text in plain words and stores it in Motion
 * (`human.save`). Motion shows a toggle "Vista para personas" / "Vista para agentes" wherever an object
 * has one; agents read and write only the agent text, through the API and MCP.
 *
 * - Which objects: `ownerFacing` in `motion-human-text.ts`, plus the pages and tickets an agent links
 *   to the owner (`noteOwnerText`: owner-started answers, `message_owner`, held requests, previews,
 *   approvals and Needs you items), plus each object an agent or the owner asked for (`human_view` in
 *   Motion).
 * - Freshness: every three minutes the host reads `human.queue` from its cursor. An object whose agent
 *   text changed is written again only when the change is material (`materialChange`); a small edit
 *   only stamps the human version with the new revision. A version an agent wrote itself is kept until
 *   someone asks for a new one.
 * - Generation: the cheap owner-summary model path (`generateReviewText`, not important) with a strict
 *   prompt. Afterwards `missingFacts` checks that every key number, amount, date and decision of the
 *   original is still there; one more try names what is missing. A version that still misses something
 *   is saved all the same, and the log names the facts.
 * - At most `PER_TICK` objects per pass, one at a time, so the work stays cheap.
 *
 * The state (cursor, linked pages, fresh revisions, failures) is one small file.
 */
import { readFile } from "node:fs/promises";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { writeJsonFileAtomically } from "../../backend/atomic-json-file";
import {
  collectionOf,
  decodeHumanQueue,
  decodeHumanSource,
  fingerprint,
  type HumanCollection,
  type HumanKind,
  type HumanQueueItem,
  type HumanSource,
  humanViewPrompt,
  looksTechnical,
  materialChange,
  missingFacts,
  motionReferences,
  ownerFacing,
  parseHumanView,
  splitSections,
} from "./motion-human-text";

const TICK_MS = 3 * 60_000;
const PER_TICK = 8;
const QUEUE_LIMIT = 200;
/** The largest part of a text that one generation rewrites. */
const PART_CHARS = 12_000;
/** The longest agent text the host rewrites at all. */
const TEXT_LIMIT = 120_000;
const GENERATION_TIMEOUT_MS = 6 * 60_000;
const LINKED_MS = 30 * 86_400_000;
const LINKED_LIMIT = 2_000;
const FRESH_LIMIT = 5_000;
const FAILURE_LIMIT = 3;
/** Comments shorter than this need no human version unless they read technical. */
const SHORT_COMMENT = 400;

export interface MotionHumanViewsDependencies {
  /** One Motion operation as the owner (the gateway token with no agent headers). */
  call: (operation: string, body: DynamicRecord) => Promise<unknown>;
  /** One cheap generation, as the owner summaries use it. */
  generate: (input: { agentId: string; prompt: string; timeoutMs: number }) => Promise<string>;
  /** Some agent for the generation's model and usage: the first agent of the host. */
  agentId: () => string | null;
  language: () => string;
  available: () => boolean;
  stateFile: string;
  log: (message: string, details?: Record<string, string | number | readonly string[]>) => void;
  now?: () => number;
}

interface HumanState {
  version: 1;
  cursor: number;
  /** Page ids and issue keys an agent linked to the owner, with when. */
  linked: Record<string, number>;
  /** The issue keys that do not name a Motion page. */
  unknownKeys: Record<string, number>;
  /** Objects whose human version matches this agent revision (`kind:id` → rev). */
  fresh: Record<string, string>;
  failures: Record<string, number>;
}

/** What happened to one object. */
export interface HumanOutcome {
  kind: HumanKind;
  objectId: string;
  title: string;
  status: "generated" | "restamped" | "fresh" | "skipped" | "failed";
  missing?: string[];
  error?: string;
  model?: string;
}

const emptyState = (): HumanState => ({
  version: 1,
  cursor: 0,
  linked: {},
  unknownKeys: {},
  fresh: {},
  failures: {},
});

function numbers(value: unknown): Record<string, number> {
  if (!isDynamicRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => isNumber(entry[1])));
}

function decodeState(value: unknown): HumanState {
  if (!isDynamicRecord(value) || value.version !== 1) return emptyState();
  const fresh = isDynamicRecord(value.fresh)
    ? Object.fromEntries(Object.entries(value.fresh).filter((entry): entry is [string, string] => isString(entry[1])))
    : {};
  return {
    version: 1,
    cursor: isNumber(value.cursor) ? value.cursor : 0,
    linked: numbers(value.linked),
    unknownKeys: numbers(value.unknownKeys),
    fresh,
    failures: numbers(value.failures),
  };
}

/** Keeps the newest `limit` entries of a record whose values are times. */
function newest(record: Record<string, number>, limit: number, since = 0): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, at]) => at >= since)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit),
  );
}

/**
 * A stored human version as `human.get` answers it (the version may sit under `human`), or null when
 * there is none. `written` is a version an agent wrote itself.
 */
export function humanStored(
  value: unknown,
): { title: string; markdown: string; stale: boolean; written: boolean } | null {
  const record = isDynamicRecord(value) && isDynamicRecord(value.human) ? value.human : value;
  if (!isDynamicRecord(record)) return null;
  const markdown = isString(record.markdown) ? record.markdown : isString(record.text) ? record.text : "";
  if (!markdown.trim() || record.exists === false) return null;
  return {
    title: isString(record.title) ? record.title : "",
    markdown,
    stale: record.stale === true,
    written: record.origin === "written",
  };
}

const objectKey = (kind: HumanKind, objectId: string) => `${kind}:${objectId}`;

export class MotionHumanViews {
  readonly #deps: MotionHumanViewsDependencies;
  #state: HumanState = emptyState();
  #loaded: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  /** One generation at a time: the pass, a preview and the backfill wait for each other. */
  #chain: Promise<unknown> = Promise.resolve();
  #passing = false;
  #disposed = false;

  constructor(deps: MotionHumanViewsDependencies) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  load(): Promise<void> {
    this.#loaded ??= readFile(this.#deps.stateFile, "utf8")
      .then((text) => {
        this.#state = decodeState(JSON.parse(text));
      })
      .catch(() => {
        this.#state = emptyState();
      });
    return this.#loaded;
  }

  async #save(): Promise<void> {
    this.#state.linked = newest(this.#state.linked, LINKED_LIMIT, this.#now() - LINKED_MS);
    this.#state.unknownKeys = newest(this.#state.unknownKeys, LINKED_LIMIT, this.#now() - LINKED_MS);
    const fresh = Object.entries(this.#state.fresh);
    if (fresh.length > FRESH_LIMIT) this.#state.fresh = Object.fromEntries(fresh.slice(-FRESH_LIMIT));
    await Effect.runPromise(
      writeJsonFileAtomically(this.#deps.stateFile, this.#state, { createDirectory: true }),
    ).catch(() => this.#deps.log("Could not save the human views state."));
  }

  /** Starts the pass every three minutes, and once now. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.pass(), TICK_MS);
    this.#timer.unref?.();
    void this.pass();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** The page ids and issue keys linked to the owner (a copy). */
  linked(): ReadonlySet<string> {
    return new Set(Object.keys(this.#state.linked));
  }

  /**
   * A text that an agent sent to the owner: every Motion page and ticket it links becomes owner-facing,
   * and gets a human version on the next pass.
   */
  noteOwnerText(text: string): void {
    if (!text || (!text.includes("/p/") && !/[A-Z]-\d/u.test(text))) return;
    const { pageIds, issueKeys } = motionReferences(text);
    const at = this.#now();
    let added = false;
    for (const reference of [...pageIds, ...issueKeys.map((key) => key.toUpperCase())]) {
      if (this.#state.unknownKeys[reference] !== undefined) continue;
      if (this.#state.linked[reference] === undefined) added = true;
      this.#state.linked[reference] = at;
    }
    if (added) void this.load().then(() => this.#save());
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** One pass: the queue from the cursor, then the linked pages that have no fresh human version. */
  async pass(): Promise<HumanOutcome[]> {
    if (this.#passing || this.#disposed || !this.#deps.available()) return [];
    this.#passing = true;
    try {
      await this.load();
      return await this.#serial(() => this.#runPass());
    } catch (error) {
      this.#deps.log("The human views pass failed.", { error: error instanceof Error ? error.message : "failed" });
      return [];
    } finally {
      this.#passing = false;
    }
  }

  async #runPass(): Promise<HumanOutcome[]> {
    const outcomes: HumanOutcome[] = [];
    const answer = decodeHumanQueue(
      await this.#deps.call("human.queue", { since: this.#state.cursor, limit: QUEUE_LIMIT }),
    );
    const linked = this.linked();
    let cursor = answer.nextSince ?? this.#state.cursor;
    let budget = PER_TICK;
    for (const item of answer.items) {
      if (this.#disposed) break;
      if (!this.#wants(item, linked)) continue;
      if (budget === 0) {
        // The rest waits for the next pass: the cursor stops before the first object left.
        if (!item.human?.requested) cursor = Math.min(cursor, Math.max(0, item.changedAt - 1));
        continue;
      }
      const outcome = await this.#handle(item);
      outcomes.push(outcome);
      if (outcome.status === "generated" || outcome.status === "failed") budget -= 1;
    }
    for (const reference of Object.keys(this.#state.linked)) {
      if (budget === 0 || this.#disposed) break;
      if (this.#state.fresh[objectKey("page", reference)] !== undefined) continue;
      if (this.#failedTooOften(objectKey("page", reference))) continue;
      const outcome = await this.#handleReference(reference);
      if (outcome) {
        outcomes.push(outcome);
        if (outcome.status === "generated" || outcome.status === "failed") budget -= 1;
      }
    }
    this.#state.cursor = Math.max(this.#state.cursor, cursor);
    await this.#save();
    return outcomes;
  }

  #failedTooOften(key: string): boolean {
    return (this.#state.failures[key] ?? 0) >= FAILURE_LIMIT;
  }

  /** Whether the pass writes this object now. */
  #wants(item: HumanQueueItem, linked: ReadonlySet<string>): boolean {
    if (!ownerFacing(item, linked)) return false;
    const key = objectKey(item.kind, item.objectId);
    if (item.human?.requested) return true;
    if (this.#failedTooOften(key)) return false;
    if (item.human?.origin === "written") return false;
    if (item.human && item.human.sourceRev === item.rev) return false;
    return this.#state.fresh[key] !== item.rev;
  }

  /** A linked page or issue key: its page, written when it has no human version for its revision. */
  async #handleReference(reference: string): Promise<HumanOutcome | null> {
    const source = await this.#source("page", reference).catch(() => null);
    if (!source) {
      if (/^[A-Z][A-Z0-9]*-\d+$/u.test(reference)) {
        delete this.#state.linked[reference];
        this.#state.unknownKeys[reference] = this.#now();
      } else this.#state.failures[objectKey("page", reference)] = FAILURE_LIMIT;
      return null;
    }
    if (source.objectId !== reference) {
      this.#state.linked[source.objectId] = this.#state.linked[reference] ?? this.#now();
      this.#state.fresh[objectKey("page", reference)] = source.rev;
    }
    if (this.#state.fresh[objectKey("page", source.objectId)] === source.rev) return null;
    const stored = humanStored(
      await this.#deps.call("human.get", { kind: "page", object_id: source.objectId }).catch(() => null),
    );
    if (stored && (!stored.stale || stored.written)) {
      this.#state.fresh[objectKey("page", source.objectId)] = source.rev;
      return null;
    }
    return this.#write(source, null);
  }

  async #source(kind: HumanKind, objectId: string): Promise<HumanSource | null> {
    return decodeHumanSource(await this.#deps.call("human.source", { kind, object_id: objectId }));
  }

  async #handle(item: HumanQueueItem): Promise<HumanOutcome> {
    const base = { kind: item.kind, objectId: item.objectId, title: item.title };
    let source: HumanSource | null;
    try {
      source = await this.#source(item.kind, item.objectId);
    } catch (error) {
      return this.#failed(base, error);
    }
    if (!source) return { ...base, status: "skipped" };
    const key = objectKey(item.kind, item.objectId);
    if (item.kind === "comment" && !item.human?.requested && !this.#commentNeedsOne(source.text))
      return this.#fresh(key, source.rev, base, "skipped");
    if (item.human && !item.human.requested && !materialChange(item.human.fingerprint, source.title, source.text)) {
      await this.#deps.call("human.save", {
        kind: item.kind,
        object_id: item.objectId,
        markdown: "",
        source_rev: source.rev,
        fingerprint: fingerprint(source.title, source.text),
        keep: true,
      });
      return this.#fresh(key, source.rev, base, "restamped");
    }
    return this.#write(source, item);
  }

  #commentNeedsOne(text: string): boolean {
    return text.length >= SHORT_COMMENT || looksTechnical(text);
  }

  #fresh(key: string, rev: string, base: Omit<HumanOutcome, "status">, status: HumanOutcome["status"]): HumanOutcome {
    this.#state.fresh[key] = rev;
    delete this.#state.failures[key];
    return { ...base, status };
  }

  #failed(base: Omit<HumanOutcome, "status">, error: unknown): HumanOutcome {
    const key = objectKey(base.kind, base.objectId);
    this.#state.failures[key] = (this.#state.failures[key] ?? 0) + 1;
    const message = error instanceof Error ? error.message.slice(0, 200) : "failed";
    this.#deps.log("Could not write a human view.", { kind: base.kind, objectId: base.objectId, error: message });
    return { ...base, status: "failed", error: message };
  }

  /** Rewrites one object, checks its facts (one more try with what is missing) and saves it. */
  async #write(source: HumanSource, item: HumanQueueItem | null): Promise<HumanOutcome> {
    const base = { kind: source.kind, objectId: source.objectId, title: source.title };
    try {
      const view = await this.rewrite(source, item?.issueKey !== null && item?.issueKey !== undefined);
      if (!view) return this.#failed(base, new Error("The model gave no text."));
      await this.#deps.call("human.save", {
        kind: source.kind,
        object_id: source.objectId,
        title: view.title,
        markdown: view.markdown,
        source_rev: source.rev,
        fingerprint: fingerprint(source.title, source.text),
      });
      if (view.missing.length > 0)
        this.#deps.log("A human view misses facts of the original after a second try.", {
          objectId: source.objectId,
          missing: view.missing.slice(0, 20),
        });
      const outcome = this.#fresh(objectKey(source.kind, source.objectId), source.rev, base, "generated");
      return { ...outcome, ...(view.missing.length > 0 ? { missing: view.missing } : {}) };
    } catch (error) {
      return this.#failed(base, error);
    }
  }

  /**
   * The human version of an agent text: each part rewritten under the strict prompt, then checked
   * for dropped facts; when one is missing, the parts are written once more with the list.
   */
  async rewrite(
    source: Pick<HumanSource, "kind" | "title" | "text" | "path">,
    isTicket: boolean,
  ): Promise<{ title: string | null; markdown: string; missing: string[] } | null> {
    const agentId = this.#deps.agentId();
    if (!agentId) throw new Error("No agent to run the generation.");
    const text = source.text.slice(0, TEXT_LIMIT);
    const parts = splitSections(text, PART_CHARS);
    const attempt = async (missing: readonly string[]) => {
      const written: string[] = [];
      let title: string | null = null;
      for (const [index, part] of parts.entries()) {
        const prompt = humanViewPrompt({
          language: this.#deps.language(),
          kind: source.kind,
          title: source.title,
          text: part,
          path: source.path,
          isTicket,
          part: { index, count: parts.length },
          missing: missing.length > 0 ? missing : undefined,
        });
        const answer = await this.#deps.generate({ agentId, prompt, timeoutMs: GENERATION_TIMEOUT_MS });
        const parsed = parseHumanView(answer);
        if (!parsed) return null;
        if (index === 0) title = parsed.title;
        written.push(index === 0 || !parsed.title ? parsed.markdown : `# ${parsed.title}\n\n${parsed.markdown}`);
      }
      const markdown = written.join("\n\n");
      return { title, markdown, missing: missingFacts(`${source.title}\n${text}`, `${title ?? ""}\n${markdown}`) };
    };
    const first = await attempt([]);
    if (!first || first.missing.length === 0) return first;
    const second = await attempt(first.missing);
    if (!second) return first;
    return second.missing.length <= first.missing.length ? second : first;
  }

  /**
   * The human version for the chat preview of a Motion page link: the stored one when it is fresh,
   * otherwise one written now (and saved). Null when the page cannot be read.
   */
  async preview(url: string): Promise<{ title: string; markdown: string } | null> {
    if (!this.#deps.available()) return null;
    await this.load();
    this.noteOwnerText(url);
    const { pageIds } = motionReferences(url);
    const pageId = pageIds[0];
    if (!pageId) return null;
    const stored = humanStored(
      await this.#deps.call("human.get", { kind: "page", object_id: pageId }).catch(() => null),
    );
    if (stored && (!stored.stale || stored.written)) return { title: stored.title, markdown: stored.markdown };
    return this.#serial(async () => {
      const source = await this.#source("page", pageId);
      if (!source) return null;
      const outcome = await this.#write(source, null);
      if (outcome.status !== "generated") return null;
      const saved = humanStored(await this.#deps.call("human.get", { kind: "page", object_id: pageId }));
      return saved ? { title: saved.title || source.title, markdown: saved.markdown } : null;
    });
  }

  /**
   * The backfill of one workspace: Reportes changed in the last `days`, every page of Decisiones,
   * Manual del CSO, Inicio and Equipo, and the dossiers linked to the owner in the last `days`
   * (`seedLinks` gives the texts the agents sent the owner). One object at a time.
   */
  async backfill(input: {
    workspaceName: string;
    days: number;
    seedLinks: readonly string[];
    progress: (outcome: HumanOutcome, done: number, total: number) => void;
  }): Promise<{ selected: number; outcomes: HumanOutcome[] }> {
    await this.load();
    for (const text of input.seedLinks) this.noteOwnerText(text);
    const since = this.#now() - input.days * 86_400_000;
    const items: HumanQueueItem[] = [];
    let cursor = 0;
    for (let page = 0; page < 200; page += 1) {
      const answer = decodeHumanQueue(await this.#deps.call("human.queue", { since: cursor, limit: 500 }));
      items.push(...answer.items);
      if (answer.items.length === 0 || answer.nextSince === null || answer.nextSince <= cursor) break;
      cursor = answer.nextSince;
    }
    await this.#resolveLinkedKeys();
    const linked = this.linked();
    const wanted = new Map<string, HumanQueueItem>();
    const name = input.workspaceName.trim().toLowerCase();
    for (const item of items) {
      if (item.workspaceName.trim().toLowerCase() !== name || item.kind === "comment") continue;
      const collection: HumanCollection | null = collectionOf(item);
      const isLinked = linked.has(item.pageId) || (item.issueKey !== null && linked.has(item.issueKey.toUpperCase()));
      const take =
        collection === "reportes" ? item.changedAt >= since : collection === "dossier" ? isLinked : collection !== null;
      if (take) wanted.set(objectKey(item.kind, item.objectId), item);
    }
    const selected = [...wanted.values()];
    const outcomes: HumanOutcome[] = [];
    for (const item of selected) {
      if (this.#disposed) break;
      const outcome = await this.#serial(() =>
        item.human?.origin === "written" && !item.human.requested
          ? Promise.resolve<HumanOutcome>({
              kind: item.kind,
              objectId: item.objectId,
              title: item.title,
              status: "skipped",
            })
          : item.human && item.human.sourceRev === item.rev && !item.human.requested
            ? Promise.resolve<HumanOutcome>({
                kind: item.kind,
                objectId: item.objectId,
                title: item.title,
                status: "fresh",
              })
            : this.#handle(item),
      );
      outcomes.push(outcome);
      input.progress(outcome, outcomes.length, selected.length);
      await this.#save();
    }
    return { selected: selected.length, outcomes };
  }

  /** Turns each linked issue key into its page id, so a dossier ticket linked by key counts. */
  async #resolveLinkedKeys(): Promise<void> {
    for (const reference of Object.keys(this.#state.linked)) {
      if (!/^[A-Z][A-Z0-9]*-\d+$/u.test(reference)) continue;
      const source = await this.#source("page", reference).catch(() => null);
      if (source) this.#state.linked[source.objectId] = this.#state.linked[reference] ?? this.#now();
      else {
        delete this.#state.linked[reference];
        this.#state.unknownKeys[reference] = this.#now();
      }
    }
  }
}
