import fs from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AccountLock } from "./lock.js";
import { CONFIG_DIR } from "./credentials.js";

let _db = null;
let _lock = null;
let _readonly = false;

export function getDb() {
    return _db;
}

export function isReadonly() {
    return _readonly;
}

export async function initDatabase(ownId, options = {}) {
    if (!ownId) return;
    if (_db) return; // Already initialized

    const accountDir = join(CONFIG_DIR, "accounts", ownId);
    fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(accountDir, 0o700);
    } catch {}

    const dbPath = join(accountDir, "zalo.db");
    const readonly = !!options.readonly;
    _readonly = readonly;

    if (!readonly) {
        // Acquire lock
        const lockWait = parseInt(options.lockWait, 10) || 5000;
        _lock = new AccountLock(accountDir);
        await _lock.acquire(lockWait);

        // Ensure database file exists with correct permissions before better-sqlite3 opens it
        if (!fs.existsSync(dbPath)) {
            fs.writeFileSync(dbPath, "", { mode: 0o600 });
        }
        try {
            fs.chmodSync(dbPath, 0o600);
        } catch {}
    }

    _db = new Database(dbPath, { readonly });

    // Optimizations
    if (!readonly) {
        _db.pragma("journal_mode = WAL");
        _db.pragma("synchronous = NORMAL");
    }
    _db.pragma("temp_store = MEMORY");
    _db.pragma("foreign_keys = ON");

    if (!readonly) {
        // Run migration/schema creation
        runMigrations(_db);
    }

    // Register release/close on exit
    process.on("exit", () => {
        closeDatabase();
    });
}

export function closeDatabase() {
    if (_db) {
        try {
            _db.close();
        } catch {}
        _db = null;
    }
    if (_lock) {
        try {
            _lock.release();
        } catch {}
        _lock = null;
    }
}

function runMigrations(db) {
    db.exec(`
        -- 1. Chats / Threads (cached channels for DM or Groups)
        CREATE TABLE IF NOT EXISTS chats (
            thread_id TEXT PRIMARY KEY,
            type INTEGER NOT NULL,          -- 0 = User (DM), 1 = Group
            name TEXT,
            last_message_ts INTEGER,        -- Unix timestamp in ms
            unread_count INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            muted_until INTEGER NOT NULL DEFAULT 0, -- Unix timestamp in ms
            updated_at INTEGER NOT NULL
        );

        -- 2. Contacts / Friends (Zalo users)
        CREATE TABLE IF NOT EXISTS contacts (
            user_id TEXT PRIMARY KEY,
            phone_number TEXT,
            display_name TEXT,
            zalo_name TEXT,
            avatar_url TEXT,
            is_friend INTEGER NOT NULL DEFAULT 0,
            last_active INTEGER,            -- Unix timestamp in ms
            updated_at INTEGER NOT NULL
        );

        -- 3. Groups
        CREATE TABLE IF NOT EXISTS groups (
            group_id TEXT PRIMARY KEY,
            name TEXT,
            owner_id TEXT,
            creator_id TEXT,
            created_ts INTEGER,             -- Unix timestamp in ms
            member_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (group_id) REFERENCES chats(thread_id) ON DELETE CASCADE
        );

        -- 4. Group Participants
        CREATE TABLE IF NOT EXISTS group_participants (
            group_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            role TEXT,                      -- owner | admin | member
            joined_at INTEGER,
            PRIMARY KEY (group_id, user_id),
            FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES contacts(user_id) ON DELETE CASCADE
        );

        -- 5. Messages
        CREATE TABLE IF NOT EXISTS messages (
            msg_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            sender_id TEXT,
            sender_name TEXT,
            ts INTEGER NOT NULL,            -- Unix timestamp in ms
            from_me INTEGER NOT NULL DEFAULT 0,
            text TEXT,
            msg_type TEXT,                  -- text | image | file | voice | sticker | link | video | etc.
            content_json TEXT,              -- Full raw API object JSON for future compatibility
            local_path TEXT,                -- Path to downloaded attachment (if any)
            recalled INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (thread_id) REFERENCES chats(thread_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages(thread_id, ts);
        CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

        -- 6. Status broadcasts are kept out of regular chat history.
        CREATE TABLE IF NOT EXISTS status_broadcasts (
            msg_id TEXT PRIMARY KEY,
            thread_id TEXT,
            sender_id TEXT,
            sender_name TEXT,
            ts INTEGER NOT NULL,
            from_me INTEGER NOT NULL DEFAULT 0,
            text TEXT,
            msg_type TEXT,
            content_json TEXT,
            local_path TEXT,
            recalled INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_status_broadcasts_sender_ts ON status_broadcasts(sender_id, ts);
        CREATE INDEX IF NOT EXISTS idx_status_broadcasts_ts ON status_broadcasts(ts);
    `);

    try {
        db.exec(`
        -- 6. Full-Text Search (FTS5) for fast offline message search
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            msg_id UNINDEXED,
            thread_id UNINDEXED,
            sender_name,
            text,
            content = 'messages',
            content_rowid = 'rowid'
        );

        -- Triggers to automatically sync messages with messages_fts
        CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, msg_id, thread_id, sender_name, text)
            VALUES (new.rowid, new.msg_id, new.thread_id, new.sender_name, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, msg_id, thread_id, sender_name, text)
            VALUES ('delete', old.rowid, old.msg_id, old.thread_id, old.sender_name, old.text);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, msg_id, thread_id, sender_name, text)
            VALUES ('delete', old.rowid, old.msg_id, old.thread_id, old.sender_name, old.text);
            INSERT INTO messages_fts(rowid, msg_id, thread_id, sender_name, text)
            VALUES (new.rowid, new.msg_id, new.thread_id, new.sender_name, new.text);
        END;
    `);
    } catch {
        // FTS5 is optional. Search falls back to LIKE when unavailable.
    }
}

