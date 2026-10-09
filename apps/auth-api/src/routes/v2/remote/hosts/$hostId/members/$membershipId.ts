import { createFileRoute } from "@tanstack/solid-router";
import { Effect } from "effect";
import { runApiResponse } from "../../../../../../server/effect-runtime";
import { readJsonObject } from "../../../../../../server/json-body";
import {
  apiError,
  remoteControlPlaneErrorResponse,
  requestInteractiveUser,
  requestRemoteControlPlane,
  requestUser,
} from "../../../../../../server/request-auth";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/members/$membershipId")({
  server: {
    handlers: {
      PATCH: ({ request, params }) =>
        runApiResponse(
          Effect.gen(function* () {
            const user = yield* requestUser(request);
            if (!user) return apiError(401, "unauthorized", "Sign in is required.");
            const body = yield* readJsonObject(request);
            if (body.role !== "admin" && body.role !== "member")
              return apiError(400, "invalid_remote_request", "The member role is invalid.");
            if (body.reactivate !== undefined && body.reactivate !== true)
              return apiError(400, "invalid_remote_request", "The member status is invalid.");
            // A server's own sign-in may lower a role. Making an admin, or bringing back a removed
            // member, needs a person's own sign-in.
            if (body.role === "admin" || body.reactivate === true) yield* requestInteractiveUser(request);
            yield* requestRemoteControlPlane().changeMembership(user.id, {
              hostId: params.hostId,
              membershipId: params.membershipId,
              role: body.role,
              reactivate: body.reactivate === true,
            });
            return new Response(null, { status: 204 });
          }),
          remoteControlPlaneErrorResponse,
        ),
      DELETE: ({ request, params }) =>
        runApiResponse(
          Effect.gen(function* () {
            const user = yield* requestUser(request);
            if (!user) return apiError(401, "unauthorized", "Sign in is required.");
            yield* requestRemoteControlPlane().changeMembership(user.id, {
              hostId: params.hostId,
              membershipId: params.membershipId,
              revoke: true,
            });
            return new Response(null, { status: 204 });
          }),
          remoteControlPlaneErrorResponse,
        ),
    },
  },
});
