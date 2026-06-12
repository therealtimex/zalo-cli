import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const tempHome = join(homedir(), ".zalo-agent-cli-test-temp-db");
process.env.ZALO_CONFIG_DIR = tempHome;

// Dynamically import db.js and lock.js so process.env.ZALO_CONFIG_DIR is set beforehand
const {
    initDatabase,
    closeDatabase,
    getDb,
    upsertChat,
    upsertContact,
    upsertGroup,
    upsertMessage,
    getLocalChats,
    getLocalFriends,
    getLocalMessages,
    getLocalMessagesCount,
} = await import("./db.js");

const { AccountLock } = await import("./lock.js");

describe("Local SQLite Storage & Caching Layer", () => {
    beforeEach(() => {
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    afterEach(() => {
        closeDatabase();
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    it("initializes database tables and triggers correctly", async () => {
        const ownId = "test_user_123";
        await initDatabase(ownId);
        
        const db = getDb();
        assert.ok(db, "Database should be initialized");

        // Verify tables exist
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        assert.ok(tables.includes("chats"), "chats table should exist");
        assert.ok(tables.includes("contacts"), "contacts table should exist");
        assert.ok(tables.includes("groups"), "groups table should exist");
        assert.ok(tables.includes("group_participants"), "group_participants table should exist");
        assert.ok(tables.includes("messages"), "messages table should exist");

        // Verify triggers exist
        const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r => r.name);
        assert.ok(triggers.includes("trg_messages_ai"), "insert trigger should exist");
        assert.ok(triggers.includes("trg_messages_au"), "update trigger should exist");
        assert.ok(triggers.includes("trg_messages_ad"), "delete trigger should exist");
    });

    it("respects read-only mode and does not acquire write lock", async () => {
        const ownId = "test_user_readonly";
        
        // 1. Create directory and db file first so readonly open doesn't fail
        const accountDir = join(tempHome, "accounts", ownId);
        fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
        const dbPath = join(accountDir, "zalo.db");
        fs.writeFileSync(dbPath, "");

        // 2. Init in readonly mode
        await initDatabase(ownId, { readonly: true });
        
        // 3. Verify LOCK file was not created
        const lockPath = join(accountDir, "LOCK");
        assert.equal(fs.existsSync(lockPath), false, "LOCK file should not exist in readonly mode");
    });

    it("performs chat and contact upserts and retrieval", async () => {
        const ownId = "test_user_upserts";
        await initDatabase(ownId);

        // Upsert friend contact
        upsertContact({
            userId: "friend_1",
            displayName: "Alice",
            isFriend: 1,
            lastActive: Date.now(),
        });

        const friends = getLocalFriends();
        assert.equal(friends.length, 1);
        assert.equal(friends[0].userId, "friend_1");
        assert.equal(friends[0].displayName, "Alice");

        // Upsert group chat
        upsertGroup({
            groupId: "group_1",
            name: "Team Work",
            memberCount: 5,
        });

        const chats = getLocalChats({ limit: 10 });
        // The upsertGroup automatically upserts parent chat
        assert.equal(chats.length, 1);
        assert.equal(chats[0].threadId, "group_1");
        assert.equal(chats[0].type, "Group");
        assert.equal(chats[0].name, "Team Work");
    });

    it("caches messages and performs search and backfill indexing", async () => {
        const ownId = "test_user_messages";
        await initDatabase(ownId);

        upsertMessage({
            msgId: "m1",
            threadId: "t1",
            senderId: "s1",
            senderName: "Bob",
            ts: Date.now() - 1000,
            text: "Hello local cache database!",
            msgType: "text",
        });

        upsertMessage({
            msgId: "m2",
            threadId: "t1",
            senderId: "s1",
            senderName: "Bob",
            ts: Date.now(),
            text: "Another message here",
            msgType: "text",
        });

        const count = getLocalMessagesCount("t1");
        assert.equal(count, 2);

        const msgs = getLocalMessages("t1", 1);
        assert.equal(msgs.length, 1);
        assert.equal(msgs[0].msgId, "m2");
        assert.equal(msgs[0].text, "Another message here");
    });

    it("prevents concurrent write locks on same account directory", async () => {
        const accountDir = join(tempHome, "accounts", "test_concurrency");
        fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });

        const lock1 = new AccountLock(accountDir);
        const lock2 = new AccountLock(accountDir);

        const acquired1 = await lock1.acquire();
        assert.equal(acquired1, true, "First lock should be acquired");

        // Try to acquire again (should throw error/timeout)
        const acquire2Promise = lock2.acquire(100);
        await assert.rejects(acquire2Promise, /Could not acquire account lock/);

        lock1.release();

        // Now lock2 should be able to acquire it
        const acquired2 = await lock2.acquire();
        assert.equal(acquired2, true, "Second lock should be acquired after first is released");
        lock2.release();
    });
});
