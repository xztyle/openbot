import { readFileSync } from "node:fs";
import type { DiscordChannelConfig } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema, Semaphore } from "effect";
import { writeJsonFileAtomically } from "../../atomic-json-file";

const logger = createOpenBotLogger("discord-channel-config");

const Setting = Schema.Struct({
  channelId: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  answerAll: Schema.Boolean,
  mainChat: Schema.optional(Schema.Boolean),
});
const Config = Schema.Struct({ serverAgentId: Schema.NullOr(Schema.String), channels: Schema.Array(Setting) });
const ConfigFile = Schema.Struct({ version: Schema.Literal(1), connections: Schema.Record(Schema.String, Config) });
const decodeConfigFile = Schema.decodeUnknownSync(ConfigFile);

const EMPTY: DiscordChannelConfig = { serverAgentId: null, channels: [] };

function copy(config: {
  readonly serverAgentId: string | null;
  readonly channels: readonly DiscordChannelConfig["channels"][number][];
}): DiscordChannelConfig {
  return { serverAgentId: config.serverAgentId, channels: config.channels.map((channel) => ({ ...channel })) };
}

/**
 * Owns which agent answers in each Discord server and channel, and the channels where OpenBot answers
 * every message, by messaging connection id. A preference file rather than the database: it needs no
 * migration, and an older build ignores it. A missing or damaged file reads as no settings, so every
 * message goes to the orchestrator as before. A disconnect keeps the settings, as it keeps the roles.
 */
export class DiscordChannelConfigStore {
  readonly #path: string | null;
  #connections = new Map<string, DiscordChannelConfig>();
  readonly #writes = Semaphore.makeUnsafe(1);

  constructor(path: string | null) {
    this.#path = path;
  }

  load(): void {
    if (!this.#path) return;
    try {
      const file = decodeConfigFile(JSON.parse(readFileSync(this.#path, "utf8")));
      this.#connections = new Map(Object.entries(file.connections).map(([id, config]) => [id, copy(config)]));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        logger.warn("The Discord channel settings could not be read.");
    }
  }

  get(connectionId: string): DiscordChannelConfig {
    return copy(this.#connections.get(connectionId) ?? EMPTY);
  }

  readonly set = Effect.fn("DiscordChannelConfigStore.set")(function* (
    this: DiscordChannelConfigStore,
    connectionId: string,
    config: DiscordChannelConfig,
  ) {
    yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const next = new Map(this.#connections);
        next.set(connectionId, copy(config));
        if (this.#path)
          yield* writeJsonFileAtomically(
            this.#path,
            { version: 1, connections: Object.fromEntries(next) },
            { createDirectory: true },
          );
        this.#connections = next;
      }),
    );
  });
}
