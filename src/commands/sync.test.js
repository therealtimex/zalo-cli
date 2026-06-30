import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isHttp404Error, summarizeGroupHistoryBackfill } from "./sync.js";

describe("sync group history backfill accounting", () => {
    it("fails when every group HTTP history attempt fails and no fallback messages sync", () => {
        const summary = summarizeGroupHistoryBackfill({
            groupCount: 5,
            httpAttempts: 3,
            httpErrors: 3,
            httpMessages: 0,
            wsMessages: 0,
            skippedAfter404: 2,
        });

        assert.equal(summary.synced, false);
        assert.equal(summary.partial, false);
        assert.equal(summary.history_backfill_reliable, false);
    });

    it("marks WebSocket fallback messages as partial instead of failed", () => {
        const summary = summarizeGroupHistoryBackfill({
            groupCount: 5,
            httpAttempts: 3,
            httpErrors: 3,
            httpMessages: 0,
            wsMessages: 4,
            skippedAfter404: 2,
        });

        assert.equal(summary.synced, true);
        assert.equal(summary.partial, true);
        assert.equal(summary.history_backfill_reliable, false);
    });

    it("keeps fully successful HTTP group history reliable", () => {
        const summary = summarizeGroupHistoryBackfill({
            groupCount: 5,
            httpAttempts: 5,
            httpErrors: 0,
            httpMessages: 25,
            wsMessages: 0,
            skippedAfter404: 0,
        });

        assert.equal(summary.synced, true);
        assert.equal(summary.partial, false);
        assert.equal(summary.history_backfill_reliable, true);
    });

    it("detects 404 history errors from common error shapes", () => {
        assert.equal(isHttp404Error({ status: 404 }), true);
        assert.equal(isHttp404Error({ response: { status: 404 } }), true);
        assert.equal(isHttp404Error(new Error("HTTP 404 fetching group history")), true);
        assert.equal(isHttp404Error({ status: 500, message: "server error" }), false);
    });
});
