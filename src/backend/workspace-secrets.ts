import {
  type SecretActor,
  type SecretRequest,
  type SecretVaultCall,
  type SecretVaultResult,
  secretScopeKind,
  type WorkspaceSecret,
  type WorkspaceSecretInput,
  type WorkspaceSecretSaveInput,
  type WorkspaceSecrets,
  type WorkspaceSecretValue,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { type AgentApiKeys, SHARED_API_KEY_SCOPE } from "./agent-api-keys";
import { SecretLedgerError } from "./secret-ledger";

/** What the keys screen reads from the agents' waiting requests and how it answers them. */
export interface SecretRequestHooks {
  /** The `request_api_key` forms and the saved-key fills that wait for the owner now. */
  list(): SecretRequest[];
  fill(requestId: string, value: string): Promise<void>;
  approve(requestId: string, decision: "accept" | "decline"): Promise<void>;
}

/**
 * The Secrets view of the workspace: the keys of the agent key store, for the server owner and the
 * admins only. The list never holds a value; `read` gives one value when the person asks for it.
 * A scope is `shared` or the id of an agent that exists.
 */
export class WorkspaceSecretsService {
  readonly #keys: AgentApiKeys | null;
  readonly #agentExists: (agentId: string) => boolean;

  readonly #spaceExists: (spaceId: string) => boolean;
  #requests: SecretRequestHooks | null = null;

  constructor(
    keys: AgentApiKeys | null,
    agentExists: (agentId: string) => boolean,
    spaceExists: (spaceId: string) => boolean = () => false,
  ) {
    this.#keys = keys;
    this.#agentExists = agentExists;
    this.#spaceExists = spaceExists;
  }

  setRequests(hooks: SecretRequestHooks): void {
    this.#requests = hooks;
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

  async read(input: WorkspaceSecretInput, actor: SecretActor = { kind: "owner" }): Promise<WorkspaceSecretValue> {
    const value = await Effect.runPromise(this.#store().read(this.#scope(input.scope), input.name, actor));
    if (value === null) throw new Error(sourceText("error.backend.apiKeySaveFailed"));
    return { value };
  }

  async save(input: WorkspaceSecretSaveInput, actor: SecretActor = { kind: "owner" }): Promise<void> {
    await Effect.runPromise(this.#store().save(this.#scope(input.scope), input.name, input.value.trim(), actor));
  }

  async remove(input: WorkspaceSecretInput, actor: SecretActor = { kind: "owner" }): Promise<void> {
    await Effect.runPromise(this.#store().remove(this.#scope(input.scope), input.name, actor));
  }

  /** A scope of the keys screen: `shared`, a space that exists, or an agent that exists. */
  #vaultScope(scope: string): string {
    const kind = secretScopeKind(scope);
    if (kind === "space" ? this.#spaceExists(scope.slice("space:".length)) : this.#scope(scope)) return scope;
    throw new Error(sourceText("error.backend.apiKeySaveFailed"));
  }

  /**
   * One call of the keys and passwords screen. The caller checked the role: owner-only calls
   * (`secretVaultCallIsOwnerOnly`) reach here only from the owner. A value leaves only in `reveal`.
   */
  async vault(call: SecretVaultCall, actor: SecretActor): Promise<SecretVaultResult> {
    const ledger = this.#store().ledger;
    try {
      switch (call.kind) {
        case "overview":
          return {
            kind: "overview",
            secrets: ledger.list().filter((secret) => this.#scopeLives(secret.scope)),
            trash: ledger.trash(),
            requests: this.#requests?.list() ?? [],
            folders: ledger.folders(),
          };
        case "detail":
          return { kind: "detail", detail: ledger.detail(call.scope, call.name) };
        case "save": {
          const { kind: _call, scope, name, value, ...settings } = call;
          ledger.save(this.#vaultScope(scope), name, value.trim(), actor, settings);
          return { kind: "done" };
        }
        case "update": {
          const { kind: _call, scope, name, ...change } = call;
          ledger.update(scope, name, change, actor);
          return { kind: "done" };
        }
        case "reveal":
          return { kind: "value", value: ledger.reveal(call.scope, call.name, actor, call.purpose, call.version) };
        case "rollback":
          ledger.rollback(call.scope, call.name, call.version, actor);
          return { kind: "done" };
        case "delete":
          await Effect.runPromise(this.#store().remove(call.scope, call.name, actor));
          return { kind: "done" };
        case "restore":
          ledger.restore(call.scope, call.name, actor);
          return { kind: "done" };
        case "purge":
          ledger.purge(call.scope, call.name, actor);
          return { kind: "done" };
        case "export":
          return { kind: "bundle", ...ledger.exportBundle(call.passphrase, actor) };
        case "import":
          return { kind: "imported", ...ledger.importBundle(call.bundle, call.passphrase, actor) };
        case "fill":
          if (!this.#requests) throw new Error(sourceText("error.backend.apiKeySaveFailed"));
          await this.#requests.fill(call.requestId, call.value.trim());
          return { kind: "done" };
        case "folder":
          ledger.setFolderAccess(call.folder, call.agents, call.spaces, actor);
          return { kind: "done" };
        case "approve":
          if (!this.#requests) throw new Error(sourceText("error.backend.apiKeySaveFailed"));
          await this.#requests.approve(call.requestId, call.decision);
          return { kind: "done" };
      }
    } catch (error) {
      // The ledger's reasons are for the log; the person reads one plain sentence.
      if (error instanceof SecretLedgerError) throw new SecretVaultRefused(vaultReason(error.message));
      throw error;
    }
  }

  /** A key of a deleted agent is not shown; it waits in the bin. */
  #scopeLives(scope: string): boolean {
    const kind = secretScopeKind(scope);
    if (kind === "shared") return true;
    if (kind === "space") return this.#spaceExists(scope.slice("space:".length));
    return this.#agentExists(scope);
  }
}

/** A refusal the person reads, such as a wrong passphrase. */
export class SecretVaultRefused extends Error {}

function vaultReason(message: string): string {
  if (message.includes("passphrase")) return sourceText("error.backend.secretVaultPassphrase");
  if (message.includes("bundle")) return sourceText("error.backend.secretVaultBundle");
  if (message.includes("exists")) return sourceText("error.backend.secretVaultExists");
  if (message.includes("agent of that key")) return sourceText("error.backend.secretVaultAgentGone");
  return sourceText("error.backend.secretVaultMissing");
}
