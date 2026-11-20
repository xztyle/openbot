-- One remote session for each browser tab. The tabs of one browser share one account session, so
-- before this a second tab took the first tab's remote session and Signal closed the first tab's
-- socket. A web client now names its tab in `client_instance`; each tab keeps its own session and
-- the host keeps a peer for each. Native apps send no instance and keep one session for each device.
-- Nullable, so the Worker that runs during the deploy still writes rows; those rows behave as before.
ALTER TABLE remote_sessions ADD COLUMN client_instance TEXT;

DROP INDEX IF EXISTS remote_sessions_one_active_per_device_host;
CREATE UNIQUE INDEX IF NOT EXISTS remote_sessions_one_active_per_tab_host
  ON remote_sessions(host_id, user_id, auth_session_hash, ifnull(client_instance, ''))
  WHERE ended_at IS NULL AND auth_session_hash IS NOT NULL;
