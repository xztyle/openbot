import { readFile } from "node:fs/promises";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Semaphore } from "effect";
import {
  isEmptyStoredFile,
  parseStoredJson,
  type VersionedJsonFile,
  writeJsonFileAtomically,
} from "../atomic-json-file";
import { isMissingFileError } from "../file-errors";

const logger = createOpenBotLogger("agent-efficiency");

/**
 * One small versioned JSON file in the user data folder, read once and written whole after each
 * change. A missing or damaged file reads as `empty`; the damaged one is logged and replaced at the
 * next write.
 */
export class JsonStore<Content extends VersionedJsonFile> {
  readonly #path: string;
  readonly #decode: (value: unknown) => Content | null;
  readonly #writes = Semaphore.makeUnsafe(1);
  #content: Content;
  /** The one read of the file. Every caller waits for it, also one that comes while it runs. */
  #loading: Promise<Content> | null = null;

  constructor(path: string, empty: Content, decode: (value: unknown) => Content | null) {
    this.#path = path;
    this.#content = empty;
    this.#decode = decode;
  }

  load(): Effect.Effect<Content> {
    return Effect.promise(() => {
      this.#loading ??= this.#read();
      return this.#loading;
    }).pipe(Effect.map(() => this.#content));
  }

  async #read(): Promise<Content> {
    try {
      const contents = await readFile(this.#path, "utf8");
      if (!isEmptyStoredFile(contents)) {
        const parsed = parseStoredJson(this.#path, contents, this.#decode);
        if (parsed) this.#content = parsed;
        else logger.warn("A stored efficiency file is not readable; it starts empty.", { path: this.#path });
      }
    } catch (error) {
      if (!isMissingFileError(error)) logger.warn("Could not read a stored efficiency file.", { error });
    }
    return this.#content;
  }

  /** The content read last. Call `load` first. */
  get current(): Content {
    return this.#content;
  }

  update(change: (content: Content) => Content): Effect.Effect<Content> {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* this.load();
        this.#content = change(this.#content);
        yield* writeJsonFileAtomically(this.#path, this.#content, { createDirectory: true }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => logger.warn("Could not save a stored efficiency file.", { error })),
          ),
        );
        return this.#content;
      }),
    );
  }
}
