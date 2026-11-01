import type {
  WorkspaceSecret,
  WorkspaceSecretInput,
  WorkspaceSecretSaveInput,
  WorkspaceSecrets,
  WorkspaceSecretValue,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { type AgentApiKeys, SHARED_API_KEY_SCOPE } from "./agent-api-keys";

/**
 * The Secrets view of the workspace: the keys of the agent key store, for the server owner and the
 * admins only. The list never holds a value; `read` gives one value when the person asks for it.
 * A scope is `shared` or the id of an agent that exists.
 */
export class WorkspaceSecretsService {
  readonly #keys: AgentApiKeys | null;
  readonly #agentExists: (agentId: string) => boolean;

  constructor(keys: AgentApiKeys | null, agentExists: (agentId: string) => boolean) {
    this.#keys = keys;
    this.#agentExists = agentExists;
  }

  #store(): AgentApiKeys {
    if (!this.#keys) throw new Error(sourceText("error.backend.apiKeySaveFailed"));
    return this.#keys;
  }

  #scope(scope: string): string {
    if (scope !== SHARED_API_KEY_SCOPE && !this.#agentExists(scope))
      throw new Error(sourceText("error.backend.apiKeySaveFailed"));
    return scope;
  }

  async list(): Promise<WorkspaceSecrets> {
    if (!this.#keys) return { secrets: [] };
    const entries = await Effect.runPromise(this.#keys.listAll());
    // A deleted agent's folder goes with the agent; one that is left over is not shown.
    const secrets: WorkspaceSecret[] = entries.filter(
      (entry) => entry.scope === SHARED_API_KEY_SCOPE || this.#agentExists(entry.scope),
    );
    return { secrets };
  }

  async read(input: WorkspaceSecretInput): Promise<WorkspaceSecretValue> {
    const value = await Effect.runPromise(this.#store().read(this.#scope(input.scope), input.name));
    if (value === null) throw new Error(sourceText("error.backend.apiKeySaveFailed"));
    return { value };
  }

  async save(input: WorkspaceSecretSaveInput): Promise<void> {
    await Effect.runPromise(this.#store().save(this.#scope(input.scope), input.name, input.value.trim()));
  }

  async remove(input: WorkspaceSecretInput): Promise<void> {
    await Effect.runPromise(this.#store().remove(this.#scope(input.scope), input.name));
  }
}
