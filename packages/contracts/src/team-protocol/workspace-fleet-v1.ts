// Optional workspace fleet wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - `POST /v1/workspace/fleet` `{ timeZone? (64) }` answers `{ agents, revision, at }`: for each agent
//   that the member can see (its roles, not hidden, not in the background), `{ agentId, status,
//   queued?, currentStep? (240), currentStepKind?, todayCostUsd?, todayDurationMs?, lastActiveAt?,
//   currentTicket? }`. `currentTicket` (added later, optional) is `{ key (64), title (240), url (2048,
//   http or https) }`: the Motion ticket the agent works on now.
//   `status` is `{ kind: "idle" }`, `{ kind: "working", what (240), channelId?, threadRootId?,
//   taskId?, startedAt }`, `{ kind: "waiting", reason: "question" | "approval" | "browser", what
//   (240), forMemberId?, channelId?, threadRootId? }` or `{ kind: "queued", count }`. At most 500
//   agents. Times are epoch milliseconds.
// - `POST /v1/workspace/steps` `{ channelId, messageId?, agentId? }` answers `{ steps, total,
//   durationMs, streaming, startedAt?, costUsd? }` for a message of a channel the member can see, or
//   with `agentId` and no `messageId` for the turn that agent runs now for the channel: at most 60
//   steps, each `{ id, kind: "search" | "browse" | "tool" | "shell" | "file" | "skill" | "think",
//   label (160), detail? (300), status: "running" | "done" | "failed", at, durationMs? }`.
// - `POST /v1/workspace/artifacts` `{ channelId?, limit? (1 to 200) }` answers `{ artifacts }`, at
//   most 200, each `{ id (300), kind: "website" | "app" | "doc" | "deck" | "dashboard" | "file",
//   source: "link" | "site" | "render" | "attachment", title (200), description? (300), url? (2048,
//   http or https), thumbnailUrl? (2048), file? { id, name (255), size, mimeType (255) }, agentId?,
//   channelId?, messageId?, threadRootId?, createdAt, updatedAt, costUsd?, durationMs? }`. Without a
//   channel: the channels the member can see and the own conversations of the agents they can see.
// - The event `workspace-fleet-changed` (`{ revision }`), at most once a second while agents work.
// - Later: the wait reason `usage-limit` (a provider usage limit holds the agent's work) with
//   `resetsAt?` (epoch milliseconds) on a waiting status.
// - Later: `thumbnailVersion?` (1 to 64 of `A-Z a-z 0-9 - _`) on an artifact: the host drew the page
//   at `url`. `GET /v1/workspace/artifacts/<id>/thumbnail?v=<thumbnailVersion>` answers that image
//   (`image/webp` or `image/png`, at most 2 MB) when the member can see the artifact, and 404 for
//   another version, an artifact they cannot see or one with no image. `thumbnailUrl` keeps its
//   meaning: an http or https image address. A fork host built before it sends no
//   `thumbnailVersion`, so a client never asks it for an image.
// - Later: `POST /v1/workspace/agent-pairs` `{ agentId?, limit? (1 to 200) }` answers `{ pairs }`,
//   at most 200, newest first: two agents that sent each other messages (`send_message`), both seen
//   by the member, each `{ agentIds: [a, b], count, lastAt, lastSenderId, lastText (240) }`.
// - Later: `POST /v1/workspace/agent-exchange` `{ agentIds: [a, b], before?, limit? (1 to 100) }`
//   answers `{ messages, hasOlder }`: the messages between the two, oldest first, each `{ id,
//   senderAgentId, recipientAgentIds (at most 20), text (8000), truncated?, createdAt,
//   replyToMessageId?, attachmentCount? }`. An agent that the member cannot see answers 404.
// - Later, for the owner and the admins only (403 for any other member): the agent key store.
//   `POST /v1/workspace/secrets` `{}` answers `{ secrets }`, at most 2000, each `{ scope ("shared"
//   or an agent id), name (64), updatedAt }`, never a value. `/secrets/read` `{ scope, name }`
//   answers `{ value (16384) }`. `/secrets/save` `{ scope, name, value (16384) }` and
//   `/secrets/remove` `{ scope, name }` answer `{}`.
// - Later: `POST /v1/workspace/decisions` `{ channelId }` answers `{ decisions }`, at most 200, newest
//   first: the decisions that agents made without a person in a hands-off channel, as they posted
//   them there, each `{ id, agentId, text (8000, without the decision prefix), createdAt,
//   threadRootId? }`. Any member who can see the channel may read them; another channel answers 404.
//
// - Later: `model?` (120) and `modelReason?` (`routine`, `note`, `status`, `event`, `default`, `plan`,
//   `retry`, `escalated`, `large`) on a working status: the model that the automatic model policy
//   (agent-efficiency-v1) chose for the turn, and why. Absent for an agent with a fixed model.
//
// - Later, for the owner and the admins only (403 for any other member): the keys and passwords
//   screen. `POST /v1/workspace/vault` takes one call `{ kind, ... }` and answers `{ kind, ... }`.
//   Calls: `overview`; `detail`, `delete`, `restore`, `purge` `{ scope, name }`; `save` `{ scope,
//   name, value (16384), type?, label? (80), folder? (160), tags? (12 of 32), note? (500) }`;
//   `update` `{ scope, name, type?, label?, folder?, tags?, note?, rotateBy? (time or null),
//   rotateEveryDays? (days or null), expiresAt? (time or null), access? { everyone, agents (500), spaces (200) } }`; `reveal` `{
//   scope, name, purpose: "show" | "copy", version? }`; `rollback` `{ scope, name, version }`;
//   `export` `{ passphrase (8 to 256) }`; `import` `{ bundle (8 MiB), passphrase }`; `fill` `{
//   requestId, value (16384) }`; `approve` `{ requestId, decision: "accept" | "decline" }`.
//   Answers: `overview` `{ secrets (2000), trash (500), requests (200) }`, `detail` `{ detail: {
//   secret, versions (51), audit (300) } }`, `value` `{ value }` (only to `reveal`, only for the
//   owner), `bundle` `{ bundle, count }`, `imported` `{ added, updated, unchanged }`, `done`. A scope
//   is `shared`, `space:<id>` or an agent id. Audit rows and versions carry no value. `reveal`,
//   `export`, `import`, `purge`, `approve` and an `update` with `access` are the owner's alone.
//
// A fork host built before these routes answers 404, so a client fails closed there. A present
// malformed value fails closed. The bounds are written out: this file must not move with an IPC limit.
import { isDynamicRecord } from "../runtime-values";
import {
  adminRoute,
  boolean,
  count,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
  variant,
} from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";
import type { TeamProtocolV2Json } from "./v2";

