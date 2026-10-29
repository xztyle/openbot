// Optional workspace fleet wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent:
//
// - `POST /v1/workspace/fleet` `{ timeZone? (64) }` answers `{ agents, revision, at }`: for each agent
//   that the member can see (its roles, not hidden, not in the background), `{ agentId, status,
//   queued?, currentStep? (240), currentStepKind?, todayCostUsd?, todayDurationMs?, lastActiveAt? }`.
//   `status` is `{ kind: "idle" }`, `{ kind: "working", what (240), channelId?, threadRootId?,
//   taskId?, startedAt }`, `{ kind: "waiting", reason: "question" | "approval" | "browser", what
//   (240), forMemberId?, channelId?, threadRootId? }` or `{ kind: "queued", count }`. At most 500
//   agents. Times are epoch milliseconds.
// - `POST /v1/workspace/steps` `{ channelId, messageId }` answers `{ steps, total, durationMs,
//   streaming, startedAt?, costUsd? }` for a message of a channel the member can see: at most 60
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
    { channelId: identifier, threadRootId: identifier, taskId: identifier },
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

export const WORKSPACE_FLEET_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    WORKSPACE_FLEET_ROUTES.fleet,
    adminRoute(fields({}, { timeZone: string(64) }), fields({ agents: list(agent, 500), revision: count, at: count })),
  ],
  [WORKSPACE_FLEET_ROUTES.steps, adminRoute(fields({ channelId: identifier, messageId: identifier }), steps)],
  [
    WORKSPACE_FLEET_ROUTES.artifacts,
    adminRoute(fields({}, { channelId: identifier, limit: artifactLimit }), fields({ artifacts: list(artifact, 200) })),
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
