/**
 * Doctor command — inspect local Zalo CLI auth, store, search, and lock state.
 */

import fs from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CONFIG_DIR, loadCredentials } from "../core/credentials.js";
import { getActive } from "../core/accounts.js";
import { AccountLock } from "../core/lock.js";
import { loginWithCredentials, clearSession } from "../core/zalo-client.js";
import { output, success, error, info, warning } from "../utils/output.js";

const TABLES = ["chats", "contacts", "groups", "group_participants", "messages"];
const FTS_OBJECTS = ["messages_fts", "trg_messages_ai", "trg_messages_ad", "trg_messages_au"];

function isoFromMs(ms) {
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function statIso(path) {
    try {
        return fs.statSync(path).mtime.toISOString();
    } catch {
        return null;
    }
}

function parseLock(content) {
    const parsed = {};
    for (const line of content.split(/\r?\n/)) {
        const [key, ...rest] = line.split("=");
        if (!key || rest.length === 0) continue;
        parsed[key.trim()] = rest.join("=").trim();
    }
    return parsed;
}

function inspectLock(lockPath) {
    if (!fs.existsSync(lockPath)) {
        return {
            present: false,
            path: lockPath,
            pid: null,
            acquired_at: null,
            alive: null,
            stale: false,
        };
    }

    let content = "";
    try {
        content = fs.readFileSync(lockPath, "utf8");
    } catch (e) {
        return {
            present: true,
            path: lockPath,
            pid: null,
            acquired_at: null,
            alive: null,
            stale: false,
            error: e.message,
        };
    }

    const parsed = parseLock(content);
    const pid = parsed.pid ? Number.parseInt(parsed.pid, 10) : null;
    let alive = null;
    let stale = false;
    if (pid) {
        try {
            process.kill(pid, 0);
            alive = true;
        } catch (e) {
            alive = e.code === "EPERM";
            stale = e.code === "ESRCH";
        }
    }

    return {
        present: true,
        path: lockPath,
        pid,
        acquired_at: parsed.acquired_at || null,
        alive,
        stale,
    };
}

function tableExists(db, name) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

function countRows(db, table) {
    if (!tableExists(db, table)) return 0;
    return db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
}

function inspectDatabase(dbPath) {
    if (!fs.existsSync(dbPath)) {
        return {
            exists: false,
            path: dbPath,
            readable: false,
            counts: Object.fromEntries(TABLES.map((table) => [table, 0])),
            last_sync_at: null,
            error: null,
        };
    }

    let db;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        db.pragma("query_only = ON");
        const counts = Object.fromEntries(TABLES.map((table) => [table, countRows(db, table)]));
        const lastSyncMs = tableExists(db, "messages")
            ? db.prepare("SELECT max(ts) AS ts FROM messages").get().ts
            : null;
        return {
            exists: true,
            path: dbPath,
            readable: true,
            counts,
            last_sync_at: isoFromMs(Number(lastSyncMs)),
            error: null,
        };
    } catch (e) {
        return {
            exists: true,
            path: dbPath,
            readable: false,
            counts: Object.fromEntries(TABLES.map((table) => [table, 0])),
            last_sync_at: null,
            error: e.message,
        };
    } finally {
        try {
            db?.close();
        } catch {}
    }
}

function inspectSearch(dbPath, storeReadable) {
    if (!storeReadable) {
        return {
            enabled: false,
            fts_table: false,
            triggers: { insert: false, update: false, delete: false },
            indexed_messages: 0,
            error: null,
        };
    }

    let db;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const names = new Set(
            db
                .prepare(`SELECT name FROM sqlite_master WHERE name IN (${FTS_OBJECTS.map(() => "?").join(",")})`)
                .all(...FTS_OBJECTS)
                .map((row) => row.name),
        );
        const ftsTable = names.has("messages_fts");
        return {
            enabled:
                ftsTable &&
                names.has("trg_messages_ai") &&
                names.has("trg_messages_ad") &&
                names.has("trg_messages_au"),
            fts_table: ftsTable,
            triggers: {
                insert: names.has("trg_messages_ai"),
                update: names.has("trg_messages_au"),
                delete: names.has("trg_messages_ad"),
            },
            indexed_messages: ftsTable ? db.prepare("SELECT count(*) AS count FROM messages_fts").get().count : 0,
            error: null,
        };
    } catch (e) {
        return {
            enabled: false,
            fts_table: false,
            triggers: { insert: false, update: false, delete: false },
            indexed_messages: 0,
            error: e.message,
        };
    } finally {
        try {
            db?.close();
        } catch {}
    }
}