export const WORKSPACE_FLEET_CAPABILITY = FORK_HOST_CAPABILITY;

export const WORKSPACE_FLEET_ROUTES = {
  fleet: "/v1/workspace/fleet",
  steps: "/v1/workspace/steps",
  artifacts: "/v1/workspace/artifacts",
  agentPairs: "/v1/workspace/agent-pairs",
  agentExchange: "/v1/workspace/agent-exchange",
  secrets: "/v1/workspace/secrets",
  secretRead: "/v1/workspace/secrets/read",
  secretSave: "/v1/workspace/secrets/save",
  secretRemove: "/v1/workspace/secrets/remove",
  decisions: "/v1/workspace/decisions",
  vault: "/v1/workspace/vault",
} as const;

/** The largest thumbnail image that a host sends and a client accepts. */
export const WORKSPACE_ARTIFACT_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_ARTIFACT_THUMBNAIL_TYPES = ["image/webp", "image/png"] as const;
const THUMBNAIL_ROUTE = /^\/v1\/workspace\/artifacts\/([^/]{1,300})\/thumbnail$/u;

/** The image route of one artifact. The client adds `?v=<thumbnailVersion>`. */
export function workspaceArtifactThumbnailRoute(artifactId: string): string {
  return `/v1/workspace/artifacts/${encodeURIComponent(artifactId)}/thumbnail`;
}

