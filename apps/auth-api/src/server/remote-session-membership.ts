import type { RemoteMemberRole } from "@openbot/contracts/signal-protocol/ticket";

export interface SessionMembershipRow {
  membership_id: string;
  host_id: string;
  user_id: string;
  role: RemoteMemberRole;
  status: "active" | "revoked";
  active_session_id: string | null;
  active_expires_at: number | null;
  auth_expires_at: number | null;
}

const SESSION_MEMBERSHIP_SQL = `
  SELECT m.membership_id, m.host_id, m.user_id, m.role, m.status,
         s.session_id AS active_session_id, s.expires_at AS active_expires_at,
         (SELECT expires_at FROM auth_sessions
           WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?)
           AS auth_expires_at
    FROM remote_memberships m
    LEFT JOIN remote_sessions s
      ON s.host_id = m.host_id AND s.user_id = m.user_id AND s.membership_id = m.membership_id
     AND s.ended_at IS NULL AND s.expires_at > ? AND s.auth_session_hash = ?
   WHERE m.host_id = ? AND m.user_id = ? AND m.status = 'active'
   ORDER BY s.started_at DESC LIMIT 1`;

export function readSessionMembership(
  database: D1Database,
  userId: string,
  hostId: string,
  authSessionHash: string,
  now: number,
): Promise<SessionMembershipRow | null> {
  return database
    .prepare(SESSION_MEMBERSHIP_SQL)
    .bind(authSessionHash, userId, now, now, authSessionHash, hostId, userId)
    .first<SessionMembershipRow>();
}
