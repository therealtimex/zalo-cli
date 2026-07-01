import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = join(tmpdir(), "zalo-agent-cli-test-temp-db");
process.env.ZALO_CONFIG_DIR = tempHome;

// Dynamically import db.js and lock.js so process.env.ZALO_CONFIG_DIR is set beforehand
const {
    initDatabase,
    closeDatabase,
    getDb,
    upsertContact,
    upsertGroup,
    upsertMessage,
    getLocalChats,
    getLocalFriends,
    getLocalMessages,
    getLocalMessagesCount,
    getLocalStatusBroadcasts,
    searchLocalMessages,
} = await import("./db.js");

const { AccountLock } = await import("./lock.js");
const { persistOutgoingTextMessage } = await import("../commands/msg.js");

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
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((r) => r.name);
        assert.ok(tables.includes("chats"), "chats table should exist");
        assert.ok(tables.includes("contacts"), "contacts table should exist");
        assert.ok(tables.includes("groups"), "groups table should exist");
        assert.ok(tables.includes("group_participants"), "group_participants table should exist");
        assert.ok(tables.includes("messages"), "messages table should exist");

        // Verify triggers exist
        const triggers = db
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
            .all()
            .map((r) => r.name);
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

    it("searches cached messages with FTS5 when available", async () => {
        const ownId = "test_user_fts_search";
        await initDatabase(ownId);

        upsertMessage({
            msgId: "fts-1",
            threadId: "thread-a",
            senderId: "alice",
            senderName: "Alice",
            ts: 1000,
            text: "Quarterly planning notes",
            msgType: "text",
        });
        upsertMessage({
            msgId: "fts-2",
            threadId: "thread-a",
            senderId: "bob",
            senderName: "Bob",
            ts: 2000,
            text: "Lunch plans",
            msgType: "text",
        });

        const result = searchLocalMessages({ query: "quarterly", limit: 10 });

        assert.equal(result.mode, "fts5");
        assert.equal(result.fallback, false);
        assert.deepEqual(
            result.messages.map((m) => m.msgId),
            ["fts-1"],
        );
    });

    it("falls back to LIKE search when FTS5 is unavailable", async () => {
        const ownId = "test_user_like_fallback";
        await initDatabase(ownId);

        const db = getDb();
        db.exec(`
            DROP TRIGGER IF EXISTS trg_messages_ai;
            DROP TRIGGER IF EXISTS trg_messages_au;
            DROP TRIGGER IF EXISTS trg_messages_ad;
            DROP TABLE IF EXISTS messages_fts;
        `);

        upsertMessage({
            msgId: "like-1",
            threadId: "thread-like",
            senderId: "alice",
            senderName: "Alice",
            ts: 1000,
            text: "Find me without full text search",
            msgType: "text",
        });
        upsertMessage({
            msgId: "like-2",
            threadId: "thread-like",
            senderId: "bob",
            senderName: "Bob",
            ts: 2000,
            text: "Other cached message",
            msgType: "text",
        });

        const result = searchLocalMessages({ query: "without full", limit: 10 });

        assert.equal(result.mode, "like");
        assert.equal(result.fallback, true);
        assert.match(result.ftsError, /messages_fts/);
        assert.deepEqual(
            result.messages.map((m) => m.msgId),
            ["like-1"],
        );
    });

    it("combines thread, sender, direction, time range, and message type filters", async () => {
        const ownId = "test_user_combined_filters";
        await initDatabase(ownId);

        const rows = [
            {
                msgId: "filter-hit",
                threadId: "thread-1",
                senderId: "sender-1",
                senderName: "Sender One",
                ts: 2000,
                fromMe: 0,
                text: "Receipt image uploaded",
                msgType: "image",
            },
            {
                msgId: "filter-wrong-thread",
                threadId: "thread-2",
                senderId: "sender-1",
                senderName: "Sender One",
                ts: 2000,
                fromMe: 0,
                text: "Receipt image uploaded",
                msgType: "image",
            },
            {
                msgId: "filter-wrong-direction",
                threadId: "thread-1",
                senderId: "sender-1",
                senderName: "Sender One",
                ts: 2000,
                fromMe: 1,
                text: "Receipt image uploaded",
                msgType: "image",
            },
            {
                msgId: "filter-wrong-type",
                threadId: "thread-1",
                senderId: "sender-1",
                senderName: "Sender One",
                ts: 2000,
                fromMe: 0,
                text: "Receipt image uploaded",
                msgType: "text",
            },
            {
                msgId: "filter-wrong-time",
                threadId: "thread-1",
                senderId: "sender-1",
                senderName: "Sender One",
                ts: 5000,
                fromMe: 0,
                text: "Receipt image uploaded",
                msgType: "image",
            },
        ];
        for (const row of rows) upsertMessage(row);

        const result = searchLocalMessages({
            query: "receipt",
            threadId: "thread-1",
            sender: "sender-1",
            direction: "incoming",
            since: 1000,
            until: 3000,
            msgType: "image",
            limit: 10,
        });

        assert.equal(result.mode, "fts5");
        assert.deepEqual(
            result.messages.map((m) => m.msgId),
            ["filter-hit"],
        );
    });

    it("stores status broadcasts separately from regular chat messages", async () => {
        const ownId = "test_user_status_broadcasts";
        await initDatabase(ownId);

        upsertMessage({
            msgId: "status-1",
            threadId: "status@broadcast",
            senderId: "friend-1",
            senderName: "Friend One",
            ts: 1000,
            text: "Story update from cache",
            msgType: "image",
        });
        upsertMessage({
            msgId: "chat-1",
            threadId: "friend-1",
            senderId: "friend-1",
            senderName: "Friend One",
            ts: 2000,
            text: "Story update in direct chat",
            msgType: "text",
        });

        assert.equal(getLocalMessagesCount("status@broadcast"), 0);
        assert.equal(getLocalMessagesCount("friend-1"), 1);

        const regular = searchLocalMessages({ query: "story", limit: 10 });
        assert.deepEqual(
            regular.messages.map((m) => m.msgId),
            ["chat-1"],
        );

        const statuses = getLocalStatusBroadcasts({ query: "story", limit: 10 });
        assert.deepEqual(
            statuses.map((m) => m.msgId),
            ["status-1"],
        );
    });

    it("persists successful outgoing text sends with returned Zalo message id", async () => {
        const ownId = "test_user_outgoing_returned_id";
        await initDatabase(ownId);

        const msgId = persistOutgoingTextMessage({
            threadId: "thread_1",
            threadType: 0,
            text: "Hello from CLI",
            payload: "Hello from CLI",
            result: { message: { msgId: "zalo_msg_1" }, cliMsgId: "client_1" },
            ownId,
            sentAt: 1234567890,
        });

        assert.equal(msgId, "zalo_msg_1");

        const row = getDb().prepare("SELECT * FROM messages WHERE msg_id = ?").get("zalo_msg_1");
        assert.equal(row.thread_id, "thread_1");
        assert.equal(row.from_me, 1);
        assert.equal(row.text, "Hello from CLI");
        assert.equal(row.msg_type, "text");
        assert.equal(row.sender_id, ownId);

        const content = JSON.parse(row.content_json);
        assert.equal(content.direction, "outgoing");
        assert.equal(content.payload, "Hello from CLI");
        assert.equal(content.result.message.msgId, "zalo_msg_1");
    });

    it("persists outgoing text sends with a stable client fallback id", async () => {
        const ownId = "test_user_outgoing_fallback_id";
        await initDatabase(ownId);

        const sendMetadata = {
            threadId: "thread_2",
            threadType: 1,
            text: "Styled CLI text",
            payload: { msg: "Styled CLI text", styles: [{ start: 0, len: 6, st: "b" }] },
            result: { cliMsgId: "client_2", status: "ok" },
            ownId,
            sentAt: 2234567890,
        };

        const msgId = persistOutgoingTextMessage(sendMetadata);
        const duplicateMsgId = persistOutgoingTextMessage({ ...sendMetadata, sentAt: 3234567890 });

        assert.equal(duplicateMsgId, msgId);
        assert.match(msgId, /^client:[a-f0-9]{24}$/);
        assert.equal(getLocalMessagesCount("thread_2"), 1);

        const row = getDb().prepare("SELECT * FROM messages WHERE msg_id = ?").get(msgId);
        assert.equal(row.thread_id, "thread_2");
        assert.equal(row.from_me, 1);
        assert.equal(row.text, "Styled CLI text");
        assert.equal(row.msg_type, "text");
        assert.equal(row.sender_id, ownId);
        assert.equal(row.ts, 3234567890);

        const content = JSON.parse(row.content_json);
        assert.deepEqual(content.payload, sendMetadata.payload);
        assert.equal(content.result.cliMsgId, "client_2");
    });

    it("uses the same outgoing fallback id for undefined and null optional hash fields", async () => {
        const ownId = "test_user_outgoing_fallback_null_id";
        await initDatabase(ownId);

        const undefinedMsgId = persistOutgoingTextMessage({
            threadId: "thread_3",
            threadType: undefined,
            text: undefined,
            payload: undefined,
            result: {},
            ownId: null,
            sentAt: 4234567890,
        });

        const nullMsgId = persistOutgoingTextMessage({
            threadId: "thread_3",
            threadType: null,
            text: null,
            payload: null,
            result: { cliMsgId: null },
            ownId: null,
            sentAt: 5234567890,
        });

        assert.equal(nullMsgId, undefinedMsgId);
        assert.match(undefinedMsgId, /^client:[a-f0-9]{24}$/);
        assert.equal(getLocalMessagesCount("thread_3"), 1);

        const row = getDb().prepare("SELECT * FROM messages WHERE msg_id = ?").get(undefinedMsgId);
        assert.equal(row.thread_id, "thread_3");
        assert.equal(row.from_me, 1);
        assert.equal(row.sender_id, null);
        assert.equal(row.ts, 5234567890);
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
