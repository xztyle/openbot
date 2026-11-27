import {
  guessSecretKind,
  type SecretActor,
  type SecretAuditAction,
  type SecretAuditRow,
  type SecretFolderAccess,
  type SecretRequest,
  type SecretSummary,
  type SecretVaultCall,
  type SecretVaultResult,
  type SecretVersion,
  secretFolderAncestors,
  secretScopeKind,
  type TrashedSecret,
} from "@openbot/contracts/ipc";

const DAY = 86_400_000;

interface MockSecret {
  summary: SecretSummary;
  values: { version: number; createdAt: number; by: SecretActor; value: string }[];
  audit: SecretAuditRow[];
}

/**
 * The keys and passwords screen of the preview and the web harness: the host's rules in memory
 * (versions, the bin, who may use a key, the history), with a few keys of a business. The real
 * store is `src/backend/secret-ledger.ts`; `scripts/secret-vault-e2e.ts` checks that one.
 */
export function createMockSecretVault(options: { agentIds: readonly string[]; spaceIds: readonly string[] }) {
  const now = Date.now();
  const owner: SecretActor = { kind: "owner", name: "Alejandro" };
  const [first = "agent-1", second = first] = options.agentIds;
  const space = options.spaceIds[0];
  const secrets = new Map<string, MockSecret>();
  const trash: { secret: MockSecret; deletedAt: number; by: SecretActor }[] = [];
  const requests: SecretRequest[] = [
    {
      kind: "fill",
      requestId: "request-stripe",
      agentId: second,
      name: "STRIPE_SECRET_KEY",
      shared: false,
      createdAt: now - 6 * 60_000,
    },
  ];
  const folders = new Map<string, SecretFolderAccess>();
  const keyOf = (scope: string, name: string) => `${scope}/${name}`;
  const log = (secret: MockSecret, action: SecretAuditAction, actor: SecretActor, detail?: string) => {
    secret.audit.unshift({ at: Date.now(), action, actor, ...(detail ? { detail } : {}) });
  };
  const seed = (
    scope: string,
    name: string,
    value: string,
    extra: Partial<SecretSummary> & { versions?: number; createdDaysAgo: number },
  ) => {
    const createdAt = now - extra.createdDaysAgo * DAY;
    const versions = extra.versions ?? 1;
    const values = Array.from({ length: versions }, (_, index) => ({
      version: index + 1,
      createdAt: createdAt + index * ((now - createdAt) / (versions + 1)),
      by: owner,
      value: `${value}${index === versions - 1 ? "" : `-old-${index + 1}`}`,
    }));
    const { versions: _versions, createdDaysAgo: _days, ...summary } = extra;
    const secret: MockSecret = {
      summary: {
        scope,
        name,
        type: guessSecretKind(name),
        tags: [],
        access: { everyone: secretScopeKind(scope) === "shared", agents: [], spaces: [] },
        createdAt,
        updatedAt: values.at(-1)?.createdAt ?? createdAt,
        usedBy: [],
        version: versions,
        ...(versions > 1 ? { rotatedAt: values.at(-1)?.createdAt } : {}),
        ...summary,
      },
      values,
      audit: [{ at: createdAt, action: "created", actor: owner }],
    };
    secrets.set(keyOf(scope, name), secret);
  };
  seed("shared", "META_ACCESS_TOKEN", "EAAG-preview-meta", {
    label: "Anuncios de Meta",
    folder: "universidad-online/meta",
    tags: ["anuncios"],
    createdDaysAgo: 120,
    versions: 3,
    lastUsedAt: now - 2 * 3_600_000,
    usedBy: [{ agentId: first, at: now - 2 * 3_600_000 }],
    rotateBy: now + 5 * DAY,
    rotateEveryDays: 90,
  });
  seed("shared", "HOTMART_CLIENT_SECRET", "hotmart-preview", {
    label: "Hotmart",
    folder: "universidad-online/ventas",
    createdDaysAgo: 200,
    lastUsedAt: now - 45 * DAY,
  });
  seed(first, "GMAIL_APP_PASSWORD", "gmail-preview", {
    label: "Correo de ventas",
    createdDaysAgo: 20,
    lastUsedAt: now - DAY,
    usedBy: [{ agentId: first, at: now - DAY }],
  });
  seed(second, "CANVA_TOTP", "JBSWY3DPEHPK3PXP", {
    label: "Canva, código de acceso",
    createdDaysAgo: 60,
    expiresAt: now - DAY,
  });
  if (space)
    seed(`space:${space}`, "MOODLE_PASSWORD", "moodle-preview", {
      label: "Campus Moodle",
      folder: "universidad-online/campus",
      tags: ["campus", "alumnos"],
      createdDaysAgo: 10,
      lastUsedAt: now - 30 * 60_000,
      usedBy: [{ agentId: first, at: now - 30 * 60_000 }],
    });

  const get = (scope: string, name: string) => {
    const secret = secrets.get(keyOf(scope, name));
    if (!secret) throw new Error("That key or version is no longer here. Refresh the list.");
    return secret;
  };
  const pushValue = (secret: MockSecret, value: string, actor: SecretActor) => {
    const at = Date.now();
    const version = (secret.values.at(-1)?.version ?? 0) + 1;
    secret.values.push({ version, createdAt: at, by: actor, value });
    secret.summary = {
      ...secret.summary,
      version,
      updatedAt: at,
      ...(version > 1 ? { rotatedAt: at } : {}),
      ...(secret.summary.rotateEveryDays ? { rotateBy: at + secret.summary.rotateEveryDays * DAY } : {}),
    };
  };
  const versions = (secret: MockSecret): SecretVersion[] =>
    secret.values
      .map((item, index) => ({
        version: item.version,
        createdAt: item.createdAt,
        by: item.by,
        current: index === secret.values.length - 1,
      }))
      .reverse();
  const done: SecretVaultResult = { kind: "done" };

  return async function call(input: SecretVaultCall): Promise<SecretVaultResult> {
    switch (input.kind) {
      case "overview":
        return {
          kind: "overview",
          secrets: [...secrets.values()].map((secret) => secret.summary),
          trash: trash.map(
            (item): TrashedSecret => ({
              scope: item.secret.summary.scope,
              name: item.secret.summary.name,
              ...(item.secret.summary.label ? { label: item.secret.summary.label } : {}),
              deletedAt: item.deletedAt,
              by: item.by,
            }),
          ),
          requests: [...requests],
          folders: [...folders.values()],
        };
      case "detail": {
        const secret = get(input.scope, input.name);
        return { kind: "detail", detail: { secret: secret.summary, versions: versions(secret), audit: secret.audit } };
      }
      case "save": {
        const { kind: _kind, scope, name, value, ...settings } = input;
        const existing = secrets.get(keyOf(scope, name));
        if (existing) {
          pushValue(existing, value, owner);
          log(existing, "changed", owner, `version ${existing.summary.version}`);
          return done;
        }
        const at = Date.now();
        const secret: MockSecret = {
          summary: {
            scope,
            name,
            type: settings.type ?? guessSecretKind(name),
            tags: settings.tags ?? [],
            access: { everyone: secretScopeKind(scope) === "shared", agents: [], spaces: [] },
            createdAt: at,
            updatedAt: at,
            usedBy: [],
            version: 1,
            ...(settings.label ? { label: settings.label } : {}),
            ...(settings.folder ? { folder: settings.folder } : {}),
          },
          values: [{ version: 1, createdAt: at, by: owner, value }],
          audit: [],
        };
        log(secret, "created", owner);
        secrets.set(keyOf(scope, name), secret);
        return done;
      }
      case "update": {
        const secret = get(input.scope, input.name);
        const {
          kind: _kind,
          scope: _scope,
          name: _name,
          access,
          rotateBy,
          rotateEveryDays,
          expiresAt,
          ...settings
        } = input;
        const next: SecretSummary = { ...secret.summary };
        if (settings.type) next.type = settings.type;
        for (const field of ["label", "folder", "note"] as const) {
          const value = settings[field];
          if (value === undefined) continue;
          if (value) next[field] = value;
          else delete next[field];
        }
        if (settings.tags) next.tags = settings.tags;
        if (rotateBy !== undefined) {
          if (rotateBy === null) delete next.rotateBy;
          else next.rotateBy = rotateBy;
        }
        if (rotateEveryDays !== undefined) {
          if (rotateEveryDays === null) delete next.rotateEveryDays;
          else {
            next.rotateEveryDays = rotateEveryDays;
            if (rotateBy === undefined) next.rotateBy = (next.rotatedAt ?? next.createdAt) + rotateEveryDays * DAY;
          }
        }
        if (expiresAt !== undefined) {
          if (expiresAt === null) delete next.expiresAt;
          else next.expiresAt = expiresAt;
        }
        if (access) {
          next.access = access;
          log(secret, "access-changed", owner);
        } else log(secret, "settings-changed", owner);
        secret.summary = next;
        return done;
      }
      case "reveal": {
        const secret = get(input.scope, input.name);
        const stored =
          input.version === undefined
            ? secret.values.at(-1)
            : secret.values.find((item) => item.version === input.version);
        if (!stored) throw new Error("That key or version is no longer here. Refresh the list.");
        log(
          secret,
          input.purpose === "copy" ? "copied" : "revealed",
          owner,
          input.version ? `version ${input.version}` : undefined,
        );
        return { kind: "value", value: stored.value };
      }
      case "rollback": {
        const secret = get(input.scope, input.name);
        const stored = secret.values.find((item) => item.version === input.version);
        if (!stored) throw new Error("That key or version is no longer here. Refresh the list.");
        pushValue(secret, stored.value, owner);
        log(secret, "rolled-back", owner, `version ${input.version}`);
        return done;
      }
      case "delete": {
        const secret = get(input.scope, input.name);
        secrets.delete(keyOf(input.scope, input.name));
        log(secret, "deleted", owner);
        trash.unshift({ secret, deletedAt: Date.now(), by: owner });
        return done;
      }
      case "restore": {
        const index = trash.findIndex(
          (item) => keyOf(item.secret.summary.scope, item.secret.summary.name) === keyOf(input.scope, input.name),
        );
        const [item] = index >= 0 ? trash.splice(index, 1) : [];
        if (!item) throw new Error("That key or version is no longer here. Refresh the list.");
        log(item.secret, "restored", owner);
        secrets.set(keyOf(input.scope, input.name), item.secret);
        return done;
      }
      case "purge": {
        const index = trash.findIndex(
          (item) => keyOf(item.secret.summary.scope, item.secret.summary.name) === keyOf(input.scope, input.name),
        );
        if (index >= 0) trash.splice(index, 1);
        return done;
      }
      case "export":
        return {
          kind: "bundle",
          bundle: btoa(JSON.stringify({ format: "atelier-secrets", version: 1, data: "preview" })),
          count: secrets.size,
        };
      case "import":
        if (input.passphrase.length < 8)
          throw new Error("That passphrase does not open this file. Check it and try again.");
        return { kind: "imported", added: 0, updated: 0, unchanged: secrets.size };
      case "fill": {
        const index = requests.findIndex((request) => request.requestId === input.requestId);
        const [request] = index >= 0 ? requests.splice(index, 1) : [];
        if (request?.kind === "fill") {
          const scope = request.shared ? "shared" : request.agentId;
          const at = Date.now();
          const secret: MockSecret = {
            summary: {
              scope,
              name: request.name,
              type: guessSecretKind(request.name),
              tags: [],
              access: { everyone: request.shared, agents: [], spaces: [] },
              createdAt: at,
              updatedAt: at,
              usedBy: [],
              version: 1,
            },
            values: [{ version: 1, createdAt: at, by: owner, value: input.value }],
            audit: [],
          };
          log(secret, "requested", { kind: "agent", id: request.agentId });
          log(secret, "created", owner);
          secrets.set(keyOf(scope, request.name), secret);
        }
        return done;
      }
      case "folder": {
        if (input.agents.length === 0 && input.spaces.length === 0) folders.delete(input.folder);
        else folders.set(input.folder, { path: input.folder, agents: input.agents, spaces: input.spaces });
        for (const secret of secrets.values())
          if (secretFolderAncestors(secret.summary.folder).includes(input.folder))
            log(secret, "access-changed", owner, `folder ${input.folder}`);
        return done;
      }
      case "approve": {
        const index = requests.findIndex((request) => request.requestId === input.requestId);
        if (index >= 0) requests.splice(index, 1);
        return done;
      }
    }
  };
}
