import fs from "node:fs";
import { join } from "node:path";

export class AccountLock {
    constructor(accountDir) {
        this.lockPath = join(accountDir, "LOCK");
        this.lockFileHandle = null;
    }

    async acquire(timeoutMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                // 'wx' flag opens for writing and fails if file already exists
                this.lockFileHandle = fs.openSync(this.lockPath, "wx");
                // Write PID to lock file
                fs.writeSync(this.lockFileHandle, `pid=${process.pid}\nacquired_at=${new Date().toISOString()}`);
                return true;
            } catch (err) {
                if (err.code !== "EEXIST") throw err;
                // Check if process in lockfile is still alive
                try {
                    const content = fs.readFileSync(this.lockPath, "utf-8");
                    const pidMatch = content.match(/pid=(\d+)/);
                    if (pidMatch) {
                        const pid = parseInt(pidMatch[1], 10);
                        // Send 0 signal to check if process exists
                        process.kill(pid, 0);
                    }
                } catch (killErr) {
                    // process.kill throws ESRCH if pid doesn't exist; lock is stale
                    if (killErr.code === "ESRCH" || killErr.code === "EPERM") {
                        if (killErr.code === "ESRCH") {
                            try {
                                fs.unlinkSync(this.lockPath);
                            } catch {}
                            continue;
                        }
                    }
                }
                // Wait and retry
                await new Promise((r) => setTimeout(r, 200));
            }
        }
        throw new Error("Could not acquire account lock. Is another zalo-agent process running?");
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
