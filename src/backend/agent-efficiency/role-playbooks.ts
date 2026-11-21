import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  agentHasPlaybookRole,
  type DecidePlaybookProposalInput,
  type ImportRolePlaybookInput,
  isPlaybookSlug,
  PLAYBOOK_CONTENT_LIMIT,
  PLAYBOOK_LIMIT,
  type PlaybookCandidate,
  type PlaybookProposal,
  type RolePlaybook,
  type RolePlaybooksSnapshot,
  type SaveRolePlaybookInput,
} from "@openbot/contracts/agent-efficiency";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { isMissingFileError } from "../file-errors";
import { isPathInside } from "../path-containment";
import { JsonStore } from "./json-store";

const logger = createOpenBotLogger("role-playbooks");

/** The file of the playbooks and the proposals, in the user data folder. */
export const ROLE_PLAYBOOKS_FILE = "role-playbooks-v1.json";
/** The skill folders of an agent workspace that a playbook writes. Each provider reads one of them. */
const SKILL_FOLDERS = [".agents/skills", ".claude/skills"] as const;
/** Marks a skill folder that a playbook wrote, so a sync never touches a folder the agent or a person made. */
const MARKER = ".openbot-playbook.json";
/** The proposals kept after a decision, newest first. Pending ones are always kept. */
const DECIDED_PROPOSALS_KEPT = 100;

interface StoredPlaybook {
  id: string;
  slug: string;
  roles: string[];
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface StoredPlaybooks {
  version: 1;
  playbooks: StoredPlaybook[];
  proposals: PlaybookProposal[];
}

const EMPTY: StoredPlaybooks = { version: 1, playbooks: [], proposals: [] };

function decodeStored(value: unknown): StoredPlaybooks | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  const playbooks = Array.isArray(value.playbooks)
    ? value.playbooks.filter(
        (item): item is StoredPlaybook =>
          isDynamicRecord(item) &&
          isString(item.id) &&
          isPlaybookSlug(item.slug) &&
          Array.isArray(item.roles) &&
          item.roles.every(isString) &&
          isString(item.content) &&
          typeof item.version === "number" &&
          isString(item.createdAt) &&
          isString(item.updatedAt),
      )
    : [];
  const proposals = Array.isArray(value.proposals)
    ? value.proposals.filter(
        (item): item is PlaybookProposal =>
          isDynamicRecord(item) &&
          isString(item.id) &&
          isString(item.playbookId) &&
          isString(item.agentId) &&
          isString(item.content) &&
          isString(item.note) &&
          (item.state === "pending" || item.state === "approved" || item.state === "dismissed") &&
          isString(item.createdAt),
      )
    : [];
  return { version: 1, playbooks, proposals };
}

/** The `name` of a SKILL.md front matter, or null. */
function frontmatterName(content: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1];
  const name = block ? /^name:\s*["']?([^"'\r\n]+)["']?\s*$/mu.exec(block)?.[1] : undefined;
  return name?.trim() ?? null;
}

/** Throws unless the content is a SKILL.md for `slug`: front matter whose `name` is the slug, and a description. */
function requireSkill(slug: string, content: string): void {
  if (content.length > PLAYBOOK_CONTENT_LIMIT) throw new Error("The playbook is too long.");
  if (frontmatterName(content) !== slug)
    throw new Error(`The SKILL.md must start with front matter whose name is ${slug}.`);
  if (!/^description:\s*\S/mu.test(/^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1] ?? ""))
    throw new Error("The SKILL.md front matter needs a description.");
}

/** The role after the last dash of an agent name, as in "PUO Abogados – Creativo de Anuncios". */
function nameRole(name: string): string | null {
  const parts = name.split(/\s[–—-]\s/u);
  const last = parts.length > 1 ? parts.at(-1)?.trim() : undefined;
  return last && last.length <= 80 ? last : null;
}

export interface RolePlaybooksOptions {
  path: string;
  agents(): readonly AgentSummary[];
  /** Tells the owner's clients that a proposal waits. */
  changed?(): void;
}

/**
 * The playbooks of roles: one skill each, which every agent of its roles gets in its workspace, now
 * and when it is made or gets the role later. A playbook writes only the folders it marked; a folder
 * of the same name that the agent or a person made stays, unless its SKILL.md is the playbook's own
 * text, which the playbook then adopts. An agent proposes a change; only the owner applies it.
 */
export class RolePlaybooks {
  readonly #options: RolePlaybooksOptions;
  readonly #store: JsonStore<StoredPlaybooks>;
  #syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** The agent ids that have each playbook now, from the last sync. */
  #installed = new Map<string, Set<string>>();

