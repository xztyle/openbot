// Frozen optional file-tickets-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: a signed-in member asks the
// host for a link to one file that the member can already read: an attachment, a shared file or a
// file in an agent's workspace. The host answers with an https address on its own download host and
// the file's name, size and expiry. The address holds a signed, short-lived ticket; the host reads
// the file, so the ticket names no other file. A browser then downloads the file from that address
// with an ordinary request, so a file of any size streams to disk and does not pass through the
// WebRTC connection. Anyone who holds the address can read that one file until it expires.
// The route names no capability of its own: it shares `fork-host-v1`.
import { adminRoute, count, fields, identifier, nullable, type OptionalRouteCodec, oneOf, string } from "./admin-wire";
import { FORK_HOST_CAPABILITY } from "./fork-host-v1";

export const FILE_TICKETS_CAPABILITY = FORK_HOST_CAPABILITY;

export const FILE_TICKET_ROUTES = {
  /** Mints a ticket for one file. A host without a download address answers 400, and the client falls back. */
  create: "/v1/file-tickets",
} as const;

export type FileTicketSource =
  | { kind: "attachment"; attachmentId: string }
  | { kind: "shared"; path: string }
  | { kind: "workspace"; agentId: string; path: string };

export interface FileTicket {
  /** An https address on the host's download host. It is a secret until `expiresAt`. */
  url: string;
  name: string;
  size: number;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export const FILE_TICKETS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    FILE_TICKET_ROUTES.create,
    adminRoute(
      fields({
        kind: oneOf("attachment", "shared", "workspace"),
        attachmentId: nullable(identifier),
        agentId: nullable(identifier),
        path: nullable(string(4096)),
      }),
      fields({ url: string(2048), name: string(512), size: count, expiresAt: count }),
    ),
  ],
]);