export function isStatusBroadcastMessage(msg = {}) {
    const values = [
        msg.threadId,
        msg.thread_id,
        msg.statusThreadId,
        msg.data?.threadId,
        msg.data?.idTo,
        msg.data?.statusId,
        msg.content?.idTo,
    ]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => String(value).toLowerCase());

    return (
        msg.isStatus === true ||
        msg.isStatusBroadcast === true ||
        values.some((value) => value === "status@broadcast" || value.includes("status_broadcast")) ||
        msg.data?.isStatus === true ||
        msg.data?.isStatusBroadcast === true
    );
}

export function upsertChat(chat) {
    const db = getDb();
    if (!db) return;
    const stmt = db.prepare(`
        INSERT INTO chats (thread_id, type, name, last_message_ts, unread_count, pinned, archived, muted_until, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
            type = COALESCE(excluded.type, chats.type),
            name = COALESCE(excluded.name, chats.name),
            last_message_ts = COALESCE(excluded.last_message_ts, chats.last_message_ts),
            unread_count = COALESCE(excluded.unread_count, chats.unread_count),
            pinned = COALESCE(excluded.pinned, chats.pinned),
            archived = COALESCE(excluded.archived, chats.archived),
            muted_until = COALESCE(excluded.muted_until, chats.muted_until),
            updated_at = excluded.updated_at
    `);
    stmt.run(
        chat.threadId,
        chat.type ?? 0,
        chat.name ?? null,
        chat.lastMessageTs ?? null,
        chat.unreadCount ?? 0,
        chat.pinned ?? 0,
        chat.archived ?? 0,
        chat.mutedUntil ?? 0,
        Date.now(),
    );
}