/** The artifact id of an image route path, or null for any other path. */
export function workspaceArtifactThumbnailId(pathname: string): string | null {
  const match = THUMBNAIL_ROUTE.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

type Decoder = (value: unknown) => TeamProtocolV2Json;

const cost: Decoder = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid workspace cost.");
  return value;
};
const positive: Decoder = (value) => {
  const result = count(value);
  if (result === 0) throw new Error("Invalid workspace count.");
  return result;
};
const httpUrl: Decoder = (value) => {
  const text = string(2_048)(value);
  if (typeof text !== "string") throw new Error("Invalid workspace address.");
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid workspace address.");
  return text;
};
const artifactId: Decoder = (value) => {
  const text = string(300)(value);
  if (!text) throw new Error("Invalid workspace artifact.");
  return text;
};
const thumbnailVersion: Decoder = (value) => {
  const text = string(64)(value);
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/u.test(text)) throw new Error("Invalid workspace thumbnail.");
  return text;
};
const stepKind = oneOf("search", "browse", "tool", "shell", "file", "skill", "think");

const status = variant({
  idle: fields({ kind: oneOf("idle") }),
  working: fields(
    { kind: oneOf("working"), what: string(240), startedAt: count },
    {
      channelId: identifier,
      threadRootId: identifier,
      taskId: identifier,
      model: string(120),
      modelReason: oneOf("routine", "note", "status", "event", "default", "plan", "retry", "escalated", "large"),
    },
  ),
  waiting: fields(
    { kind: oneOf("waiting"), reason: oneOf("question", "approval", "browser", "usage-limit"), what: string(240) },
    { forMemberId: identifier, channelId: identifier, threadRootId: identifier, resetsAt: count },
  ),
  queued: fields({ kind: oneOf("queued"), count: positive }),
});

const agent = fields(
  { agentId: identifier, status },
  {
    queued: positive,
    currentStep: string(240),
    currentStepKind: stepKind,
    todayCostUsd: cost,
    todayDurationMs: count,
    lastActiveAt: count,
    currentTicket: fields({ key: string(64), title: string(240), url: httpUrl }),
  },
);

const step = fields(
  { id: identifier, kind: stepKind, label: string(160), status: oneOf("running", "done", "failed"), at: count },
  { detail: string(300), durationMs: count },
);

const steps: Decoder = (value) => {
  const result = fields(
    { steps: list(step, 60), total: count, durationMs: count, streaming: boolean },
    { startedAt: count, costUsd: cost },
  )(value);
  if (
    !isDynamicRecord(result) ||
    !Array.isArray(result.steps) ||
    typeof result.total !== "number" ||
    result.total < result.steps.length
  )
    throw new Error("Invalid workspace steps.");
  return result;
};

const artifact = fields(
  {
    id: artifactId,
    kind: oneOf("website", "app", "doc", "deck", "dashboard", "file"),
    source: oneOf("link", "site", "render", "attachment"),
    title: string(200),
    createdAt: count,
    updatedAt: count,
  },
  {
    description: string(300),
    url: httpUrl,
    thumbnailUrl: httpUrl,
    thumbnailVersion,
    file: fields({ id: identifier, name: string(255), size: count, mimeType: string(255) }),
    agentId: identifier,
    channelId: identifier,
    messageId: identifier,
    threadRootId: identifier,
    costUsd: cost,
    durationMs: count,
  },
);

const artifactLimit: Decoder = (value) => {
  const result = positive(value);
  if (typeof result !== "number" || result > 200) throw new Error("Invalid workspace artifact limit.");
  return result;
};