  constructor(options: RolePlaybooksOptions) {
    this.#options = options;
    this.#store = new JsonStore(options.path, EMPTY, decodeStored);
  }

  readonly snapshot = Effect.fn("RolePlaybooks.snapshot")(function* (this: RolePlaybooks) {
    const stored = yield* this.#store.load();
    const candidates = yield* Effect.promise(() => this.#candidates(stored));
    return this.#view(stored, candidates);
  });

  #view(stored: StoredPlaybooks, candidates: PlaybookCandidate[]): RolePlaybooksSnapshot {
    const agents = this.#options.agents();
    const playbooks: RolePlaybook[] = stored.playbooks.map((playbook) => ({
      id: playbook.id,
      slug: playbook.slug,
      roles: playbook.roles,
      content: playbook.content,
      version: playbook.version,
      updatedAt: playbook.updatedAt,
      agentIds: agents.filter((agent) => agentHasPlaybookRole(agent, playbook.roles)).map((agent) => agent.id),
    }));
    return {
      playbooks,
      proposals: stored.proposals.filter((proposal) => proposal.state === "pending").slice(0, 500),
      candidates,
    };
  }

  readonly save = Effect.fn("RolePlaybooks.save")(function* (this: RolePlaybooks, input: SaveRolePlaybookInput) {
    requireSkill(input.slug, input.content);
    const now = new Date().toISOString();
    yield* this.#store.update((stored) => {
      const existing = input.id ? stored.playbooks.find((playbook) => playbook.id === input.id) : undefined;
      if (input.id && !existing) throw new Error("The playbook does not exist.");
      if (stored.playbooks.some((playbook) => playbook.slug === input.slug && playbook.id !== existing?.id))
        throw new Error(`A playbook named ${input.slug} exists already.`);
      if (!existing && stored.playbooks.length >= PLAYBOOK_LIMIT) throw new Error("There are too many playbooks.");
      const next: StoredPlaybook = existing
        ? {
            ...existing,
            slug: input.slug,
            roles: input.roles,
            content: input.content,
            version: existing.content === input.content ? existing.version : existing.version + 1,
            updatedAt: now,
          }
        : {
            id: randomUUID(),
            slug: input.slug,
            roles: input.roles,
            content: input.content,
            version: 1,
            createdAt: now,
            updatedAt: now,
          };
      return {
        ...stored,
        playbooks: existing
          ? stored.playbooks.map((playbook) => (playbook.id === existing.id ? next : playbook))
          : [...stored.playbooks, next],
      };
    });
    yield* this.sync();
    return yield* this.snapshot();
  });

  /** Makes a playbook from the skill of that name in an agent's workspace. */
  readonly importFromAgent = Effect.fn("RolePlaybooks.importFromAgent")(function* (
    this: RolePlaybooks,
    input: ImportRolePlaybookInput,
  ) {
    const agent = this.#options.agents().find((candidate) => candidate.id === input.agentId);
    if (!agent) throw new Error("The agent does not exist.");
    const content = yield* Effect.promise(() => readWorkspaceSkill(agent.workspacePath, input.slug));
    if (content === null) throw new Error(`${agent.name} has no skill named ${input.slug}.`);
    return yield* this.save({ slug: input.slug, roles: input.roles, content });
  });

  readonly remove = Effect.fn("RolePlaybooks.remove")(function* (this: RolePlaybooks, id: string) {
    const stored = yield* this.#store.load();
    const playbook = stored.playbooks.find((candidate) => candidate.id === id);
    if (!playbook) throw new Error("The playbook does not exist.");
    yield* this.#store.update((current) => ({
      ...current,
      playbooks: current.playbooks.filter((candidate) => candidate.id !== id),
      proposals: current.proposals.filter((proposal) => proposal.playbookId !== id),
    }));
    // The marked folders go; an agent that made its own copy keeps it.
    yield* Effect.promise(async () => {
      for (const agent of this.#options.agents()) await removeMarked(agent.workspacePath, playbook.slug, playbook.id);
    });
    this.#installed.delete(id);
    return yield* this.snapshot();
  });

  /** An agent's proposal for a playbook it has. Answers why it is refused, or null. */
  readonly propose = Effect.fn("RolePlaybooks.propose")(function* (
    this: RolePlaybooks,
    agentId: string,
    slug: string,
    content: string,
    note: string,
  ) {
    const stored = yield* this.#store.load();
    const agent = this.#options.agents().find((candidate) => candidate.id === agentId);
    const playbook = stored.playbooks.find((candidate) => candidate.slug === slug);
    if (!agent || !playbook || !agentHasPlaybookRole(agent, playbook.roles))
      return `You have no role playbook named ${slug}. Only a playbook that Atelier installed for your role can be proposed.`;
    try {
      requireSkill(slug, content);
    } catch (error) {
      return error instanceof Error ? error.message : "The SKILL.md is not valid.";
    }
    if (content === playbook.content) return "The content is the same as the current playbook.";
    if (
      stored.proposals.some(
        (proposal) =>
          proposal.state === "pending" && proposal.agentId === agentId && proposal.playbookId === playbook.id,
      )
    )
      return "You already have a proposal for this playbook that waits for the owner.";
    yield* this.#store.update((current) => ({
      ...current,
      proposals: [
        {
          id: randomUUID(),
          playbookId: playbook.id,
          agentId,
          content,
          note: note.trim().slice(0, 600),
          state: "pending",
          createdAt: new Date().toISOString(),
        },
        ...current.proposals,
      ],
    }));
    this.#options.changed?.();
    return null;
  });

  readonly decide = Effect.fn("RolePlaybooks.decide")(function* (
    this: RolePlaybooks,
    input: DecidePlaybookProposalInput,
  ) {
    const stored = yield* this.#store.load();
    const proposal = stored.proposals.find((candidate) => candidate.id === input.proposalId);
    if (proposal?.state !== "pending") throw new Error("The proposal does not wait any more.");
    const playbook = stored.playbooks.find((candidate) => candidate.id === proposal.playbookId);
    const now = new Date().toISOString();
    yield* this.#store.update((current) => {
      const decided = current.proposals.map((candidate) =>
        candidate.id === proposal.id
          ? { ...candidate, state: input.decision === "approve" ? ("approved" as const) : ("dismissed" as const) }
          : candidate,
      );
      const pending = decided.filter((candidate) => candidate.state === "pending");
      const done = decided.filter((candidate) => candidate.state !== "pending").slice(0, DECIDED_PROPOSALS_KEPT);
      return {
        ...current,
        proposals: [...pending, ...done],
        playbooks:
          input.decision === "approve" && playbook
            ? current.playbooks.map((candidate) =>
                candidate.id === playbook.id
                  ? { ...candidate, content: proposal.content, version: candidate.version + 1, updatedAt: now }
                  : candidate,
              )
            : current.playbooks,
      };
    });
    if (input.decision === "approve") yield* this.sync();
    return yield* this.snapshot();
  });

  /** Syncs a moment after the agents change, so a burst of changes writes once. */
  scheduleSync(): void {
    if (this.#syncTimer !== null) return;
    this.#syncTimer = setTimeout(() => {
      this.#syncTimer = null;
      Effect.runFork(this.sync());
    }, 2_000);
    this.#syncTimer.unref?.();
  }

  /** Writes each playbook to the agents of its roles and takes it from the agents that left them. */
  readonly sync = Effect.fn("RolePlaybooks.sync")(function* (this: RolePlaybooks) {
    const stored = yield* this.#store.load();
    if (stored.playbooks.length === 0 && this.#installed.size === 0) return;
    const agents = this.#options.agents();
    yield* Effect.promise(async () => {
      for (const playbook of stored.playbooks) {
        const installed = new Set<string>();
        for (const agent of agents) {
          try {
            if (agentHasPlaybookRole(agent, playbook.roles)) {
              if (await writePlaybook(agent.workspacePath, playbook)) installed.add(agent.id);
            } else await removeMarked(agent.workspacePath, playbook.slug, playbook.id);
          } catch (error) {
            logger.warn("Could not sync a playbook to an agent workspace.", { agentId: agent.id, error });
          }
        }
        this.#installed.set(playbook.id, installed);
      }
    });
  });

  dispose(): void {
    if (this.#syncTimer !== null) clearTimeout(this.#syncTimer);
    this.#syncTimer = null;
  }

  /** The skills that two or more agents have and no playbook owns. */
  async #candidates(stored: StoredPlaybooks): Promise<PlaybookCandidate[]> {
    const owned = new Set(stored.playbooks.map((playbook) => playbook.slug));
    const holders = new Map<string, string[]>();
    for (const agent of this.#options.agents()) {
      const names = new Set<string>();
      for (const folder of SKILL_FOLDERS) {
        try {
          for (const entry of await readdir(join(agent.workspacePath, folder), { withFileTypes: true }))
            if (entry.isDirectory() && isPlaybookSlug(entry.name) && !entry.name.startsWith("openbot-"))
              names.add(entry.name);
        } catch {
          // A workspace without the folder has no skills there.
        }
      }
      for (const name of names) if (!owned.has(name)) holders.set(name, [...(holders.get(name) ?? []), agent.id]);
    }
    const byId = new Map(this.#options.agents().map((agent) => [agent.id, agent] as const));
    return [...holders.entries()]
      .filter(([, agentIds]) => agentIds.length >= 2)
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .slice(0, 100)
      .map(([slug, agentIds]) => {
        const counts = new Map<string, number>();
        for (const id of agentIds) {
          const agent = byId.get(id);
          const role = agent ? (agent.role ?? nameRole(agent.name)) : null;
          if (role) counts.set(role, (counts.get(role) ?? 0) + 1);
        }
        const suggestedRole = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
        return { slug, agentIds, suggestedRole };
      });
  }
}

/** The SKILL.md of `slug` in an agent's workspace, from the first skill folder that has it. */
async function readWorkspaceSkill(workspacePath: string, slug: string): Promise<string | null> {
  for (const folder of SKILL_FOLDERS) {
    const file = join(workspacePath, folder, slug, "SKILL.md");
    try {
      const stats = await lstat(file);
      if (!stats.isFile()) continue;
      return await readFile(file, "utf8");
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return null;
}

async function markerOf(folder: string): Promise<{ playbookId: string; version: number } | null> {
  try {
    const stats = await lstat(join(folder, MARKER));
    if (!stats.isFile()) return null;
    const value = readJson(await readFile(join(folder, MARKER), "utf8"));
    return isDynamicRecord(value) && isString(value.playbookId) && typeof value.version === "number"
      ? { playbookId: value.playbookId, version: value.version }
      : null;
  } catch {
    return null;
  }
}

/** The real folder for `relative` inside the workspace, or null when a link or a file is in the way. */
async function containedFolder(workspacePath: string, relative: string, create: boolean): Promise<string | null> {
  const root = await realpath(workspacePath);
  let current = root;
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
    } catch (error) {
      if (!isMissingFileError(error) || !create) return null;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return isPathInside(root, current) ? current : null;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Writes the playbook to both skill folders of a workspace. True when the agent has it now. */
async function writePlaybook(workspacePath: string, playbook: StoredPlaybook): Promise<boolean> {
  let installed = false;
  const marker = `${JSON.stringify({ managedBy: "openbot", playbookId: playbook.id, version: playbook.version })}\n`;
  for (const folder of SKILL_FOLDERS) {
    const parent = await containedFolder(workspacePath, folder, true);
    if (!parent) continue;
    const target = join(parent, playbook.slug);
    const file = join(target, "SKILL.md");
    let existing: string | null = null;
    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
      const fileStats = await lstat(file).catch(() => null);
      if (fileStats && (fileStats.isSymbolicLink() || !fileStats.isFile())) continue;
      existing = fileStats ? await readFile(file, "utf8") : null;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      await mkdir(target, { mode: 0o700 });
    }
    const owned = await markerOf(target);
    // A folder that the agent or a person made stays theirs, unless it holds the playbook's own text.
    if (!owned || owned.playbookId !== playbook.id) {
      if (existing !== null && existing !== playbook.content) continue;
      if (owned && owned.playbookId !== playbook.id) continue;
    }
    if (existing !== playbook.content) await atomicWrite(file, playbook.content);
    if (owned?.version !== playbook.version || owned.playbookId !== playbook.id)
      await atomicWrite(join(target, MARKER), marker);
    installed = true;
  }
  return installed;
}

/** Removes the folders that this playbook marked. Anything else in them stays, and so does the folder. */
async function removeMarked(workspacePath: string, slug: string, playbookId: string): Promise<void> {
  for (const folder of SKILL_FOLDERS) {
    const parent = await containedFolder(workspacePath, folder, false).catch(() => null);
    if (!parent) continue;
    const target = join(parent, slug);
    const owned = await markerOf(target);
    if (owned?.playbookId !== playbookId) continue;
    await unlink(join(target, "SKILL.md")).catch(() => undefined);
    await unlink(join(target, MARKER)).catch(() => undefined);
    await rmdir(target).catch(() => undefined);
  }
}

/** The JSON object of `text`, or an empty record for any other value. */
function readJson(text: string): DynamicRecord {
  const value = JSON.parse(text);
  return isDynamicRecord(value) ? value : {};
}
