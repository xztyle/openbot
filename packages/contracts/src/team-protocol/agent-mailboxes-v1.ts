// Optional agent-mailboxes wire contract of this fork, under `fork-host-v1`.
//
// What it adds, recorded here because freezing it makes it permanent: the addresses that bind a mail
// address of a business domain to one agent, and the host's link to the mail Worker
// (`apps/email-app`).
//
// - `POST /v1/owner/mailboxes` `{}` answers the state: `{ gateway: { listening (boolean), publicUrl
//   (2048 or null) }, inboxUrl (2048 or null), workerUrl (2048 or null), hasSecret (boolean),
//   lastMailAt (epoch ms or null), lastStatus (count or null), mailboxes }`. `mailboxes` holds at
//   most 64 items `{ id (128), address (254), displayName (120), agentId (128), agentName (200),
//   spaceId (128), mode: "reply" | "write-first", createdAt (epoch ms), lastMailAt (epoch ms or
//   null), received (count), sentToday (count), ownerApprovesEverySend? (boolean) }`.
// - `/v1/owner/mailboxes/save` `{ id? (128), address (254), agentId (128), mode, displayName? (120),
//   ownerApprovesEverySend? (boolean) }`. `ownerApprovesEverySend` (added after the first release, so
//   optional both ways) makes every mail from the address wait for the owner's own OK; a save without
//   it keeps the address's current value, so an older client never turns it off.
//   `/v1/owner/mailboxes/remove` `{ id }` and `/v1/owner/mailboxes/worker` `{ workerUrl (2048) }`
//   answer the state. An empty `workerUrl` clears it.
// - `/v1/owner/mailboxes/secret` `{}` makes a new mail secret and answers `{ state, secret (128) }`:
//   the only time the secret exists outside the host. The old secret stops working at once.
//
// Only the owner and the admins may use the routes; any other member gets 403. A fork host built
// before these routes answers 404, so a client fails closed there and shows nothing of it. Widening
// any of it needs a new route.
import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "../runtime-values";
import {
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const AGENT_MAILBOXES_CAPABILITY = FORK_HOST_CAPABILITY;

export const AGENT_MAILBOXES_ROUTES = {
  state: "/v1/owner/mailboxes",
  save: "/v1/owner/mailboxes/save",
  remove: "/v1/owner/mailboxes/remove",
  worker: "/v1/owner/mailboxes/worker",
  secret: "/v1/owner/mailboxes/secret",
} as const;

/** `reply`: the agent answers mail only. `write-first`: it may also write to a new address. */
export const AGENT_MAILBOX_MODES = ["reply", "write-first"] as const;
export type AgentMailboxMode = (typeof AGENT_MAILBOX_MODES)[number];
export const AGENT_MAILBOX_LIMIT = 64;
export const AGENT_MAILBOX_NAME_LIMIT = 120;

export interface AgentMailbox {
  id: string;
  address: string;
  displayName: string;
  agentId: string;
  agentName: string;
  spaceId: string;
  mode: AgentMailboxMode;
  createdAt: number;
  lastMailAt: number | null;
  received: number;
  sentToday: number;
  /** Every mail from this address, a reply too, waits for the owner's own OK (tier 2). */
  ownerApprovesEverySend: boolean;
}

export interface AgentMailboxesState {
  gateway: { listening: boolean; publicUrl: string | null };
  inboxUrl: string | null;
  workerUrl: string | null;
  hasSecret: boolean;
  lastMailAt: number | null;
  lastStatus: number | null;
  mailboxes: AgentMailbox[];
}

export interface AgentMailboxInput {
  id?: string;
  address: string;
  agentId: string;
  mode: AgentMailboxMode;
  displayName?: string;
  /** Absent keeps the address's current value. */
  ownerApprovesEverySend?: boolean;
}

const mailbox = fields(
  {
    id: identifier,
    address: string(254),
    displayName: string(AGENT_MAILBOX_NAME_LIMIT),
    agentId: identifier,
    agentName: string(200),
    spaceId: identifier,
    mode: oneOf(...AGENT_MAILBOX_MODES),
    createdAt: count,
    lastMailAt: nullable(count),
    received: count,
    sentToday: count,
  },
  { ownerApprovesEverySend: boolean },
);
const state = fields({
  gateway: fields({ listening: boolean, publicUrl: nullable(string(2_048)) }),
  inboxUrl: nullable(string(2_048)),
  workerUrl: nullable(string(2_048)),
  hasSecret: boolean,
  lastMailAt: nullable(count),
  lastStatus: nullable(count),
  mailboxes: list(mailbox, AGENT_MAILBOX_LIMIT),
});

export const AGENT_MAILBOXES_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [AGENT_MAILBOXES_ROUTES.state, adminRoute(empty, state)],
  [
    AGENT_MAILBOXES_ROUTES.save,
    adminRoute(
      fields(
        { address: string(254), agentId: identifier, mode: oneOf(...AGENT_MAILBOX_MODES) },
        { id: identifier, displayName: string(AGENT_MAILBOX_NAME_LIMIT), ownerApprovesEverySend: boolean },
      ),
      state,
    ),
  ],
  [AGENT_MAILBOXES_ROUTES.remove, adminRoute(fields({ id: identifier }), state)],
  [AGENT_MAILBOXES_ROUTES.worker, adminRoute(fields({ workerUrl: string(2_048) }), state)],
  [AGENT_MAILBOXES_ROUTES.secret, adminRoute(empty, fields({ state, secret: string(128) }))],
]);