const pairLimit: Decoder = (value) => {
  const result = positive(value);
  if (typeof result !== "number" || result > 200) throw new Error("Invalid agent pair limit.");
  return result;
};
const exchangeLimit: Decoder = (value) => {
  const result = positive(value);
  if (typeof result !== "number" || result > 100) throw new Error("Invalid agent exchange limit.");
  return result;
};
const agentIdPair: Decoder = (value) => {
  const ids = list(identifier, 2)(value);
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) throw new Error("Invalid agent pair.");
  return ids;
};
const agentPair = fields({
  agentIds: agentIdPair,
  count,
  lastAt: count,
  lastSenderId: identifier,
  lastText: string(240),
});
const exchangeMessage = fields(
  {
    id: identifier,
    senderAgentId: identifier,
    recipientAgentIds: list(identifier, 20),
    text: string(8_000),
    createdAt: count,
  },
  { truncated: boolean, replyToMessageId: identifier, attachmentCount: count },
);

const decision = fields(
  { id: identifier, agentId: identifier, text: string(8_000), createdAt: count },
  { threadRootId: identifier },
);

const secret = fields({ scope: identifier, name: string(64), updatedAt: count });

const vaultRef = { scope: identifier, name: string(64) };
const vaultSettings = {
  type: oneOf("key", "password", "token", "code", "other"),
  label: string(80),
  folder: string(160),
  tags: list(string(32), 12),
  note: string(500),
};
const vaultAccess = fields({ everyone: boolean, agents: list(identifier, 500), spaces: list(identifier, 200) });
const vaultActor = fields(
  { kind: oneOf("owner", "person", "agent", "routine", "host") },
  { id: string(128), name: string(120) },
);
const vaultTime = count;
const vaultCall = variant({
  overview: fields({ kind: string(16) }),
  detail: fields({ kind: string(16), ...vaultRef }),
  delete: fields({ kind: string(16), ...vaultRef }),
  restore: fields({ kind: string(16), ...vaultRef }),
  purge: fields({ kind: string(16), ...vaultRef }),
  save: fields({ kind: string(16), ...vaultRef, value: string(16384) }, vaultSettings),
  update: fields(
    { kind: string(16), ...vaultRef },
    {
      ...vaultSettings,
      rotateBy: nullable(vaultTime),
      rotateEveryDays: nullable(count),
      expiresAt: nullable(vaultTime),
      access: vaultAccess,
    },
  ),
  reveal: fields({ kind: string(16), ...vaultRef, purpose: oneOf("show", "copy") }, { version: count }),
  rollback: fields({ kind: string(16), ...vaultRef, version: count }),
  export: fields({ kind: string(16), passphrase: string(256) }),
  import: fields({ kind: string(16), bundle: string(8 * 1024 * 1024), passphrase: string(256) }),
  fill: fields({ kind: string(16), requestId: identifier, value: string(16384) }),
  approve: fields({ kind: string(16), requestId: identifier, decision: oneOf("accept", "decline") }),
});
const vaultSummary = fields(
  {
    scope: identifier,
    name: string(64),
    type: oneOf("key", "password", "token", "code", "other"),
    tags: list(string(32), 12),
    access: vaultAccess,
    createdAt: vaultTime,
    updatedAt: vaultTime,
    usedBy: list(fields({ agentId: identifier, at: vaultTime }), 500),
    version: count,
  },
  {
    label: string(80),
    folder: string(160),
    note: string(500),
    rotatedAt: vaultTime,
    rotateBy: vaultTime,
    rotateEveryDays: count,
    expiresAt: vaultTime,
    lastUsedAt: vaultTime,
  },
);
const vaultRequest = variant({
  fill: fields({
    kind: string(16),
    requestId: identifier,
    agentId: identifier,
    name: string(64),
    shared: boolean,
    createdAt: vaultTime,
  }),
  approve: fields({
    kind: string(16),
    requestId: identifier,
    agentId: identifier,
    name: string(64),
    site: string(2048),
    createdAt: vaultTime,
  }),
});
const vaultResult = variant({
  overview: fields({
    kind: string(16),
    secrets: list(vaultSummary, 2000),
    trash: list(fields({ ...vaultRef, deletedAt: vaultTime }, { label: string(80), by: vaultActor }), 500),
    requests: list(vaultRequest, 200),
  }),
  detail: fields({
    kind: string(16),
    detail: fields({
      secret: vaultSummary,
      versions: list(fields({ version: count, createdAt: vaultTime, current: boolean }, { by: vaultActor }), 51),
      audit: list(
        fields(
          {
            at: vaultTime,
            action: oneOf(
              "created",
              "changed",
              "rolled-back",
              "revealed",
              "copied",
              "used",
              "blocked",
              "access-changed",
              "settings-changed",
              "deleted",
              "restored",
              "purged",
              "expired",
              "exported",
              "imported",
              "requested",
              "reminded",
            ),
            actor: vaultActor,
          },
          { detail: string(300) },
        ),
        300,
      ),
    }),
  }),
  value: fields({ kind: string(16), value: string(16384) }),
  bundle: fields({ kind: string(16), bundle: string(8 * 1024 * 1024), count }),
  imported: fields({ kind: string(16), added: count, updated: count, unchanged: count }),
  done: fields({ kind: string(16) }),
});
const secretKey = fields({ scope: identifier, name: string(64) });

