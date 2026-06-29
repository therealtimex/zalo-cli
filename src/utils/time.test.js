import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTimestamp, timestampOrNow } from "./time.js";

describe("timestamp helpers", () => {
    it("normalizes seconds to milliseconds", () => {
        assert.equal(normalizeTimestamp(1710000000), 1710000000000);
        assert.equal(normalizeTimestamp("1710000000"), 1710000000000);
    });

    it("keeps millisecond timestamps unchanged", () => {
        assert.equal(normalizeTimestamp(1710000000000), 1710000000000);
        assert.equal(normalizeTimestamp("1710000000000"), 1710000000000);
    });

    it("normalizes oversized microsecond timestamps to milliseconds", () => {
        assert.equal(normalizeTimestamp(1710000000000000), 1710000000000);
    });

    it("returns null for missing or invalid timestamps", () => {
        assert.equal(normalizeTimestamp(null), null);
        assert.equal(normalizeTimestamp(undefined), null);
        assert.equal(normalizeTimestamp("not-a-number"), null);
    });

    it("falls back to Date.now when timestamp is invalid", () => {
        const before = Date.now();
        const value = timestampOrNow(null);
        const after = Date.now();
        assert.ok(value >= before);
        assert.ok(value <= after);
    });
});
