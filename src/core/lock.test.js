import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountLock } from "./lock.js";

const tempRoot = join(tmpdir(), "zalo-agent-cli-test-lock");

function makeAccountDir(name) {
    const accountDir = join(tempRoot, name);
    fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
    return accountDir;
}

describe("AccountLock", () => {
    beforeEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it("acquires an owner-only per-account LOCK file with process metadata", async () => {
        const accountDir = makeAccountDir("acquire");
        const lock = new AccountLock(accountDir);

        assert.equal(await lock.acquire(100), true);

        const lockPath = join(accountDir, "LOCK");
        assert.equal(fs.existsSync(lockPath), true);
        assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);

        const content = fs.readFileSync(lockPath, "utf-8");
        assert.match(content, new RegExp(`pid=${process.pid}`));
        assert.match(content, /acquired_at=/);

        lock.release();
        assert.equal(fs.existsSync(lockPath), false);
    });

    it("prevents concurrent locks for the same account and honors timeout", async () => {
        const accountDir = makeAccountDir("contention");
        const lock1 = new AccountLock(accountDir);
        const lock2 = new AccountLock(accountDir, { pollMs: 5 });

        assert.equal(await lock1.acquire(100), true);

        const startedAt = Date.now();
        await assert.rejects(lock2.acquire(25), /Could not acquire account lock within 25ms/);
        assert.ok(Date.now() - startedAt >= 20, "lock acquisition should wait near the configured timeout");

        lock1.release();
    });

    it("allows a second lock after release", async () => {
        const accountDir = makeAccountDir("release");
        const lock1 = new AccountLock(accountDir);
        const lock2 = new AccountLock(accountDir);

        assert.equal(await lock1.acquire(100), true);
        lock1.release();

        assert.equal(await lock2.acquire(100), true);
        lock2.release();
    });

    it("removes a stale lock when the recorded process no longer exists", async () => {
        const accountDir = makeAccountDir("stale");
        const lockPath = join(accountDir, "LOCK");
        fs.writeFileSync(lockPath, "pid=99999999\nacquired_at=2000-01-01T00:00:00.000Z", { mode: 0o600 });

        const lock = new AccountLock(accountDir, { pollMs: 5 });
        assert.equal(await lock.acquire(100), true);

        const content = fs.readFileSync(lockPath, "utf-8");
        assert.match(content, new RegExp(`pid=${process.pid}`));

        lock.release();
    });

    it("supports zero timeout as a fail-fast contention check", async () => {
        const accountDir = makeAccountDir("zero-timeout");
        const lock1 = new AccountLock(accountDir);
        const lock2 = new AccountLock(accountDir);

        assert.equal(await lock1.acquire(100), true);
        await assert.rejects(lock2.acquire(0), /Could not acquire account lock within 0ms/);

        lock1.release();
    });
});