export function upsertContact(contact) {
    const db = getDb();
    if (!db) return;
    const stmt = db.prepare(`
        INSERT INTO contacts (user_id, phone_number, display_name, zalo_name, avatar_url, is_friend, last_active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
            display_name = COALESCE(excluded.display_name, contacts.display_name),
            zalo_name = COALESCE(excluded.zalo_name, contacts.zalo_name),
            avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url),
            is_friend = COALESCE(excluded.is_friend, contacts.is_friend),
            last_active = COALESCE(excluded.last_active, contacts.last_active),
            updated_at = excluded.updated_at
    `);
    stmt.run(
        contact.userId,
        contact.phoneNumber ?? null,
        contact.displayName ?? null,
        contact.zaloName ?? null,
        contact.avatarUrl ?? null,
        contact.isFriend ?? 0,
        contact.lastActive ?? null,
        Date.now(),
    );
}

export function upsertGroup(group) {
    const db = getDb();
    if (!db) return;
    // ensure parent chat entry exists
    upsertChat({
        threadId: group.groupId,
        type: 1, // Group
        name: group.name,
        updatedAt: Date.now(),
    });
    const stmt = db.prepare(`
        INSERT INTO groups (group_id, name, owner_id, creator_id, created_ts, member_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET
            name = COALESCE(excluded.name, groups.name),
            owner_id = COALESCE(excluded.owner_id, groups.owner_id),
            creator_id = COALESCE(excluded.creator_id, groups.creator_id),
            created_ts = COALESCE(excluded.created_ts, groups.created_ts),
            member_count = COALESCE(excluded.member_count, groups.member_count),
            updated_at = excluded.updated_at
    `);
    stmt.run(
        group.groupId,
        group.name ?? null,
        group.ownerId ?? null,
        group.creatorId ?? null,
        group.createdTs ?? null,
        group.memberCount ?? 0,
        Date.now(),
    );
}

export function upsertGroupParticipant(groupId, userId, participant = {}) {
    const db = getDb();
    if (!db) return;
    // ensure contact exists
    const contactExists = db.prepare("SELECT 1 FROM contacts WHERE user_id = ?").get(userId);
    if (!contactExists) {
        upsertContact({
            userId: userId,
            displayName: participant.displayName || participant.name || null,
        });
    }
    const stmt = db.prepare(`
        INSERT INTO group_participants (group_id, user_id, role, joined_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(group_id, user_id) DO UPDATE SET
            role = COALESCE(excluded.role, group_participants.role),
            joined_at = COALESCE(excluded.joined_at, group_participants.joined_at)
    `);
    stmt.run(groupId, userId, participant.role ?? "member", participant.joinedAt ?? null);
}

export function upsertMessage(msg) {
    const db = getDb();
    if (!db) return;

    if (isStatusBroadcastMessage(msg)) {
        upsertStatusBroadcast(msg);
        return;
    }

    // Ensure parent chat exists
    const threadId = msg.threadId;
    const chatExists = db.prepare("SELECT 1 FROM chats WHERE thread_id = ?").get(threadId);
    if (!chatExists) {
        upsertChat({
            threadId,
            type: msg.type ?? 0, // default User/DM
            name: msg.senderName ?? null,
            lastMessageTs: msg.ts,
            updatedAt: Date.now(),
        });
    } else {
        // Update last message timestamp
        db.prepare("UPDATE chats SET last_message_ts = ?, updated_at = ? WHERE thread_id = ?").run(
            msg.ts,
            Date.now(),
            threadId,
        );
    }

    // Ensure sender contact exists
    if (msg.senderId) {
        const contactExists = db.prepare("SELECT 1 FROM contacts WHERE user_id = ?").get(msg.senderId);
        if (!contactExists) {
            upsertContact({
                userId: msg.senderId,
                displayName: msg.senderName,
            });
        }
    }

    const stmt = db.prepare(`
        INSERT INTO messages (msg_id, thread_id, sender_id, sender_name, ts, from_me, text, msg_type, content_json, local_path, recalled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(msg_id) DO UPDATE SET
            thread_id = COALESCE(excluded.thread_id, messages.thread_id),
            sender_id = COALESCE(excluded.sender_id, messages.sender_id),
            sender_name = COALESCE(excluded.sender_name, messages.sender_name),
            ts = COALESCE(excluded.ts, messages.ts),
            from_me = COALESCE(excluded.from_me, messages.from_me),
            text = COALESCE(excluded.text, messages.text),
            msg_type = COALESCE(excluded.msg_type, messages.msg_type),
            content_json = COALESCE(excluded.content_json, messages.content_json),
            local_path = COALESCE(excluded.local_path, messages.local_path),
            recalled = CASE WHEN messages.recalled = 1 THEN 1 ELSE excluded.recalled END
    `);
    stmt.run(
        msg.msgId,
        threadId,
        msg.senderId ?? null,
        msg.senderName ?? null,
        msg.ts,
        msg.fromMe ?? 0,
        msg.text ?? null,
        msg.msgType ?? "text",
        msg.contentJson ?? null,
        msg.localPath ?? null,
        msg.recalled ?? 0,
    );
}