export const WORKSPACE_FLEET_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    WORKSPACE_FLEET_ROUTES.fleet,
    adminRoute(
      fields({}, { timeZone: string(64) }),
      fields({ agents: list(agent, 1_000), revision: count, at: count }),
    ),
  ],
  [
    WORKSPACE_FLEET_ROUTES.steps,
    adminRoute(fields({ channelId: identifier }, { messageId: identifier, agentId: identifier }), steps),
  ],
  [
    WORKSPACE_FLEET_ROUTES.artifacts,
    adminRoute(fields({}, { channelId: identifier, limit: artifactLimit }), fields({ artifacts: list(artifact, 200) })),
  ],
  [
    WORKSPACE_FLEET_ROUTES.agentPairs,
    adminRoute(fields({}, { agentId: identifier, limit: pairLimit }), fields({ pairs: list(agentPair, 200) })),
  ],
  [
    WORKSPACE_FLEET_ROUTES.agentExchange,
    adminRoute(
      fields({ agentIds: agentIdPair }, { before: count, limit: exchangeLimit }),
      fields({ messages: list(exchangeMessage, 100), hasOlder: boolean }),
    ),
  ],
  [WORKSPACE_FLEET_ROUTES.secrets, adminRoute(fields({}), fields({ secrets: list(secret, 2000) }))],
  [WORKSPACE_FLEET_ROUTES.secretRead, adminRoute(secretKey, fields({ value: string(16384) }))],
  [
    WORKSPACE_FLEET_ROUTES.secretSave,
    adminRoute(fields({ scope: identifier, name: string(64), value: string(16384) }), fields({})),
  ],
  [WORKSPACE_FLEET_ROUTES.secretRemove, adminRoute(secretKey, fields({}))],
  [WORKSPACE_FLEET_ROUTES.vault, adminRoute(vaultCall, vaultResult)],
  [
    WORKSPACE_FLEET_ROUTES.decisions,
    adminRoute(fields({ channelId: identifier }), fields({ decisions: list(decision, 200) })),
  ],
]);

export const WORKSPACE_FLEET_CHANGED_EVENT = "workspace-fleet-changed";

export interface WorkspaceFleetChangedEvent {
  type: typeof WORKSPACE_FLEET_CHANGED_EVENT;
  revision: number;
}

/** The fleet event in `value`, or null for any other event. A malformed one throws. */
export function workspaceFleetEvent(value: unknown): WorkspaceFleetChangedEvent | null {
  if (!isDynamicRecord(value) || value.type !== WORKSPACE_FLEET_CHANGED_EVENT) return null;
  const revision = count(value.revision);
  if (typeof revision !== "number") throw new Error("Invalid workspace fleet event.");
  return { type: WORKSPACE_FLEET_CHANGED_EVENT, revision };
}
