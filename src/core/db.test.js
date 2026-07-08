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
    upsertChat,
    upsertContact,
    upsertGroup,
    upsertGroupParticipant,
    upsertMessage,
    cleanupLocalStore,
    getLocalMessageById,
    getLocalMessageContext,
    getLocalChats,
    getLocalFriends,
    getLocalMessages,
    getLocalMessagesCount,
    getLocalStoreStats,
    getLocalStatusBroadcasts,
    planLocalStoreCleanup,
    listLocalMessages,
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
                localPath: "/tmp/receipt.png",
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
            hasMedia: true,
            limit: 10,
        });

        assert.equal(result.mode, "fts5");
        assert.deepEqual(
            result.messages.map((m) => m.msgId),
            ["filter-hit"],
        );
        assert.equal(result.messages[0].localPath, "/tmp/receipt.png");
    });

    it("lists cached messages with filters, ordering, recalled rows, and empty results", async () => {
        const ownId = "test_user_local_list";
        await initDatabase(ownId);

        upsertChat({ threadId: "thread-list", type: 1, name: "List Thread", lastMessageTs: 5000 });
        const rows = [
            {
                msgId: "list-1",
                threadId: "thread-list",
                senderId: "alice",
                senderName: "Alice",
                ts: 1000,
                fromMe: 0,
                text: "plain text",
                msgType: "text",
            },
            {
                msgId: "list-2",
                threadId: "thread-list",
                senderId: ownId,
                senderName: "Me",
                ts: 2000,
                fromMe: 1,
                text: "photo sent",
                msgType: "image",
                localPath: "/tmp/photo.jpg",
            },
            {
                msgId: "list-3",
                threadId: "thread-list",
                senderId: "alice",
                senderName: "Alice",
                ts: 3000,
                fromMe: 0,
                text: null,
                msgType: "text",
                recalled: 1,
            },
            {
                msgId: "list-other-thread",
                threadId: "other-thread",
                senderId: "alice",
                senderName: "Alice",
                ts: 2500,
                fromMe: 0,
                text: "wrong thread",
                msgType: "image",
                localPath: "/tmp/other.jpg",
            },
        ];
        for (const row of rows) upsertMessage(row);

        const desc = listLocalMessages({ threadId: "thread-list", limit: 2 });
        assert.deepEqual(
            desc.map((m) => m.msgId),
            ["list-3", "list-2"],
        );
        assert.equal(desc[0].threadName, "List Thread");
        assert.equal(desc[0].recalled, true);

        const asc = listLocalMessages({ threadId: "thread-list", order: "asc", limit: 3 });
        assert.deepEqual(
            asc.map((m) => m.msgId),
            ["list-1", "list-2", "list-3"],
        );

        const mediaFromMe = listLocalMessages({
            threadId: "thread-list",
            sender: ownId,
            direction: "outgoing",
            msgType: "image",
            hasMedia: true,
            since: 1500,
            until: 2500,
            limit: 10,
        });
        assert.deepEqual(
            mediaFromMe.map((m) => m.msgId),
            ["list-2"],
        );
        assert.equal(mediaFromMe[0].localPath, "/tmp/photo.jpg");
        assert.equal(mediaFromMe[0].fromMe, true);

        assert.deepEqual(listLocalMessages({ threadId: "missing-thread", limit: 10 }), []);
    });

    it("rejects unsafe local list limits and invalid sort order", async () => {
        const ownId = "test_user_local_list_validation";
        await initDatabase(ownId);

        upsertMessage({
            msgId: "list-validation-1",
            threadId: "thread-list-validation",
            senderId: "alice",
            senderName: "Alice",
            ts: 1000,
            text: "validation row",
            msgType: "text",
        });

        assert.throws(() => listLocalMessages({ limit: 0 }), /limit must be an integer greater than or equal to 1/);
        assert.throws(() => listLocalMessages({ limit: -1 }), /limit must be an integer greater than or equal to 1/);
        assert.throws(() => listLocalMessages({ limit: "abc" }), /limit must be an integer greater than or equal to 1/);
        assert.throws(() => listLocalMessages({ order: "sideways" }), /order must be asc or desc/);
    });

    it("gets one cached message by id with parsed and raw content metadata", async () => {
        const ownId = "test_user_local_show";
        await initDatabase(ownId);

        upsertChat({ threadId: "thread-show", type: 0, name: "Show Thread", lastMessageTs: 1000 });
        const content = { actionId: "action-show-1", attachment: { width: 640 }, nested: true };
        upsertMessage({
            msgId: "show-1",
            threadId: "thread-show",
            senderId: "bob",
            senderName: "Bob",
            ts: 1234,
            fromMe: 0,
            text: "full message text",
            msgType: "image",
            contentJson: JSON.stringify(content),
            localPath: "/tmp/show.png",
            recalled: 1,
        });

        const message = getLocalMessageById("show-1");
        assert.equal(message.msgId, "show-1");
        assert.equal(message.threadId, "thread-show");
        assert.equal(message.threadName, "Show Thread");
        assert.equal(message.senderId, "bob");
        assert.equal(message.senderName, "Bob");
        assert.equal(message.timestamp, 1234);
        assert.equal(message.fromMe, false);
        assert.equal(message.direction, "incoming");
        assert.equal(message.type, "image");
        assert.equal(message.text, "full message text");
        assert.equal(message.localPath, "/tmp/show.png");
        assert.equal(message.recalled, true);
        assert.deepEqual(message.content, content);
        assert.equal(message.rawContentJson, JSON.stringify(content));
        assert.equal(getLocalMessageById("missing-message"), null);
    });

    it("returns same-thread context before and after a cached target message", async () => {
        const ownId = "test_user_local_context";
        await initDatabase(ownId);

        upsertChat({ threadId: "thread-context", type: 0, name: "Context Thread", lastMessageTs: 5000 });
        for (const row of [
            ["ctx-1", "thread-context", 1000],
            ["ctx-2", "thread-context", 2000],
            ["ctx-3", "thread-context", 3000],
            ["ctx-4", "thread-context", 4000],
            ["ctx-other", "other-context", 2500],
        ]) {
            upsertMessage({
                msgId: row[0],
                threadId: row[1],
                senderId: "sender",
                senderName: "Sender",
                ts: row[2],
                text: row[0],
                msgType: "text",
            });
        }

        const context = getLocalMessageContext("ctx-3", { before: 2, after: 2 });
        assert.equal(context.target.msgId, "ctx-3");
        assert.deepEqual(
            context.before.map((m) => m.msgId),
            ["ctx-1", "ctx-2"],
        );
        assert.deepEqual(
            context.after.map((m) => m.msgId),
            ["ctx-4"],
        );
        assert.ok(!context.before.some((m) => m.msgId === "ctx-other"));
        assert.ok(!context.after.some((m) => m.msgId === "ctx-other"));

        const edge = getLocalMessageContext("ctx-1", { before: 3, after: 1 });
        assert.deepEqual(edge.before, []);
        assert.deepEqual(
            edge.after.map((m) => m.msgId),
            ["ctx-2"],
        );

        const zeroWindow = getLocalMessageContext("ctx-3", { before: 0, after: 0 });
        assert.deepEqual(zeroWindow.before, []);
        assert.deepEqual(zeroWindow.after, []);

        assert.deepEqual(getLocalMessageContext("missing-context", { before: 1, after: 1 }), {
            target: null,
            before: [],
            after: [],
        });
    });

    it("rejects negative and non-numeric local context window sizes", async () => {
        const ownId = "test_user_local_context_validation";
        await initDatabase(ownId);

        upsertMessage({
            msgId: "ctx-validation-1",
            threadId: "thread-context-validation",
            senderId: "alice",
            senderName: "Alice",
            ts: 1000,
            text: "validation row",
            msgType: "text",
        });

        assert.throws(
            () => getLocalMessageContext("ctx-validation-1", { before: -1 }),
            /before must be an integer greater than or equal to 0/,
        );
        assert.throws(
            () => getLocalMessageContext("ctx-validation-1", { after: -1 }),
            /after must be an integer greater than or equal to 0/,
        );
        assert.throws(
            () => getLocalMessageContext("ctx-validation-1", { before: "many" }),
            /before must be an integer greater than or equal to 0/,
        );
        assert.throws(
            () => getLocalMessageContext("ctx-validation-1", { after: "many" }),
            /after must be an integer greater than or equal to 0/,
        );
    });

    it("falls back to LIKE for special-character-only queries", async () => {
        const ownId = "test_user_special_query_fallback";
        await initDatabase(ownId);

        upsertMessage({
            msgId: "special-1",
            threadId: "thread-special",
            senderId: "alice",
            senderName: "Alice",
            ts: 1000,
            text: "Can you check invoice #123?",
            msgType: "text",
        });

        const result = searchLocalMessages({ query: "?", limit: 10 });

        assert.equal(result.mode, "like");
        assert.equal(result.fallback, false);
        assert.deepEqual(
            result.messages.map((m) => m.msgId),
            ["special-1"],
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

    it("reports local store stats including recalled and downloaded media accounting", async () => {
        const ownId = "test_user_store_stats";
        await initDatabase(ownId);
        const mediaPath = join(tempHome, "downloaded.jpg");
        fs.writeFileSync(mediaPath, "media-bytes");

        upsertContact({ userId: "member-1", displayName: "Member One", isFriend: 1 });
        upsertGroup({ groupId: "group-store", name: "Store Group", memberCount: 1 });
        upsertGroupParticipant("group-store", "member-1", { role: "admin" });
        upsertMessage({
            msgId: "store-media",
            threadId: "group-store",
            senderId: "member-1",
            senderName: "Member One",
            ts: 1000,
            text: "media",
            msgType: "image",
            localPath: mediaPath,
        });
        upsertMessage({
            msgId: "store-recalled",
            threadId: "group-store",
            senderId: "member-1",
            senderName: "Member One",
            ts: 2000,
            text: null,
            msgType: "text",
            recalled: 1,
        });
        upsertMessage({
            msgId: "store-status",
            threadId: "status@broadcast",
            senderId: "member-1",
            senderName: "Member One",
            ts: 3000,
            text: "status",
            msgType: "image",
            localPath: join(tempHome, "missing-status.jpg"),
        });

        const stats = getLocalStoreStats();

        assert.equal(stats.counts.chats, 1);
        assert.equal(stats.counts.contacts, 1);
        assert.equal(stats.counts.groups, 1);
        assert.equal(stats.counts.group_participants, 1);
        assert.equal(stats.counts.messages, 2);
        assert.equal(stats.counts.recalled_messages, 1);
        assert.equal(stats.counts.status_broadcasts, 1);
        assert.equal(stats.counts.media_linked_messages, 1);
        assert.equal(stats.downloaded_media.linked_paths, 2);
        assert.equal(stats.downloaded_media.files, 1);
        assert.equal(stats.downloaded_media.bytes, 11);
        assert.equal(stats.downloaded_media.missing_files, 1);
    });

    it("plans age cleanup as a dry run without deleting messages or status broadcasts", async () => {
        const ownId = "test_user_store_cleanup_dry_run";
        await initDatabase(ownId);
        const now = Date.UTC(2026, 0, 10);
        upsertMessage({
            msgId: "old-chat",
            threadId: "thread-age",
            senderId: "a",
            ts: now - 3 * 86400000,
            text: "old",
        });
        upsertMessage({ msgId: "new-chat", threadId: "thread-age", senderId: "a", ts: now, text: "new" });
        upsertMessage({
            msgId: "old-status",
            threadId: "status@broadcast",
            senderId: "a",
            ts: now - 3 * 86400000,
            text: "old status",
        });

        const result = cleanupLocalStore({ days: 1, dryRun: true, now });

        assert.equal(result.dry_run, true);
        assert.equal(result.planned.messages, 1);
        assert.equal(result.planned.status_broadcasts, 1);
        assert.equal(result.deleted.messages, 0);
        assert.equal(getLocalMessagesCount("thread-age"), 2);
        assert.equal(getLocalStatusBroadcasts({ query: "old status", limit: 10 }).length, 1);
    });

    it("requires confirmation for actual cleanup and prunes old local rows when confirmed", async () => {
        const ownId = "test_user_store_cleanup_confirm";
        await initDatabase(ownId);
        const now = Date.UTC(2026, 0, 10);
        upsertMessage({
            msgId: "old-confirm",
            threadId: "thread-confirm",
            senderId: "a",
            ts: now - 4 * 86400000,
            text: "old",
        });
        upsertMessage({ msgId: "new-confirm", threadId: "thread-confirm", senderId: "a", ts: now, text: "new" });
        upsertMessage({
            msgId: "old-confirm-status",
            threadId: "status@broadcast",
            senderId: "a",
            ts: now - 4 * 86400000,
            text: "old status confirm",
        });

        assert.throws(() => cleanupLocalStore({ days: 1, now }), /requires --confirm/);

        const result = cleanupLocalStore({ days: 1, confirm: true, now });

        assert.equal(result.deleted.messages, 1);
        assert.equal(result.deleted.status_broadcasts, 1);
        assert.equal(getLocalMessageById("old-confirm"), null);
        assert.equal(getLocalMessageById("new-confirm").msgId, "new-confirm");
        assert.equal(getLocalStatusBroadcasts({ query: "old status confirm", limit: 10 }).length, 0);
    });

    it("prunes a cached thread with cascade consistency", async () => {
        const ownId = "test_user_store_cleanup_thread";
        await initDatabase(ownId);
        upsertContact({ userId: "member-thread", displayName: "Thread Member" });
        upsertGroup({ groupId: "thread-delete", name: "Delete Thread", memberCount: 1 });
        upsertGroupParticipant("thread-delete", "member-thread", {});
        upsertMessage({
            msgId: "delete-1",
            threadId: "thread-delete",
            senderId: "member-thread",
            ts: 1000,
            text: "delete",
        });
        upsertMessage({ msgId: "keep-1", threadId: "thread-keep", senderId: "member-thread", ts: 1000, text: "keep" });

        const plan = planLocalStoreCleanup({ threadId: "thread-delete" });
        assert.equal(plan.planned.chats, 1);
        assert.equal(plan.planned.groups, 1);
        assert.equal(plan.planned.group_participants, 1);
        assert.equal(plan.planned.messages, 1);

        const result = cleanupLocalStore({ threadId: "thread-delete", confirm: true });

        assert.deepEqual(result.deleted, plan.planned);
        assert.equal(getLocalMessageById("delete-1"), null);
        assert.equal(getLocalMessageById("keep-1").msgId, "keep-1");
        assert.equal(
            getDb().prepare("SELECT count(*) AS count FROM group_participants WHERE group_id = ?").get("thread-delete")
                .count,
            0,
        );
        assert.equal(
            getDb().prepare("SELECT count(*) AS count FROM messages_fts WHERE msg_id = ?").get("delete-1").count,
            0,
        );
    });

    it("blocks cleanup when the database is opened read-only", async () => {
        const ownId = "test_user_store_cleanup_readonly";
        await initDatabase(ownId);
        upsertMessage({ msgId: "readonly-delete", threadId: "thread-readonly", senderId: "a", ts: 1000, text: "old" });
        closeDatabase();
        await initDatabase(ownId, { readonly: true });

        assert.throws(
            () => cleanupLocalStore({ days: 1, confirm: true, now: Date.UTC(2026, 0, 10) }),
            /read-only mode/,
        );
        assert.equal(getLocalMessagesCount("thread-readonly"), 1);
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
