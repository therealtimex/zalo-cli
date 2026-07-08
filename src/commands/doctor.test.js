import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = join(tmpdir(), "zalo-agent-cli-test-temp-doctor");
process.env.ZALO_CONFIG_DIR = tempHome;

const { initDatabase, closeDatabase, upsertContact, upsertGroup, upsertMessage } = await import("../core/db.js");
const { addAccount } = await import("../core/accounts.js");
const { saveCredentials } = await import("../core/credentials.js");
const { inspectLocalDoctorState, runDoctor } = await import("./doctor.js");

describe("doctor command local inspection", () => {
    beforeEach(() => {
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    afterEach(() => {
        closeDatabase();
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    it("reports missing auth and store without attempting live connectivity", async () => {
        const state = await runDoctor();

        assert.equal(state.auth.active, false);
        assert.equal(state.auth.credentials_present, false);
        assert.equal(state.store.exists, false);
        assert.equal(state.connect.requested, false);
        assert.equal(state.connect.attempted, false);
    });

    it("reports JSON-safe store counts, auth identity, search, lock, and heartbeat activity", async () => {
        const ownId = "doctor_user";
        addAccount(ownId, "Doctor User", null);
        saveCredentials(ownId, { imei: "imei", cookie: [], userAgent: "ua" });
        await initDatabase(ownId);

        upsertContact({ userId: "friend_1", displayName: "Friend", isFriend: 1 });
        upsertGroup({ groupId: "group_1", name: "Group", memberCount: 2 });
        upsertMessage({
            msgId: "msg_1",
            threadId: "friend_1",
            senderId: "friend_1",
            senderName: "Friend",
            ts: 1700000000000,
            text: "indexed doctor message",
            msgType: "text",
        });
        closeDatabase();

        const accountDir = join(tempHome, "accounts", ownId);
        const heartbeatPath = join(accountDir, "HEARTBEAT");
        fs.writeFileSync(heartbeatPath, "ok\n");
        const heartbeatDate = new Date("2026-01-02T03:04:05.000Z");
        fs.utimesSync(heartbeatPath, heartbeatDate, heartbeatDate);
        fs.writeFileSync(join(accountDir, "LOCK"), "pid=999999\nacquired_at=2026-01-02T03:00:00.000Z");

        const state = inspectLocalDoctorState();
        assert.equal(state.auth.active, true);
        assert.equal(state.auth.own_id, ownId);
        assert.equal(state.auth.name, "Doctor User");
        assert.equal(state.auth.credentials_present, true);
        assert.equal(state.store.counts.chats, 2);
        assert.equal(state.store.counts.contacts, 1);
        assert.equal(state.store.counts.groups, 1);
        assert.equal(state.store.counts.messages, 1);
        assert.equal(state.store.last_sync_at, "2023-11-14T22:13:20.000Z");
        assert.equal(state.store.last_activity_at, "2026-01-02T03:04:05.000Z");
        assert.equal(state.search.enabled, true);
        assert.equal(state.search.indexed_messages, 1);
        assert.equal(state.lock.present, true);
        assert.equal(state.lock.pid, 999999);
        assert.equal(state.lock.stale, true);
    });

    it("--connect gates live checks on auth before attempting login", async () => {
        const state = await runDoctor({ connect: true, lockWait: 10 });

        assert.equal(state.connect.requested, true);
        assert.equal(state.connect.attempted, false);
        assert.match(state.connect.error, /No active account/);
    });

    it("--connect requires the account lock before live connectivity", async () => {
        const ownId = "locked_user";
        addAccount(ownId, "Locked User", null);
        saveCredentials(ownId, { imei: "imei", cookie: [], userAgent: "ua" });
        const accountDir = join(tempHome, "accounts", ownId);
        fs.writeFileSync(join(accountDir, "LOCK"), `pid=${process.pid}\nacquired_at=2026-01-02T03:00:00.000Z`);

        const state = await runDoctor({ connect: true, lockWait: 10 });

        assert.equal(state.connect.requested, true);
        assert.equal(state.connect.attempted, false);
        assert.match(state.connect.error, /Could not acquire account lock/);
    });
});
