import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = join(tmpdir(), "zalo-agent-cli-test-listen");
process.env.ZALO_CONFIG_DIR = tempHome;

const { initDatabase, closeDatabase, getDb, upsertMessage } = await import("../core/db.js");
const {
    persistListenMessageEvent,
    persistListenFriendEvent,
    persistListenGroupEvent,
    persistListenUndoEvent,
} = await import("./listen.js");

describe("listen passive SQLite sync", () => {
    beforeEach(async () => {
        fs.rmSync(tempHome, { recursive: true, force: true });
        await initDatabase("listen_owner");
    });

    afterEach(() => {
        closeDatabase();
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    it("persists incoming message events into messages, chats, and contacts", () => {
        const persisted = persistListenMessageEvent({
            threadId: "thread_dm_1",
            type: 0,
            isSelf: false,
            data: {
                msgId: "msg_1",
                uidFrom: "friend_1",
                dName: "Alice",
                ts: "1710000000123",
                content: "hello from listener",
            },
        });

        assert.equal(persisted, true);

        const db = getDb();
        const message = db.prepare("SELECT * FROM messages WHERE msg_id = ?").get("msg_1");
        assert.equal(message.thread_id, "thread_dm_1");
        assert.equal(message.sender_id, "friend_1");
        assert.equal(message.sender_name, "Alice");
        assert.equal(message.ts, 1710000000123);
        assert.equal(message.text, "hello from listener");
        assert.equal(message.msg_type, "text");

        const chat = db.prepare("SELECT thread_id, type, last_message_ts FROM chats WHERE thread_id = ?").get("thread_dm_1");
        assert.deepEqual(chat, { thread_id: "thread_dm_1", type: 0, last_message_ts: 1710000000123 });

        const contact = db.prepare("SELECT user_id, display_name FROM contacts WHERE user_id = ?").get("friend_1");
        assert.deepEqual(contact, { user_id: "friend_1", display_name: "Alice" });
    });

    it("persists friend events into contacts", () => {
        const persisted = persistListenFriendEvent(
            {
                type: 0,
                threadId: "friend_2",
                data: {
                    fromUid: "friend_2",
                    displayName: "Bob",
                },
            },
            1710000000999,
        );

        assert.equal(persisted, true);

        const contact = getDb()
            .prepare("SELECT user_id, display_name, is_friend, last_active FROM contacts WHERE user_id = ?")
            .get("friend_2");
        assert.deepEqual(contact, {
            user_id: "friend_2",
            display_name: "Bob",
            is_friend: 1,
            last_active: 1710000000999,
        });
    });

    it("persists group metadata and participants from group events", () => {
        const persisted = persistListenGroupEvent(
            {
                type: "updated",
                threadId: "group_1",
                data: {
                    name: "Project Group",
                    ownerId: "owner_1",
                    creatorId: "creator_1",
                    createdTs: 1700000000000,
                    members: [
                        { uid: "member_1", displayName: "Member One", role: "admin", joinedAt: 1700000001000 },
                        { userId: "member_2", name: "Member Two" },
                    ],
                },
            },
            1710000001000,
        );

        assert.equal(persisted, true);

        const db = getDb();
        const group = db
            .prepare("SELECT group_id, name, owner_id, creator_id, created_ts, member_count FROM groups WHERE group_id = ?")
            .get("group_1");
        assert.deepEqual(group, {
            group_id: "group_1",
            name: "Project Group",
            owner_id: "owner_1",
            creator_id: "creator_1",
            created_ts: 1700000000000,
            member_count: 2,
        });

        const participants = db
            .prepare("SELECT group_id, user_id, role, joined_at FROM group_participants ORDER BY user_id")
            .all();
        assert.deepEqual(participants, [
            { group_id: "group_1", user_id: "member_1", role: "admin", joined_at: 1700000001000 },
            { group_id: "group_1", user_id: "member_2", role: "member", joined_at: null },
        ]);
    });

    it("removes group participants for removal events", () => {
        persistListenGroupEvent({
            type: "joined",
            threadId: "group_2",
            data: {
                members: [{ uid: "member_remove", displayName: "Remove Me" }],
            },
        });

        persistListenGroupEvent({
            type: "removed",
            threadId: "group_2",
            data: {
                userId: "member_remove",
            },
        });

        const participant = getDb()
            .prepare("SELECT 1 FROM group_participants WHERE group_id = ? AND user_id = ?")
            .get("group_2", "member_remove");
        assert.equal(participant, undefined);
    });

    it("marks messages recalled from undo events", () => {
        upsertMessage({
            msgId: "msg_recalled",
            threadId: "thread_recalled",
            ts: 1710000002000,
            text: "will be recalled",
        });

        assert.equal(persistListenUndoEvent({ data: { msgId: "msg_recalled" } }), true);

        const row = getDb().prepare("SELECT recalled FROM messages WHERE msg_id = ?").get("msg_recalled");
        assert.equal(row.recalled, 1);
    });
});
