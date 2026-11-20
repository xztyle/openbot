import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sessionClientInstance } from "../src/server/remote-session-membership";
import { migratedDatabase, migration } from "./sqlite-d1";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("remote tab sessions migration", () => {
  it("keeps one session for each device and lets each browser tab have its own", () => {
    const database = migratedDatabase("0040_server_member_limits.sql");
    databases.push(database);
    database.exec(`
      INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
      VALUES ('owner', 'email:owner@example.test', 'owner@example.test', 'Owner', NULL, 1, 1);
      INSERT INTO remote_hosts(host_id, owner_user_id, name, device_public_key, machine_token_hash, auth_epoch, created_at, updated_at)
      VALUES ('host-1', 'owner', 'Studio', 'key-a', 'token-hash', 1, 1, 1);
      INSERT INTO remote_memberships(membership_id, host_id, user_id, role, status, created_at, updated_at)
      VALUES ('m-owner', 'host-1', 'owner', 'owner', 'active', 1, 1);
      INSERT INTO remote_sessions(session_id, host_id, user_id, membership_id, started_at, expires_at, auth_session_hash)
      VALUES ('phone', 'host-1', 'owner', 'm-owner', 1, 100, 'phone-auth');
    `);

    database.exec(migration("0041_remote_tab_sessions.sql"));

    // The old Worker's insert still works, and its row is the device's one session.
    const legacy = database.prepare(
      `INSERT INTO remote_sessions(session_id, host_id, user_id, membership_id, started_at, expires_at, auth_session_hash)
       VALUES (?, 'host-1', 'owner', 'm-owner', 2, 100, ?)`,
    );
    expect(() => legacy.run("phone-again", "phone-auth")).toThrow();
    legacy.run("laptop", "browser-auth");

    const tab = database.prepare(
      `INSERT INTO remote_sessions(session_id, host_id, user_id, membership_id, started_at, expires_at, auth_session_hash, client_instance)
       VALUES (?, 'host-1', 'owner', 'm-owner', 3, 100, 'browser-auth', ?)`,
    );
    tab.run("tab-a", "instance-a");
    tab.run("tab-b", "instance-b");
    // One tab has one active session; an ended one does not count.
    expect(() => tab.run("tab-a-again", "instance-a")).toThrow();
    database.exec("UPDATE remote_sessions SET ended_at = 4 WHERE session_id = 'tab-a'");
    tab.run("tab-a-next", "instance-a");

    expect(
      database
        .prepare(
          "SELECT session_id FROM remote_sessions WHERE auth_session_hash = 'browser-auth' AND ended_at IS NULL ORDER BY session_id",
        )
        .all(),
    ).toEqual([{ session_id: "laptop" }, { session_id: "tab-a-next" }, { session_id: "tab-b" }]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("reads the tab ID of a session request", () => {
    expect(sessionClientInstance({ hostId: "host-1" })).toBeNull();
    expect(sessionClientInstance({ clientInstanceId: "0c6f5e2a-3b1d-4f7a-9e2b-8d4c1a7f6e3b" })).toBe(
      "0c6f5e2a-3b1d-4f7a-9e2b-8d4c1a7f6e3b",
    );
    expect(sessionClientInstance({ clientInstanceId: "short" })).toBeUndefined();
    expect(sessionClientInstance({ clientInstanceId: "a b c d e f g h" })).toBeUndefined();
    expect(sessionClientInstance({ clientInstanceId: 42 })).toBeUndefined();
  });
});