export function inspectLocalDoctorState() {
    const active = getActive();
    const ownId = active?.ownId || null;
    const accountDir = ownId ? join(CONFIG_DIR, "accounts", ownId) : null;
    const dbPath = accountDir ? join(accountDir, "zalo.db") : null;
    const heartbeatPath = accountDir ? join(accountDir, "HEARTBEAT") : null;
    const lockPath = accountDir ? join(accountDir, "LOCK") : null;
    const creds = ownId ? loadCredentials(ownId) : null;
    const store = dbPath
        ? inspectDatabase(dbPath)
        : {
              exists: false,
              path: null,
              readable: false,
              counts: Object.fromEntries(TABLES.map((table) => [table, 0])),
              last_sync_at: null,
              error: null,
          };

    return {
        ok: !!active && !!creds && store.readable,
        config_dir: CONFIG_DIR,
        auth: {
            active: !!active,
            own_id: ownId,
            name: active?.name || null,
            proxy_configured: !!active?.proxy,
            credentials_present: !!creds,
        },
        store: {
            ...store,
            last_activity_at: heartbeatPath ? statIso(heartbeatPath) : null,
            heartbeat_path: heartbeatPath,
        },
        search: inspectSearch(dbPath, store.readable),
        lock: lockPath
            ? inspectLock(lockPath)
            : { present: false, path: null, pid: null, acquired_at: null, alive: null, stale: false },
        connect: {
            requested: false,
            attempted: false,
            ok: null,
            error: null,
        },
    };
}

export async function runDoctor({ connect = false, lockWait = 5000 } = {}) {
    const state = inspectLocalDoctorState();
    state.connect.requested = !!connect;

    if (!connect) return state;

    if (!state.auth.active) {
        state.connect.error = "No active account. Run: zalo-agent account login";
        state.ok = false;
        return state;
    }
    if (!state.auth.credentials_present) {
        state.connect.error = `No credentials for ${state.auth.own_id}. Re-login needed.`;
        state.ok = false;
        return state;
    }

    const accountDir = join(CONFIG_DIR, "accounts", state.auth.own_id);
    const accountLock = new AccountLock(accountDir);
    try {
        await accountLock.acquire(lockWait);
    } catch (e) {
        state.connect.error = e.message;
        state.ok = false;
        return state;
    }

    try {
        state.connect.attempted = true;
        const creds = loadCredentials(state.auth.own_id);
        const result = await loginWithCredentials(creds, getActive()?.proxy || null, { readonly: true });
        state.connect.ok = true;
        state.connect.own_id = result.ownId || null;
    } catch (e) {
        state.connect.ok = false;
        state.connect.error = e.message;
        state.ok = false;
    } finally {
        clearSession();
        accountLock.release();
    }

    return state;
}

function renderHuman(state) {
    if (state.ok) success("Local Zalo CLI state looks usable");
    else warning("Zalo CLI state has issues");

    info(`Config: ${state.config_dir}`);
    info(`Auth: ${state.auth.active ? state.auth.own_id : "no active account"}`);
    if (state.auth.active) {
        info(`Credentials: ${state.auth.credentials_present ? "present" : "missing"}`);
        info(`Name: ${state.auth.name || "?"}`);
    }

    info(`Store: ${state.store.exists ? state.store.path : "missing"}`);
    if (state.store.error) warning(`Store error: ${state.store.error}`);
    info(
        `Counts: chats=${state.store.counts.chats}, contacts=${state.store.counts.contacts}, groups=${state.store.counts.groups}, messages=${state.store.counts.messages}`,
    );
    info(`Last sync: ${state.store.last_sync_at || "unknown"}`);
    info(`Last activity: ${state.store.last_activity_at || "unknown"}`);
    info(
        `Search: ${state.search.enabled ? "enabled" : "incomplete"} (${state.search.indexed_messages} indexed messages)`,
    );
    info(`Lock: ${state.lock.present ? `present pid=${state.lock.pid || "?"}` : "not present"}`);

    if (state.connect.requested) {
        if (state.connect.ok) success("Live connectivity check succeeded");
        else error(`Live connectivity check failed: ${state.connect.error || "unknown error"}`);
    }
}

export function registerDoctorCommand(program) {
    program
        .command("doctor")
        .description("Inspect local auth, SQLite store, search index, lock, and optional live connectivity")
        .option("--connect", "Attempt live Zalo connectivity after auth and lock checks")
        .option("--json", "Output doctor report as JSON")
        .action(async (opts) => {
            const jsonMode = !!(opts.json || program.opts().json);
            if (jsonMode) process.env.ZALO_JSON_MODE = "1";
            const state = await runDoctor({
                connect: opts.connect,
                lockWait: Number.parseInt(program.opts().lockWait, 10),
            });
            output(state, jsonMode, renderHuman);
            if (opts.connect && !state.connect.ok) process.exit(1);
        });
}