const finite = (value: unknown): number | null => (isNumber(value) && Number.isFinite(value) ? value : null);
const text = (value: unknown): string => (isString(value) ? value : "");
const records = (value: unknown): DynamicRecord[] =>
  Array.isArray(value) ? value.flatMap((item: unknown) => (isDynamicRecord(item) ? [item] : [])) : [];

/** The state in its wire shape, as a client reads it. Throws on a malformed one. */
export function decodeAgentMailboxesState(value: unknown): AgentMailboxesState {
  const decoded = state(value);
  if (!isDynamicRecord(decoded) || !isDynamicRecord(decoded.gateway)) throw new Error("Invalid mailbox state.");
  return {
    gateway: {
      listening: isBoolean(decoded.gateway.listening) && decoded.gateway.listening,
      publicUrl: isString(decoded.gateway.publicUrl) ? decoded.gateway.publicUrl : null,
    },
    inboxUrl: isString(decoded.inboxUrl) ? decoded.inboxUrl : null,
    workerUrl: isString(decoded.workerUrl) ? decoded.workerUrl : null,
    hasSecret: decoded.hasSecret === true,
    lastMailAt: finite(decoded.lastMailAt),
    lastStatus: finite(decoded.lastStatus),
    mailboxes: records(decoded.mailboxes).map((item) => ({
      id: text(item.id),
      address: text(item.address),
      displayName: text(item.displayName),
      agentId: text(item.agentId),
      agentName: text(item.agentName),
      spaceId: text(item.spaceId),
      mode: item.mode === "write-first" ? "write-first" : "reply",
      createdAt: finite(item.createdAt) ?? 0,
      lastMailAt: finite(item.lastMailAt),
      received: finite(item.received) ?? 0,
      sentToday: finite(item.sentToday) ?? 0,
      ownerApprovesEverySend: item.ownerApprovesEverySend === true,
    })),
  };
}

/** The answer of a new secret, as a client reads it. Throws on a malformed one. */
export function decodeAgentMailSecret(value: unknown): { state: AgentMailboxesState; secret: string } {
  if (!isDynamicRecord(value) || !isString(value.secret)) throw new Error("Invalid mail secret.");
  return { state: decodeAgentMailboxesState(value.state), secret: value.secret };
}
