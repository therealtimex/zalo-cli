import { EventEmitter } from "node:events";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = join(tmpdir(), `zalo-history-backfill-${process.pid}-${Date.now()}`);
process.env.ZALO_CONFIG_DIR = configDir;

const {
    closeDatabase,
    getLocalHistoryCoverage,
    getLocalMessagesCount,
    initDatabase,
    upsertChat,
    upsertMessage,
} = await import("../core/db.js");
const { buildHistoryBackfillPlan, runHistoryBackfill } = await import("./history-backfill.js");

async function setupDb() {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.mkdirSync(configDir, { recursive: true });
    await initDatabase("history_user");
    return configDir;
}

function seedThread() {
    upsertChat({ threadId: "thread_history", type: 1, name: "History Thread", lastMessageTs: 3000 });
    upsertMessage({
        msgId: "old-local",
        threadId: "thread_history",
        senderId: "friend",
        senderName: "Friend",
        ts: 1000,
        text: "oldest local",
        msgType: "text",
        contentJson: JSON.stringify({ actionId: "cursor-old-local" }),
    });
    upsertMessage({
        msgId: "new-local",
        threadId: "thread_history",
        senderId: "friend",
        senderName: "Friend",
        ts: 3000,
        text: "newest local",
        msgType: "text",
    });
}

function makeApi(pages) {
    const listener = new EventEmitter();
    let requestCount = 0;
    listener.start = () => {
        queueMicrotask(() => listener.emit("connected"));
    };
    listener.stop = () => {};
    listener.requestOldMessages = (_threadType, cursor) => {
        const page = pages[requestCount++] || [];
        queueMicrotask(() => {
            listener.emit(
                "old_messages",
                page.map((message) => ({
                    threadId: message.threadId ?? "thread_history",
                    isSelf: !!message.isSelf,
                    data: {
                        msgId: message.msgId,
                        actionId: message.actionId,
                        uidFrom: message.senderId ?? "friend",
                        dName: message.senderName ?? "Friend",
                        ts: message.ts,
                        content: message.text,
                        msgType: "text",
                    },
                    cursor,
                })),
            );
        });
    };
    return { listener };
}

afterEach(() => {
    closeDatabase();
    fs.rmSync(configDir, { recursive: true, force: true });
});

describe("history coverage and explicit backfill workflow", () => {
    it("reports local coverage with oldest timestamp, newest timestamp, type, and usable anchor", async () => {
        const configDir = await setupDb();
        try {
            seedThread();
            const coverage = getLocalHistoryCoverage({ threadId: "thread_history" });

            assert.equal(coverage.local_only, true);
            assert.equal(coverage.count, 1);
            assert.equal(coverage.threads[0].threadType, "group");
            assert.equal(coverage.threads[0].messageCount, 2);
            assert.equal(coverage.threads[0].oldestTimestamp, 1000);
            assert.equal(coverage.threads[0].newestTimestamp, 3000);
            assert.equal(coverage.threads[0].anchor.msgId, "old-local");
            assert.equal(coverage.threads[0].anchor.actionId, "cursor-old-local");
            assert.equal(coverage.threads[0].anchor.cursor, "cursor-old-local");
            assert.equal(coverage.threads[0].anchor.usable, true);
        } finally {
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });

    it("builds a local-only dry-run plan and reports no-history without connecting", async () => {
        const configDir = await setupDb();
        try {
            seedThread();
            const plan = buildHistoryBackfillPlan({
                threadId: "thread_history",
                type: "group",
                count: "10",
                requests: "2",
                timeout: "500",
                delay: "25",
                dryRun: true,
            });

            assert.equal(plan.status, "planned");
            assert.equal(plan.dry_run, true);
            assert.equal(plan.canBackfill, true);
            assert.equal(plan.bounds.count, 10);
            assert.equal(plan.bounds.requests, 2);
            assert.equal(plan.bounds.timeout, 500);
            assert.equal(plan.bounds.delay, 25);
            assert.equal(plan.plannedRequests, 2);

            const missing = buildHistoryBackfillPlan({ threadId: "missing", dryRun: true });
            assert.equal(missing.status, "no_history");
            assert.equal(missing.canBackfill, false);
            assert.equal(missing.plannedRequests, 0);
        } finally {
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });

    it("uses the oldest local anchor and accounts for bounded fake WebSocket backfill", async () => {
        const configDir = await setupDb();
        try {
            seedThread();
            const events = [];
            const result = await runHistoryBackfill({
                api: makeApi([
                    [
                        { msgId: "remote-old-1", actionId: "cursor-remote-1", ts: 500, text: "remote older 1" },
                        { msgId: "other-thread", threadId: "other", actionId: "cursor-other", ts: 400, text: "ignore me" },
                    ],
                    [{ msgId: "remote-old-2", actionId: "cursor-remote-2", ts: 250, text: "remote older 2" }],
                ]),
                options: { threadId: "thread_history", type: "group", count: 2, requests: 2, timeout: 500, delay: 0 },
                emitEvent: (event) => events.push(event),
            });

            assert.equal(result.status, "backfilled");
            assert.equal(result.requestsAttempted, 2);
            assert.equal(result.messagesSeen, 3);
            assert.equal(result.messagesMatched, 2);
            assert.equal(result.messagesStored, 2);
            assert.equal(getLocalMessagesCount("thread_history"), 4);
            assert.deepEqual(
                events.map((event) => event.event),
                ["planned", "request", "page", "request", "page", "complete"],
            );
            assert.equal(events[1].cursor, "cursor-old-local");
        } finally {
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });

    it("reports timeout partial state without storing messages", async () => {
        const configDir = await setupDb();
        try {
            seedThread();
            const listener = new EventEmitter();
            listener.start = () => queueMicrotask(() => listener.emit("connected"));
            listener.stop = () => {};
            listener.requestOldMessages = () => {};

            const result = await runHistoryBackfill({
                api: { listener },
                options: { threadId: "thread_history", type: "group", requests: 1, timeout: 5 },
            });

            assert.equal(result.status, "timeout");
            assert.equal(result.partial, true);
            assert.equal(result.messagesStored, 0);
            assert.equal(getLocalMessagesCount("thread_history"), 2);
        } finally {
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });
});