export function upsertStatusBroadcast(msg) {
    const db = getDb();
    if (!db) return;

    const stmt = db.prepare(`
        INSERT INTO status_broadcasts (msg_id, thread_id, sender_id, sender_name, ts, from_me, text, msg_type, content_json, local_path, recalled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(msg_id) DO UPDATE SET
            thread_id = COALESCE(excluded.thread_id, status_broadcasts.thread_id),
            sender_id = COALESCE(excluded.sender_id, status_broadcasts.sender_id),
            sender_name = COALESCE(excluded.sender_name, status_broadcasts.sender_name),
            ts = COALESCE(excluded.ts, status_broadcasts.ts),
            from_me = COALESCE(excluded.from_me, status_broadcasts.from_me),
            text = COALESCE(excluded.text, status_broadcasts.text),
            msg_type = COALESCE(excluded.msg_type, status_broadcasts.msg_type),
            content_json = COALESCE(excluded.content_json, status_broadcasts.content_json),
            local_path = COALESCE(excluded.local_path, status_broadcasts.local_path),
            recalled = CASE WHEN status_broadcasts.recalled = 1 THEN 1 ELSE excluded.recalled END
    `);
    stmt.run(
        msg.msgId,
        msg.threadId ?? null,
        msg.senderId ?? null,
        msg.senderName ?? null,
        msg.ts,
        msg.fromMe ?? 0,
        msg.text ?? null,
        msg.msgType ?? "text",
        msg.contentJson ?? null,
        msg.localPath ?? null,
        msg.recalled ?? 0,
    );
}

export function updateMessageLocalPath(msgId, localPath) {
    const db = getDb();
    if (!db) return;
    db.prepare("UPDATE messages SET local_path = ? WHERE msg_id = ?").run(localPath, msgId);
}

export function getLocalChats(options = {}) {
    const db = getDb();
    if (!db) return [];

    let query =
        "SELECT c.thread_id, c.type, c.name, c.last_message_ts, g.member_count FROM chats c LEFT JOIN groups g ON c.thread_id = g.group_id";
    const params = [];

    if (options.friendsOnly) {
        query += " WHERE c.type = 0";
    } else if (options.groupsOnly) {
        query += " WHERE c.type = 1";
    }

    query += " ORDER BY c.last_message_ts DESC, c.updated_at DESC LIMIT ?";
    params.push(options.limit || 20);

    const rows = db.prepare(query).all(...params);
    return rows.map((row) => ({
        threadId: row.thread_id,
        name: row.name || "?",
        type: row.type === 1 ? "Group" : "User",
        typeFlag: row.type,
        lastActive: row.last_message_ts ? new Date(row.last_message_ts).toLocaleString() : "?",
        memberCount: row.member_count || 0,
    }));
}

export function getLocalFriends() {
    const db = getDb();
    if (!db) return [];
    const rows = db
        .prepare(
            "SELECT user_id, phone_number, display_name, zalo_name, avatar_url, last_active FROM contacts WHERE is_friend = 1",
        )
        .all();
    return rows.map((row) => ({
        userId: row.user_id,
        phoneNumber: row.phone_number,
        displayName: row.display_name,
        zaloName: row.zalo_name,
        avatar: row.avatar_url,
        lastActionTime: row.last_active ? Math.floor(row.last_active / 1000) : 0,
    }));
}

