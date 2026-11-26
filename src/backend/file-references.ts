// The files that a message names, found on the host: for the files that the host attaches to an
// agent's message to the owner, and for a file chip that a person opens in the viewer.
//
// A reference is a path or a file name as an agent writes it: `/data/OpenBot/Spaces/ventas/Shared/a.pdf`,
// `~/OpenBot/Spaces/ventas/Shared/a.pdf`, `Shared/a.pdf`, `landing-review/index.html` or `copy-a.txt`. It
// resolves only inside the roots that the caller gives: the agent's workspace, the shared folders of
// spaces, and the old global shared folder. A symbolic link is followed and its target must be inside a
// root too. A name or a folder that looks like a secret (a key, a `.env` file, a hidden folder) never
// resolves.
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { isSupportedAttachmentName } from "@openbot/contracts/attachment-files";
import { ATTACHMENT_LIMITS } from "@openbot/contracts/input-limits";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { attachmentCall } from "./attachment-effects";

/** Where a reference may resolve for one reader. */
export interface FileReferenceRoots {
  /** The agent whose words name the file. A relative path or a bare name resolves in its folders. */
  agent: { id: string; workspacePath: string; sharedDirectory: string } | null;
  /** The shared folder of each space that the reader may open, by the space's folder name (slug). */
  spaces: ReadonlyMap<string, string>;
  /** The workspace of each agent that the reader may open, by agent id. */
  workspaces: ReadonlyMap<string, string>;
  /** The old global shared folder, `OpenBot/Shared`, or null when the reader may not open it. */
  legacyShared: string | null;
  /** The files that the agent wrote or changed lately, newest last: a bare name finds these first. */
  recentFiles?: readonly string[] | undefined;
}

export type FileReferenceResolution =
  | { kind: "file"; path: string; name: string; size: number; modifiedAt: number }
  | { kind: "folder"; path: string; name: string }
  | { kind: "refused"; reason: "missing" | "outside" | "too-large" };

export interface FileReferenceEntry {
  /** The path inside the listed folder, with `/` separators. */
  name: string;
  /** The real path, which this module accepts again as a reference. */
  path: string;
  kind: "file" | "directory";
  size: number;
}

/** The most entries a folder listing shows. */
export const FILE_REFERENCE_FOLDER_LIMIT = 500;
/** How deep a folder listing goes into the folders of the folder. */
const FOLDER_LIST_DEPTH = 2;
/** The most references of one text that the host looks up. */
const MENTION_LIMIT = 40;
/** How deep, and over how many entries, a bare name is looked for in a folder. */
const NAME_SEARCH_DEPTH = 4;
const NAME_SEARCH_ENTRIES = 4_000;
/** Folders that hold tools and caches, not the work that an agent hands over. */
const SKIPPED_FOLDERS = new Set(["node_modules", "__pycache__", "venv", "site-packages", "dist-packages"]);
/** Names that hold keys, passwords or sign-ins. A hidden name (`.env`, `.ssh/`) is refused as well. */
const SECRET_NAME =
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.\w+)?|secrets?(?:\.\w+)?|.*\.(?:pem|key|p12|pfx|kdbx|keystore|jks|gpg|asc|ovpn)|tokens?(?:\.\w+)?|(?:.*[-_.])?(?:api[-_]?keys?|passwords?)(?:\.\w+)?)$/iu;
/** `:12`, `:12:3`, `#L12` and `#L12-L20` after a path. */
const LOCATION_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/u;
const SPACE_SHARED = /(?:^|\/)OpenBot\/Spaces\/([^/]+)\/Shared(?:\/(.*))?$/u;
const AGENT_WORKSPACE = /(?:^|\/)OpenBot\/(?:Agents|Bots)\/([^/]+)(?:\/(.*))?$/u;
const LEGACY_SHARED = /(?:^|\/)OpenBot\/Shared(?:\/(.*))?$/u;

