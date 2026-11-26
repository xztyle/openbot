// Optional file-references-v1 wire contract (fork only, shares `fork-host-v1`).
//
// What it grants, recorded here because freezing it makes it permanent:
//
// - `POST /v1/file-references/open` `{ agentId (or null), path (4096) }` opens a file or a folder that a
//   message names: an absolute host path, an `OpenBot/Spaces/<space>/Shared/…` path, a path relative to
//   the agent's workspace, or a bare file name that the host looks for in that agent's folders. A
//   member opens only the workspaces of agents they can see and the shared folders of the spaces of
//   those agents (plus the old global `OpenBot/Shared`). A hidden name or a secret never opens.
// - A file answers `{ kind: "file", attachment }`: the host keeps a copy as an attachment, which the
//   attachment routes and their renditions read as any other. At most the attachment size limit.
// - A folder answers `{ kind: "folder", name, path, entries, truncated }`, at most 500 entries
//   `{ name, path, kind: "file" | "directory", size }` of the folder and of its folders two levels
//   down: `name` is the path inside the folder with `/` separators, and each `path` is the host path,
//   which this route accepts again.
// - Anything else answers 404 with one plain sentence, the same for a path outside what the member
//   may see and a missing one; a file over the limit answers 413.
//
// A fork host built before this route answers 404, and the client shows that sentence too.
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

export const FILE_REFERENCES_CAPABILITY = FORK_HOST_CAPABILITY;

export const FILE_REFERENCES_ROUTES = {
  open: "/v1/file-references/open",
} as const;

const path = string(4_096);

export const FILE_REFERENCES_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    FILE_REFERENCES_ROUTES.open,
    adminRoute(
      fields({ agentId: nullable(identifier), path }),
      variant({
        file: fields({
          kind: oneOf("file"),
          attachment: fields({
            id: identifier,
            name: string(255),
            size: count,
            kind: oneOf("image", "file"),
            mimeType: string(255),
            previewKind: oneOf("image", "pdf", "text", "none"),
            previewUrl: nullable(string(2_048)),
          }),
        }),
        folder: fields({
          kind: oneOf("folder"),
          name: string(1_024),
          path,
          entries: list(fields({ name: string(1_024), path, kind: oneOf("file", "directory"), size: count }), 500),
          truncated: boolean,
        }),
      }),
    ),
  ],
]);