export function getLocalMessagesCount(threadId) {
    const db = getDb();
    if (!db) return 0;
    const row = db.prepare("SELECT count(*) as count FROM messages WHERE thread_id = ?").get(threadId);
    return row ? row.count : 0;
}

export function getLocalMessages(threadId, limit) {
    const db = getDb();
    if (!db) return [];
    const rows = db
        .prepare(
            "SELECT msg_id, thread_id, sender_id, sender_name, ts, text, msg_type FROM messages WHERE thread_id = ? ORDER BY ts DESC LIMIT ?",
        )
        .all(threadId, limit);
    return rows.map((row) => ({
        msgId: row.msg_id,
        threadId: row.thread_id,
        senderId: row.sender_id,
        senderName: row.sender_name,
        text: row.text,
        timestamp: Number(row.ts),
        type: row.msg_type,
    }));
}

function normalizeDirection(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    const normalized = String(value).toLowerCase();
    if (["outgoing", "sent", "self", "me", "from_me", "1", "true"].includes(normalized)) return 1;
    if (["incoming", "received", "inbound", "0", "false"].includes(normalized)) return 0;
    throw new Error("direction must be incoming, outgoing, or from_me");
}

function parseTimestamp(value, name) {
    if (value === undefined || value === null || value === "") return null;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    const text = String(value);
    if (/^\d+$/.test(text)) return Number(text);
    const parsed = Date.parse(text);
    if (Number.isNaN(parsed)) throw new Error(`${name} must be a millisecond timestamp or parseable date`);
    return parsed;
}

function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, "\\$&");
}

function parseContentJson(value) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function mapMessageRow(row, options = {}) {
    const message = {
        msgId: row.msg_id,
        threadId: row.thread_id,
        threadName: row.thread_name ?? null,
        senderId: row.sender_id,
        senderName: row.sender_name,
        text: row.text,
        timestamp: Number(row.ts),
        fromMe: row.from_me === 1,
        direction: row.from_me === 1 ? "outgoing" : "incoming",
        type: row.msg_type,
        localPath: row.local_path,
        recalled: row.recalled === 1,
    };
    if (options.includeContent) {
        message.content = parseContentJson(row.content_json);
        message.rawContentJson = row.content_json;
    }
    return message;
}

function addMessageFilters({ conditions, params, options, alias = "m" }) {
    const threadId = options.threadId ?? options.thread ?? options.chat;
    if (threadId) {
        conditions.push(`${alias}.thread_id = ?`);
        params.push(String(threadId));
    }

    if (options.senderId) {
        conditions.push(`${alias}.sender_id = ?`);
        params.push(String(options.senderId));
    }

    if (options.senderName) {
        conditions.push(`${alias}.sender_name = ?`);
        params.push(String(options.senderName));
    }

    if (options.sender) {
        conditions.push(`(${alias}.sender_id = ? OR ${alias}.sender_name LIKE ? ESCAPE '\\')`);
        params.push(String(options.sender), `%${escapeLike(options.sender)}%`);
    }

    const fromMe = options.fromMe ?? normalizeDirection(options.direction);
    if (fromMe !== undefined && fromMe !== null && fromMe !== "") {
        conditions.push(`${alias}.from_me = ?`);
        params.push(normalizeDirection(fromMe));
    }

    const startTs = parseTimestamp(options.startTs ?? options.after ?? options.since, "start time");
    if (startTs !== null) {
        conditions.push(`${alias}.ts >= ?`);
        params.push(startTs);
    }

    const endTs = parseTimestamp(options.endTs ?? options.before ?? options.until, "end time");
    if (endTs !== null) {
        conditions.push(`${alias}.ts <= ?`);
        params.push(endTs);
    }

    const type = options.msgType ?? options.mediaType ?? options.type;
    if (type) {
        conditions.push(`${alias}.msg_type = ?`);
        params.push(String(type));
    }

    if (options.media === true || options.media === "true") {
        conditions.push(`${alias}.msg_type != 'text'`);
    }

    if (options.hasMedia === true || options.hasMedia === "true") {
        conditions.push(`${alias}.local_path IS NOT NULL AND ${alias}.local_path != ''`);
    }
}

