import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SharedTable } from "@openbot/contracts/ipc";
import { GENERAL_SPACE_ID } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentDatabaseSupervisor } from "./agent-database-supervisor";
import { AgentTables, AgentTablesError } from "./agent-tables";

export interface SpaceAgentTablesOptions {
  supervisor: AgentDatabaseSupervisor;
  /** The shared folder of the agent's space. */
  sharedDirectory: (agentId: string) => string;
  /** Every space with its shared folder. */
  spaces: () => { spaceId: string; sharedDirectory: string }[];
  /**
   * The old global shared folder. Until a database is in the shared folder of `general`, `general`
   * keeps using the old global one, so the tables of an existing install stay where its agents are.
   */
  legacySharedRoot?: string | undefined;
}

/**
 * Owns one shared database per space, `<space shared folder>/Data/agent-data.db`. An agent reads and
 * writes only the database of its own space, so the tables of one project never reach another. One
 * supervisor serves them all: each statement names its file.
 */
export class SpaceAgentTables {
  readonly #options: SpaceAgentTablesOptions;
  readonly #byDirectory = new Map<string, AgentTables>();

  constructor(options: SpaceAgentTablesOptions) {
    this.#options = options;
  }

  forAgent(agentId: string): AgentTables {
    return this.#at(this.#databaseRoot(this.#options.sharedDirectory(agentId)));
  }

  /**
   * The tables of every space that has a database, for the person. A space with no database file yet
   * is skipped, so a read does not make one.
   */
  listShared(): Effect.Effect<SharedTable[], AgentTablesError> {
    const spaces = this.#options
      .spaces()
      .map((space) => ({ ...space, sharedDirectory: this.#databaseRoot(space.sharedDirectory, space.spaceId) }))
      .filter((space) => existsSync(databaseFile(space.sharedDirectory)));
    return Effect.forEach(spaces, (space) =>
      this.#at(space.sharedDirectory)
        .listShared()
        .pipe(Effect.map((tables) => tables.map((table) => ({ ...table, spaceId: space.spaceId })))),
    ).pipe(Effect.map((lists) => lists.flat()));
  }

  /**
   * The person's delete. Without a space, the one space that has a table of that name; when several
   * have one, it refuses rather than guess.
   */
  removeAsUser(name: string, spaceId?: string): Effect.Effect<void, AgentTablesError> {
    return Effect.gen({ self: this }, function* () {
      const spaces = this.#options.spaces();
      if (spaceId !== undefined) {
        const space = spaces.find((entry) => entry.spaceId === spaceId);
        if (!space) return yield* new AgentTablesError({ message: sourceText("error.backend.spaceNotFound") });
        return yield* this.#at(this.#databaseRoot(space.sharedDirectory, space.spaceId)).removeAsUser(name);
      }
      const owners = (yield* this.listShared()).filter((table) => table.name === name);
      if (owners.length > 1)
        return yield* new AgentTablesError({ message: sourceText("error.backend.spaceTableAmbiguous") });
      const owner = spaces.find((entry) => entry.spaceId === (owners[0]?.spaceId ?? GENERAL_SPACE_ID));
      if (!owner) return yield* new AgentTablesError({ message: sourceText("error.backend.spaceNotFound") });
      return yield* this.#at(this.#databaseRoot(owner.sharedDirectory, owner.spaceId)).removeAsUser(name);
    });
  }

  dispose(): void {
    this.#byDirectory.clear();
    this.#options.supervisor.dispose();
  }

  /** The folder whose `Data` holds the database of a space; see `legacySharedRoot`. */
  #databaseRoot(sharedDirectory: string, spaceId?: string): string {
    const legacy = this.#options.legacySharedRoot;
    const general =
      spaceId === undefined
        ? this.#options.spaces().find((space) => space.spaceId === GENERAL_SPACE_ID)?.sharedDirectory ===
          sharedDirectory
        : spaceId === GENERAL_SPACE_ID;
    if (!general || !legacy || existsSync(databaseFile(sharedDirectory))) return sharedDirectory;
    return existsSync(databaseFile(legacy)) ? legacy : sharedDirectory;
  }

  #at(sharedDirectory: string): AgentTables {
    const found = this.#byDirectory.get(sharedDirectory);
    if (found) return found;
    const tables = new AgentTables({ sharedRoot: sharedDirectory, supervisor: this.#options.supervisor });
    this.#byDirectory.set(sharedDirectory, tables);
    return tables;
  }
}

function databaseFile(sharedDirectory: string): string {
  return join(sharedDirectory, "Data", "agent-data.db");
}
