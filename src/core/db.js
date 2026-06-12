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
        Date.now()
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
        Date.now()
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
        updatedAt: Date.now()
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
        Date.now()
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
            displayName: participant.displayName || participant.name || null
        });
    }
    const stmt = db.prepare(`
        INSERT INTO group_participants (group_id, user_id, role, joined_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(group_id, user_id) DO UPDATE SET
            role = COALESCE(excluded.role, group_participants.role),
            joined_at = COALESCE(excluded.joined_at, group_participants.joined_at)
    `);
    stmt.run(
        groupId,
        userId,
        participant.role ?? 'member',
        participant.joinedAt ?? null
    );
}

export function upsertMessage(msg) {
    const db = getDb();
    if (!db) return;

    // Ensure parent chat exists
    const threadId = msg.threadId;
    const chatExists = db.prepare("SELECT 1 FROM chats WHERE thread_id = ?").get(threadId);
    if (!chatExists) {
        upsertChat({
            threadId,
            type: msg.type ?? 0, // default User/DM
            name: msg.senderName ?? null,
            lastMessageTs: msg.ts,
            updatedAt: Date.now()
        });
    } else {
        // Update last message timestamp
        db.prepare("UPDATE chats SET last_message_ts = ?, updated_at = ? WHERE thread_id = ?")
            .run(msg.ts, Date.now(), threadId);
    }

    // Ensure sender contact exists
    if (msg.senderId) {
        const contactExists = db.prepare("SELECT 1 FROM contacts WHERE user_id = ?").get(msg.senderId);
        if (!contactExists) {
            upsertContact({
                userId: msg.senderId,
                displayName: msg.senderName
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
        msg.msgType ?? 'text',
        msg.contentJson ?? null,
        msg.localPath ?? null,
        msg.recalled ?? 0
    );
}

export function getLocalChats(options = {}) {
    const db = getDb();
    if (!db) return [];
    
    let query = "SELECT c.thread_id, c.type, c.name, c.last_message_ts, g.member_count FROM chats c LEFT JOIN groups g ON c.thread_id = g.group_id";
    const params = [];
    
    if (options.friendsOnly) {
        query += " WHERE c.type = 0";
    } else if (options.groupsOnly) {
        query += " WHERE c.type = 1";
    }
    
    query += " ORDER BY c.last_message_ts DESC, c.updated_at DESC LIMIT ?";
    params.push(options.limit || 20);
    
    const rows = db.prepare(query).all(...params);
    return rows.map(row => ({
        threadId: row.thread_id,
        name: row.name || "?",
        type: row.type === 1 ? "Group" : "User",
        typeFlag: row.type,
        lastActive: row.last_message_ts ? new Date(row.last_message_ts).toLocaleString() : "?",
        memberCount: row.member_count || 0
    }));
}

export function getLocalFriends() {
    const db = getDb();
    if (!db) return [];
    const rows = db.prepare("SELECT user_id, phone_number, display_name, zalo_name, avatar_url, last_active FROM contacts WHERE is_friend = 1").all();
    return rows.map(row => ({
        userId: row.user_id,
        phoneNumber: row.phone_number,
        displayName: row.display_name,
        zaloName: row.zalo_name,
        avatar: row.avatar_url,
        lastActionTime: row.last_active ? Math.floor(row.last_active / 1000) : 0
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
    const rows = db.prepare("SELECT msg_id, thread_id, sender_id, sender_name, ts, text, msg_type FROM messages WHERE thread_id = ? ORDER BY ts DESC LIMIT ?").all(threadId, limit);
    return rows.map(row => ({
        msgId: row.msg_id,
        threadId: row.thread_id,
        senderId: row.sender_id,
        senderName: row.sender_name,
        text: row.text,
        timestamp: Number(row.ts),
        type: row.msg_type
    }));
}

export function getOldestMessageId(threadId) {
    const db = getDb();
    if (!db) return null;
    const row = db.prepare("SELECT msg_id, content_json FROM messages WHERE thread_id = ? ORDER BY ts ASC LIMIT 1").get(threadId);
    if (!row) return null;
    if (row.content_json) {
        try {
            const content = JSON.parse(row.content_json);
            return content.actionId || row.msg_id;
        } catch {}
    }
    return row.msg_id;
}