function hasFtsTable(db) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'").get();
}

function likeSearchWhere(query, alias = "m") {
    if (!query) return { sql: "", params: [] };
    const pattern = `%${escapeLike(query)}%`;
    return {
        sql: `(${alias}.text LIKE ? ESCAPE '\\' OR ${alias}.sender_name LIKE ? ESCAPE '\\' OR ${alias}.content_json LIKE ? ESCAPE '\\')`,
        params: [pattern, pattern, pattern],
    };
}

function buildFtsQuery(query) {
    const terms = String(query)
        .match(/[\p{L}\p{N}_]+/gu)
        ?.filter(Boolean);
    if (!terms || terms.length === 0) return null;
    return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" AND ");
}

function runMessageLikeSearch(db, options, ftsError = null) {
    const conditions = [];
    const params = [];
    const like = likeSearchWhere(options.query, "m");
    if (like.sql) {
        conditions.push(like.sql);
        params.push(...like.params);
    }
    addMessageFilters({ conditions, params, options, alias: "m" });
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Number(options.limit || 20);
    const rows = db
        .prepare(
            `
            SELECT m.msg_id, m.thread_id, m.sender_id, m.sender_name, m.ts, m.from_me, m.text, m.msg_type, m.local_path, m.recalled
            FROM messages m
            ${where}
            ORDER BY m.ts DESC
            LIMIT ?
        `,
        )
        .all(...params, limit);

    return {
        mode: "like",
        fallback: !!ftsError,
        ftsError: ftsError ? ftsError.message : null,
        messages: rows.map(mapMessageRow),
    };
}

export function searchLocalMessages(options = {}) {
    const db = getDb();
    if (!db) return { mode: "none", fallback: false, messages: [] };

    const query = String(options.query ?? options.text ?? options.q ?? "").trim();
    const normalizedOptions = { ...options, query };

    if (!query) {
        return runMessageLikeSearch(db, normalizedOptions);
    }

    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
        return runMessageLikeSearch(db, normalizedOptions);
    }

    try {
        if (!hasFtsTable(db)) throw new Error("messages_fts table is unavailable");
        const conditions = ["messages_fts MATCH ?"];
        const params = [ftsQuery];
        addMessageFilters({ conditions, params, options: normalizedOptions, alias: "m" });
        const where = `WHERE ${conditions.join(" AND ")}`;
        const limit = Number(normalizedOptions.limit || 20);
        const rows = db
            .prepare(
                `
                SELECT m.msg_id, m.thread_id, m.sender_id, m.sender_name, m.ts, m.from_me, m.text, m.msg_type, m.local_path, m.recalled
                FROM messages_fts f
                JOIN messages m ON m.rowid = f.rowid
                ${where}
                ORDER BY m.ts DESC
                LIMIT ?
            `,
            )
            .all(...params, limit);

        return {
            mode: "fts5",
            fallback: false,
            messages: rows.map(mapMessageRow),
        };
    } catch (ftsError) {
        return runMessageLikeSearch(db, normalizedOptions, ftsError);
    }
}

