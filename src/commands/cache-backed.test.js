import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = join(tmpdir(), "zalo-agent-cli-test-cache-backed");
process.env.ZALO_CONFIG_DIR = tempHome;

const { initDatabase, closeDatabase, getLocalChats, getLocalFriends } = await import("../core/db.js");
const { cacheConversationFriends, cacheConversationGroup } = await import("./conv.js");
const { cacheFriendProfiles } = await import("./friend.js");

describe("cache-backed command helpers", () => {
    beforeEach(async () => {
        fs.rmSync(tempHome, { recursive: true, force: true });
        await initDatabase("cache_owner");
    });

    afterEach(() => {
        closeDatabase();
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    it("upserts fresh friend list results and reads friend list from SQLite", () => {
        cacheFriendProfiles({
            changed_profiles: {
                friend_1: {
                    userId: "friend_1",
                    phoneNumber: "84900000001",
                    displayName: "Cached Friend",
                    zaloName: "cached_zalo",
                    avatar: "https://example.test/avatar.jpg",
                    lastActionTime: 1710000000,
                },
            },
        });

        const friends = getLocalFriends();
        assert.equal(friends.length, 1);
        assert.equal(friends[0].userId, "friend_1");
        assert.equal(friends[0].displayName, "Cached Friend");
        assert.equal(friends[0].lastActionTime, 1710000000);
    });

    it("upserts recent conversation friends and groups for DB-first reads", () => {
        cacheConversationFriends([
            {
                userId: "friend_recent",
                displayName: "Recent Friend",
                lastActionTime: 1710000100,
            },
        ]);
        cacheConversationGroup("group_recent", {
            name: "Recent Group",
            creatorId: "owner_1",
            createdTime: "1700000000000",
            totalMember: 3,
        });

        const chats = getLocalChats({ limit: 10 });
        assert.deepEqual(
            chats.map((chat) => ({ threadId: chat.threadId, type: chat.type, name: chat.name })),
            [
                { threadId: "friend_recent", type: "User", name: "Recent Friend" },
                { threadId: "group_recent", type: "Group", name: "Recent Group" },
            ],
        );
    });
});
