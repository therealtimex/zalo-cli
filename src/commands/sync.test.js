import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = join(tmpdir(), "zalo-agent-cli-test-sync");
process.env.ZALO_CONFIG_DIR = tempHome;

const { initDatabase, closeDatabase, getLocalMessages } = await import("../core/db.js");
const { persistHistoryMessage, requestOldMessagesPage } = await import("./sync.js");

describe("sync history helpers", () => {
    beforeEach(async () => {
        fs.rmSync(tempHome, { recursive: true, force: true });
        await initDatabase("sync_owner");
    });

    afterEach(() => {
        closeDatabase();
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    it("persists WebSocket history messages into SQLite", () => {
        const stored = persistHistoryMessage({
            threadId: "group_1",
            isSelf: false,
            data: {
                msgId: "msg_1",
                uidFrom: "user_1",
                dName: "Sender",
                ts: 1710000000,
                content: "hello from sync",
            },
        });

        assert.equal(stored, true);
        const messages = getLocalMessages("group_1", 10);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].msgId, "msg_1");
        assert.equal(messages[0].text, "hello from sync");
        assert.equal(messages[0].timestamp, 1710000000000);
    });

    it("skips WebSocket history messages outside the allowed thread set", () => {
        const stored = persistHistoryMessage(
            {
                threadId: "group_2",
                isSelf: false,
                data: {
                    msgId: "msg_2",
                    uidFrom: "user_1",
                    dName: "Sender",
                    ts: 1710000000000,
                    content: "ignored",
                },
            },
            { allowedThreadIds: new Set(["group_1"]) },
        );

        assert.equal(stored, false);
        assert.equal(getLocalMessages("group_2", 10).length, 0);
    });

    it("waits for the matching old_messages thread type", async () => {
        const listener = new EventEmitter();
        listener.requestOldMessages = (threadType, lastMsgId) => {
            assert.equal(threadType, 1);
            assert.equal(lastMsgId, "cursor_1");
            setImmediate(() => {
                listener.emit("old_messages", [{ data: { msgId: "wrong" } }], 0);
                listener.emit("old_messages", [{ data: { msgId: "right" } }], 1);
            });
        };

        const messages = await requestOldMessagesPage({ listener }, 1, "cursor_1", 1000);
        assert.deepEqual(messages, [{ data: { msgId: "right" } }]);
    });
});