export function listLocalMessages(options = {}) {
    const db = getDb();
    if (!db) return [];

    const conditions = [];
    const params = [];
    addMessageFilters({ conditions, params, options, alias: "m" });
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = String(options.order || options.sort || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const limit = Number(options.limit || 20);
    const rows = db
        .prepare(
            `
            SELECT m.msg_id, m.thread_id, c.name AS thread_name, m.sender_id, m.sender_name, m.ts, m.from_me,
                   m.text, m.msg_type, m.local_path, m.recalled
            FROM messages m
            LEFT JOIN chats c ON c.thread_id = m.thread_id
            ${where}
            ORDER BY m.ts ${order}, m.msg_id ${order}
            LIMIT ?
        `,
        )
        .all(...params, limit);
    return rows.map((row) => mapMessageRow(row));
}

export function getLocalMessageById(msgId) {
    const db = getDb();
    if (!db) return null;
    const row = db
        .prepare(
            `
            SELECT m.msg_id, m.thread_id, c.name AS thread_name, m.sender_id, m.sender_name, m.ts, m.from_me,
                   m.text, m.msg_type, m.content_json, m.local_path, m.recalled
            FROM messages m
            LEFT JOIN chats c ON c.thread_id = m.thread_id
            WHERE m.msg_id = ?
        `,
        )
        .get(String(msgId));
    return row ? mapMessageRow(row, { includeContent: true }) : null;
}

export function getLocalMessageContext(msgId, options = {}) {
    const db = getDb();
    if (!db) return { target: null, before: [], after: [] };

    const targetRow = db
        .prepare(
            `
            SELECT m.msg_id, m.thread_id, c.name AS thread_name, m.sender_id, m.sender_name, m.ts, m.from_me,
                   m.text, m.msg_type, m.content_json, m.local_path, m.recalled
            FROM messages m
            LEFT JOIN chats c ON c.thread_id = m.thread_id
            WHERE m.msg_id = ?
        `,
        )
        .get(String(msgId));
    if (!targetRow) return { target: null, before: [], after: [] };

    const beforeLimit = Number(options.before ?? 3);
    const afterLimit = Number(options.after ?? 3);
    const target = mapMessageRow(targetRow, { includeContent: true });
    const select = `
        SELECT m.msg_id, m.thread_id, c.name AS thread_name, m.sender_id, m.sender_name, m.ts, m.from_me,
               m.text, m.msg_type, m.local_path, m.recalled
        FROM messages m
        LEFT JOIN chats c ON c.thread_id = m.thread_id
    `;
    const beforeRows = db
        .prepare(
            `
            ${select}
            WHERE m.thread_id = ? AND (m.ts < ? OR (m.ts = ? AND m.msg_id < ?))
            ORDER BY m.ts DESC, m.msg_id DESC
            LIMIT ?
        `,
        )
        .all(target.threadId, target.timestamp, target.timestamp, target.msgId, beforeLimit)
        .reverse();
    const afterRows = db
        .prepare(
            `
            ${select}
            WHERE m.thread_id = ? AND (m.ts > ? OR (m.ts = ? AND m.msg_id > ?))
            ORDER BY m.ts ASC, m.msg_id ASC
            LIMIT ?
        `,
        )
        .all(target.threadId, target.timestamp, target.timestamp, target.msgId, afterLimit);

    return {
        target,
        before: beforeRows.map((row) => mapMessageRow(row)),
        after: afterRows.map((row) => mapMessageRow(row)),
    };
}

export function getLocalStatusBroadcasts(options = {}) {
    const db = getDb();
    if (!db) return [];
    const conditions = [];
    const params = [];
    const like = likeSearchWhere(options.query ?? options.text ?? options.q, "s");
    if (like.sql) {
        conditions.push(like.sql);
        params.push(...like.params);
    }
    addMessageFilters({ conditions, params, options, alias: "s" });
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Number(options.limit || 20);
    const rows = db
        .prepare(
            `
            SELECT s.msg_id, s.thread_id, s.sender_id, s.sender_name, s.ts, s.from_me, s.text, s.msg_type, s.local_path, s.recalled
            FROM status_broadcasts s
            ${where}
            ORDER BY s.ts DESC
            LIMIT ?
        `,
        )
        .all(...params, limit);
    return rows.map(mapMessageRow);
}

export function getOldestMessageId(threadId) {
    const db = getDb();
    if (!db) return null;
    const row = db
        .prepare("SELECT msg_id, content_json FROM messages WHERE thread_id = ? ORDER BY ts ASC LIMIT 1")
        .get(threadId);
    if (!row) return null;
    if (row.content_json) {
        try {
            const content = JSON.parse(row.content_json);
            return content.actionId || row.msg_id;
        } catch {}
    }
    return row.msg_id;
}