/** Whether a path names a secret or a hidden file or folder, in any of its parts. */
export function isSecretPath(path: string): boolean {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => part !== "" && part !== "." && part !== ".." && (part.startsWith(".") || SECRET_NAME.test(part)));
}

function trimReference(value: string): string {
  return value
    .trim()
    .replace(/^["'“‘«<(]+|["'”’»>)]+$/gu, "")
    .replace(/[.,;:!?]+$/u, "")
    .trim();
}

/**
 * The paths and file names that a text names, in order and once each: code spans, Markdown link
 * targets, paths, and bare names with a file type that Atelier can attach. A web address is not one.
 */
export function fileMentions(text: string): string[] {
  const found: string[] = [];
  const add = (raw: string | undefined) => {
    const value = raw === undefined ? "" : trimReference(raw);
    if (!value || value.length > 1_024 || /[\0\r\n]/u.test(value) || found.includes(value)) return;
    if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value) || /^www\./iu.test(value) || value.includes("@")) return;
    const name = basename(value.replaceAll("\\", "/").replace(/\/+$/u, ""));
    // A bare word must be a file name; a path may name a folder.
    if (!value.includes("/") && !isSupportedAttachmentName(name.replace(LOCATION_SUFFIX, ""))) return;
    found.push(value);
  };
  for (const match of text.matchAll(/`([^`\r\n]{1,1024})`/gu)) add(match[1]);
  for (const match of text.matchAll(/\]\(<?([^)\s<>]{1,1024})>?\)/gu)) add(match[1]);
  // Outside code spans: a path or a bare name between spaces or punctuation.
  const plain = text.replaceAll(/`[^`\r\n]*`/gu, " ").replaceAll(/\]\([^)]*\)/gu, "] ");
  for (const match of plain.matchAll(
    /(?:^|[\s(«"'“¿¡:,;[])((?:~\/|\/)?(?:[\p{L}\p{N}_.+-]+\/)*[\p{L}\p{N}_+-][\p{L}\p{N}_.+-]*\.[A-Za-z][A-Za-z\d]{0,7}\/?)(?=$|[\s)»"'”.,;:!?\]])/gmu,
  ))
    add(match[1]);
  return found.slice(0, MENTION_LIMIT);
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The paths on the host that a reference can mean, most likely first. */
function candidatePaths(reference: string, roots: FileReferenceRoots): string[] {
  const value = decoded(reference).trim();
  const normalized = value.replaceAll("\\", "/");
  const space = SPACE_SHARED.exec(normalized);
  if (space?.[1]) {
    const directory = roots.spaces.get(space[1]);
    return directory ? [join(directory, space[2] ?? "")] : [];
  }
  const workspace = AGENT_WORKSPACE.exec(normalized);
  if (workspace?.[1]) {
    const directory = roots.workspaces.get(workspace[1]);
    return directory ? [join(directory, workspace[2] ?? "")] : [];
  }
  const legacy = LEGACY_SHARED.exec(normalized);
  if (legacy) return roots.legacyShared ? [join(roots.legacyShared, legacy[1] ?? "")] : [];
  const agent = roots.agent;
  if (normalized.startsWith("Shared/")) return agent ? [join(agent.sharedDirectory, normalized.slice(7))] : [];
  if (isAbsolute(value)) return [value];
  if (!agent) return [];
  const local = normalized.replace(/^\.\//u, "");
  return [join(agent.workspacePath, local), join(agent.sharedDirectory, local)];
}

/** The real paths of the roots that exist. */
const realRoots = Effect.fn("FileReferences.realRoots")(function* (roots: FileReferenceRoots) {
  const paths = [
    ...(roots.agent ? [roots.agent.workspacePath, roots.agent.sharedDirectory] : []),
    ...roots.spaces.values(),
    ...roots.workspaces.values(),
    ...(roots.legacyShared ? [roots.legacyShared] : []),
  ];
  const real = yield* Effect.forEach(
    [...new Set(paths)],
    (path) => attachmentCall(() => realpath(path)).pipe(Effect.orElseSucceed(() => null)),
    { concurrency: 8 },
  );
  return real.filter((path) => path !== null);
});

/**
 * The newest file with this name in the folders, a few levels deep, past hidden and tool folders.
 * Each folder is read once for a lookup of many names: `index` keeps what it found.
 */
const filesNamed = Effect.fn("FileReferences.filesNamed")(function* (folders: readonly string[]) {
  const index = new Map<string, string[]>();
  let seen = 0;
  const queue: { path: string; depth: number }[] = folders.map((path) => ({ path, depth: 0 }));
  while (queue.length > 0 && seen < NAME_SEARCH_ENTRIES) {
    const folder = queue.shift();
    if (!folder) break;
    const entries: Dirent[] = yield* attachmentCall(() => readdir(folder.path, { withFileTypes: true })).pipe(
      Effect.orElseSucceed((): Dirent[] => []),
    );
    for (const entry of entries) {
      seen += 1;
      if (entry.name.startsWith(".") || SECRET_NAME.test(entry.name)) continue;
      const path = join(folder.path, entry.name);
      if (entry.isDirectory()) {
        if (folder.depth < NAME_SEARCH_DEPTH && !SKIPPED_FOLDERS.has(entry.name))
          queue.push({ path, depth: folder.depth + 1 });
      } else if (entry.isFile()) index.set(entry.name, [...(index.get(entry.name) ?? []), path]);
    }
  }
  return index;
});

/**
 * Resolves the references of one reader at a time. A bare name is looked for in the agent's recent
 * files, then in its workspace and its space's shared folder, and the newest file with that name wins.
 */
export class FileReferenceResolver {
  readonly #roots: FileReferenceRoots;
  #real: string[] | null = null;
  #names: Map<string, string[]> | null = null;

  constructor(roots: FileReferenceRoots) {
    this.#roots = roots;
  }

  readonly resolve = Effect.fn("FileReferences.resolve")(function* (
    this: FileReferenceResolver,
    reference: string,
  ): Effect.fn.Return<FileReferenceResolution> {
    const value = trimReference(reference);
    if (!value || value.length > 4_096 || /[\0\r\n]/u.test(value)) return { kind: "refused", reason: "missing" };
    if (isSecretPath(value)) return { kind: "refused", reason: "outside" };
    this.#real ??= yield* realRoots(this.#roots);
    const roots = this.#real;
    let outside = false;
    const withoutLocation = value.replace(LOCATION_SUFFIX, "");
    const candidates = [
      ...candidatePaths(value, this.#roots),
      ...(withoutLocation === value ? [] : candidatePaths(withoutLocation, this.#roots)),
    ];
    const bare = !withoutLocation.replaceAll("\\", "/").replace(/\/+$/u, "").includes("/");
    if (bare) candidates.push(...(yield* this.#named(withoutLocation)));
    // A relative path whose folder a chat guessed from another path of the message: the file by its name.
    else if (!isAbsolute(withoutLocation) && !/^~?[/\\]/u.test(withoutLocation) && !/[/\\]$/u.test(withoutLocation))
      candidates.push(...(yield* this.#named(basename(withoutLocation.replaceAll("\\", "/")))));
    for (const candidate of candidates) {
      const resolved = yield* attachmentCall(() => realpath(candidate)).pipe(Effect.orElseSucceed(() => null));
      if (resolved === null) continue;
      const root = roots.find((path) => path === resolved || within(path, resolved));
      if (!root) {
        outside = true;
        continue;
      }
      // Every part below the root counts: a link may lead into a hidden folder.
      if (isSecretPath(relative(root, resolved))) {
        outside = true;
        continue;
      }
      const metadata = yield* attachmentCall(() => stat(resolved)).pipe(Effect.orElseSucceed(() => null));
      if (metadata?.isDirectory()) return { kind: "folder", path: resolved, name: basename(resolved) };
      if (!metadata?.isFile() || root === resolved) continue;
      if (metadata.size > ATTACHMENT_LIMITS.fileBytes) return { kind: "refused", reason: "too-large" };
      return {
        kind: "file",
        path: resolved,
        name: basename(resolved),
        size: metadata.size,
        modifiedAt: Math.floor(metadata.mtimeMs),
      };
    }
    // A path the reader may not open is not told apart from one that does not exist.
    return { kind: "refused", reason: outside || (!bare && candidates.length === 0) ? "outside" : "missing" };
  }).bind(this);

  /** The files a bare name can mean: the agent's recent files first, then the newest in its folders. */
  readonly #named = Effect.fn("FileReferences.named")(function* (this: FileReferenceResolver, name: string) {
    const agent = this.#roots.agent;
    if (!agent) return [];
    const recent = [...(this.#roots.recentFiles ?? [])].reverse().filter((path) => basename(path) === name);
    this.#names ??= yield* filesNamed([agent.sharedDirectory, agent.workspacePath]);
    const found = this.#names.get(name) ?? [];
    const dated = yield* Effect.forEach(found, (path) =>
      attachmentCall(() => stat(path)).pipe(
        Effect.map((metadata) => ({ path, time: metadata.mtimeMs })),
        Effect.orElseSucceed(() => ({ path, time: 0 })),
      ),
    );
    return [...recent, ...dated.sort((left, right) => right.time - left.time).map(({ path }) => path)];
  }).bind(this);

  /**
   * The entries of a folder that `resolve` gave and of its folders, a few levels deep, folders first,
   * with no hidden or secret entry. `name` is the path inside the folder, with `/` separators.
   */
  readonly listFolder = Effect.fn("FileReferences.listFolder")(function* (
    this: FileReferenceResolver,
    folder: string,
  ): Effect.fn.Return<{ entries: FileReferenceEntry[]; truncated: boolean }> {
    const entries: FileReferenceEntry[] = [];
    let truncated = false;
    const queue: { path: string; prefix: string; depth: number }[] = [{ path: folder, prefix: "", depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      const dirents: Dirent[] = yield* attachmentCall(() => readdir(current.path, { withFileTypes: true })).pipe(
        Effect.orElseSucceed((): Dirent[] => []),
      );
      const visible = dirents.filter(
        (entry) =>
          (entry.isFile() || entry.isDirectory()) &&
          !entry.name.startsWith(".") &&
          !SECRET_NAME.test(entry.name) &&
          !entry.name.includes("\\") &&
          !(entry.isDirectory() && SKIPPED_FOLDERS.has(entry.name)),
      );
      visible.sort((left, right) =>
        left.isDirectory() === right.isDirectory() ? left.name.localeCompare(right.name) : left.isDirectory() ? -1 : 1,
      );
      for (const entry of visible) {
        if (entries.length >= FILE_REFERENCE_FOLDER_LIMIT) {
          truncated = true;
          break;
        }
        const path = join(current.path, entry.name);
        const name = `${current.prefix}${entry.name}`;
        if (entry.isDirectory()) {
          entries.push({ name, path, kind: "directory", size: 0 });
          if (current.depth < FOLDER_LIST_DEPTH) queue.push({ path, prefix: `${name}/`, depth: current.depth + 1 });
          continue;
        }
        const metadata = yield* attachmentCall(() => stat(path)).pipe(Effect.orElseSucceed(() => null));
        if (metadata) entries.push({ name, path, kind: "file", size: metadata.size });
      }
    }
    return { entries, truncated };
  }).bind(this);
}

/**
 * A reference that the reader cannot open. A path outside what the reader may see reads the same as a
 * missing one, so the answer does not tell whether a path exists on the host.
 */
export class FileReferenceRefused extends Error {
  constructor(readonly reason: "missing" | "outside" | "too-large") {
    super(
      sourceText(
        reason === "too-large" ? "error.backend.fileReferenceTooLarge" : "error.backend.fileReferenceUnavailable",
      ),
    );
  }
}
