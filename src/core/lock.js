import fs from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 100;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLockInfo(content) {
    const entries = {};
    for (const line of content.split(/\r?\n/)) {
        const [key, ...valueParts] = line.split("=");
        if (!key || valueParts.length === 0) continue;
        entries[key.trim()] = valueParts.join("=").trim();
    }
    const pid = Number.parseInt(entries.pid, 10);
    return {
        pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
        acquiredAt: entries.acquired_at || null,
    };
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        if (err.code === "ESRCH") return false;
        if (err.code === "EPERM") return true;
        return true;
    }
}

function normalizeTimeout(timeoutMs) {
    const parsed = Number.parseInt(timeoutMs, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TIMEOUT_MS;
    return parsed;
}

export class AccountLock {
    constructor(accountDir, options = {}) {
        this.lockPath = join(accountDir, "LOCK");
        this.lockFileHandle = null;
        this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    }

    async acquire(timeoutMs = DEFAULT_TIMEOUT_MS) {
        const waitMs = normalizeTimeout(timeoutMs);
        const start = Date.now();

        while (true) {
            try {
                // 'wx' opens for writing and fails if another process already created the lock.
                this.lockFileHandle = fs.openSync(this.lockPath, "wx", 0o600);
                try {
                    fs.chmodSync(this.lockPath, 0o600);
                } catch {}
                try {
                    fs.writeSync(this.lockFileHandle, `pid=${process.pid}\nacquired_at=${new Date().toISOString()}`);
                } catch (writeErr) {
                    this.release();
                    throw writeErr;
                }
                return true;
            } catch (err) {
                if (err.code !== "EEXIST") throw err;
                if (this._removeStaleLock()) {
                    continue;
                }

                const elapsed = Date.now() - start;
                const remaining = waitMs - elapsed;
                if (remaining <= 0) break;

                await sleep(Math.min(this.pollMs, remaining));
            }
        }
        throw new Error(
            `Could not acquire account lock within ${waitMs}ms. Is another zalo-agent process running? (${this.lockPath})`,
        );
    }

    _removeStaleLock() {
        let content = "";
        try {
            content = fs.readFileSync(this.lockPath, "utf-8");
        } catch {
            return false;
        }

        const { pid } = parseLockInfo(content);
        if (!pid || pid === process.pid || isProcessAlive(pid)) return false;

        try {
            fs.unlinkSync(this.lockPath);
            return true;
        } catch {
            return false;
        }
    }

    release() {
        if (this.lockFileHandle !== null) {
            try {
                fs.closeSync(this.lockFileHandle);
            } catch {}
            try {
                fs.unlinkSync(this.lockPath);
            } catch {}
            this.lockFileHandle = null;
        }
    }
}
